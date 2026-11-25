/**
 * Thin REST client for the local Hindsight HTTP API.
 *
 * Endpoints (Hindsight HTTP API v0.8.x, prefix /v1/{namespace}):
 *   PUT  /banks/{bank}                    -> ensure/update bank
 *   GET  /banks                           -> list banks
 *   POST /banks/{bank}/memories           -> retain (store memory items)
 *   POST /banks/{bank}/memories/recall    -> recall (search)
 *   GET  /banks/{bank}/memories/list      -> list stored memories (no search)
 *   PATCH /banks/{bank}/memories/{id}     -> curate (edit / invalidate / restore)
 *   POST /banks/{bank}/reflect            -> reflect (synthesis)
 *
 * Administrative callers may supply a separate bearer token.
 */

import type { BankRole, Budget, HindsightConfig } from "./config.ts";
import { appendDebug } from "./log.ts";
import {
	flatListTags,
	MemoryScopeError,
	normalizeGlobalTags,
	recallTags,
	retainSnapshot,
	scopeMode,
	type RetainSnapshot,
} from "./memory-scope.ts";

export interface RetainOptions {
	context?: string;
	tags?: string[];
	metadata?: Record<string, string>;
	/** Process asynchronously on the server side. */
	async?: boolean;
	/**
	 * Stable document id for upsert semantics: when it matches an existing
	 * document the bank deletes that document and its facts, then re-extracts.
	 * Omitted → server assigns a random UUID (duplicates on re-ingest).
	 */
	documentId?: string;
}

export interface RecallOptions {
	maxTokens?: number;
	budget?: Budget;
	tags?: string[];
	types?: string[];
	/**
	 * Drop raw facts that a returned observation was consolidated from, so the
	 * same content is not returned twice (raw + observation). Provenance-based
	 * (exact source-id membership), not semantic. Hindsight >= v0.8.4; older
	 * servers ignore the unknown field. Defaults to true.
	 */
	preferObservations?: boolean;
}

/**
 * One row of `memories/list`, narrowed to the fields this client reads.
 *
 * `fact_type` is the server's own spelling (NOT `type`): a retained note is
 * stored twice — as the fact itself (`world`) and as a derived `observation`
 * consolidated from it.
 */
export interface MemoryRow {
	id?: string;
	text?: string;
	type?: string;
	fact_type?: string;
	state?: string;
	tags?: string[];
	metadata?: Record<string, unknown>;
	source_memory_ids?: string[] | null;
	source_fact_ids?: string[] | null;
	invalidation_reason?: string | null;
}

export interface InventoryRow {
	id: string;
	tags: string[];
	document_id?: string;
	fact_type?: string;
	state?: string;
	consolidation_state?: string;
	observation_scopes?: unknown;
	source_memory_ids?: string[];
	source_fact_ids?: string[];
}

/** Bank size counters shown in the status widget. */
export interface BankStats {
	/** Stored documents (total_documents). */
	documents: number;
	/** Extracted memory units / graph nodes (total_nodes). */
	facts: number;
}

export class HindsightError extends Error {
	constructor(
		message: string,
		readonly status?: number,
		readonly body?: string,
	) {
		super(message);
		this.name = "HindsightError";
	}
}

export class HindsightClient {
	private readonly bankId: string;
	private schema?: ApiSchema;
	private schemaRequest?: Promise<ApiSchema>;

	constructor(
		private readonly cfg: HindsightConfig,
		private readonly role: BankRole = "project",
		private readonly apiToken = cfg.apiKey,
	) {
		this.bankId = role === "global" ? cfg.userBankId : cfg.bankId;
	}

	private bankBase(): string {
		return `${this.cfg.baseUrl}/v1/${encodeURIComponent(this.cfg.namespace)}/banks/${encodeURIComponent(this.bankId)}`;
	}

	private async apiSchema(): Promise<ApiSchema> {
		if (this.schema) return this.schema;
		this.schemaRequest ??= this.request<ApiSchema>(
			"GET", `${this.cfg.baseUrl}/openapi.json`, undefined, undefined, 5000,
		).then(schema => {
			if (!schema?.paths) throw new Error("OpenAPI paths unavailable");
			this.schema = schema;
			return schema;
		}).finally(() => { this.schemaRequest = undefined; });
		return this.schemaRequest;
	}

	private async requireFields(
		action: string,
		suffix: string,
		method: "get" | "post" | "patch",
		fields: string[],
		item = false,
	): Promise<void> {
		try {
			const schema = await this.apiSchema();
			const route = (ns: string) => schema.paths[`/v1/${ns}/banks/{bank_id}${suffix}`];
			const operation = (route(this.cfg.namespace) ?? route("{namespace}") ?? route("default"))?.[method];
			const body = apiProperties(schema, operation?.requestBody?.content?.["application/json"]?.schema);
			const available = method === "get"
				? operation?.parameters?.map(param => param.name) ?? []
				: Object.keys(item ? apiProperties(schema, body.items?.items) : body);
			if (fields.every(field => available.includes(field))) return;
		} catch (err) {
			throw new MemoryScopeError(`${action} unavailable: could not verify Hindsight capabilities (${(err as Error).message})`);
		}
		throw new MemoryScopeError(`${action} unavailable: Hindsight does not advertise ${fields.join(", ")}`);
	}

	private async request<T>(
		method: string,
		url: string,
		body?: unknown,
		signal?: AbortSignal,
		timeoutMs = 15000,
	): Promise<T> {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), timeoutMs);
		// Keep the handler reference so we can detach it in finally: a long-lived
		// caller signal (hook/command) would otherwise accumulate one listener per
		// request until it eventually aborts.
		const onAbort = () => controller.abort();
		if (signal?.aborted) controller.abort();
		if (signal) signal.addEventListener("abort", onAbort, { once: true });
		try {
			appendDebug(process.cwd(), "http.start", {
				method,
				url,
				timeoutMs,
				body,
			});
			const res = await fetch(url, {
				method,
				headers: {
					...(body ? { "content-type": "application/json" } : {}),
					...(this.apiToken ? { authorization: `Bearer ${this.apiToken}` } : {}),
				},
				redirect: this.apiToken ? "error" : undefined,
				body: body === undefined ? undefined : JSON.stringify(body),
				signal: controller.signal,
			});
			const text = await res.text();
			appendDebug(process.cwd(), "http.done", {
				method,
				url,
				status: res.status,
				body: text,
			});
			if (!res.ok) {
				throw new HindsightError(
					`${method} ${url} -> ${res.status}`,
					res.status,
					text,
				);
			}
			return (text ? JSON.parse(text) : undefined) as T;
		} catch (err) {
			appendDebug(process.cwd(), "http.error", {
				method,
				url,
				error: (err as Error).message,
			});
			throw err;
		} finally {
			clearTimeout(timer);
			if (signal) signal.removeEventListener("abort", onAbort);
		}
	}

	/** GET /health (not bank-scoped). */
	async health(signal?: AbortSignal): Promise<unknown> {
		return this.request(
			"GET",
			`${this.cfg.baseUrl}/health`,
			undefined,
			signal,
			5000,
		);
	}

	/** GET /v1/{ns}/banks/{bank}/stats — document/fact counts for the widget. */
	async stats(signal?: AbortSignal): Promise<BankStats> {
		const s = (await this.request(
			"GET",
			`${this.bankBase()}/stats`,
			undefined,
			signal,
			5000,
		)) as { total_documents?: number; total_nodes?: number } | undefined;
		return {
			documents: Number(s?.total_documents ?? 0),
			facts: Number(s?.total_nodes ?? 0),
		};
	}

	/**
	 * GET /v1/{ns}/banks/{bank}/memories/list — the bank's stored rows.
	 *
	 * A plain listing on purpose: this is the read behind content that goes into
	 * the system prompt, and recall/reflect would put a model call on that path.
	 * That content must cost exactly one HTTP request and zero inference.
	 *
	 * The caller owns the timeout because callers differ in what a slow bank costs
	 * them; omitted, it falls back to the client-wide default.
	 */
	async listMemories(
		limit: number,
		signal?: AbortSignal,
		timeoutMs?: number,
	): Promise<MemoryRow[]> {
		const predicate = flatListTags(recallTags(this.cfg, this.role));
		const params = new URLSearchParams({ limit: String(limit) });
		if (predicate.tags_match) {
			await this.requireFields("Scoped memory listing", "/memories/list", "get", ["tags", "tags_match"]);
		}
		const res = await this.memoryList(params, predicate, signal, timeoutMs);
		return Array.isArray(res?.items) ? res.items : [];
	}

	/** Count active units under the configured recall policy. Unscoped banks use stats. */
	async countScopedMemories(signal?: AbortSignal): Promise<number | undefined> {
		const predicate = flatListTags(recallTags(this.cfg, this.role));
		if (!predicate.tags_match) return undefined;
		await this.requireFields("Scoped memory count", "/memories/list", "get", ["tags", "tags_match", "state"]);
		const params = new URLSearchParams({ limit: "1", state: "valid" });
		const res = await this.memoryList(params, predicate, signal, 5000);
		const total = res?.total;
		if (typeof total !== "number" || !Number.isSafeInteger(total) || total < 0 || res?.total_is_estimate)
			throw new MemoryScopeError("Hindsight did not provide an exact scoped memory count");
		return total;
	}

	private memoryList(
		params: URLSearchParams,
		predicate: ReturnType<typeof flatListTags>,
		signal?: AbortSignal,
		timeoutMs?: number,
	): Promise<{ items?: MemoryRow[]; total?: number; total_is_estimate?: boolean } | undefined> {
		for (const tag of predicate.tags ?? []) params.append("tags", tag);
		if (predicate.tags_match) params.set("tags_match", predicate.tags_match);
		return this.request(
			"GET",
			`${this.bankBase()}/memories/list?${params}`,
			undefined,
			signal,
			timeoutMs,
		);
	}

	/** Unfiltered administrative inventory, independent of prompt and recall policy. */
	async inventory(resource: "documents" | "memories/list"): Promise<InventoryRow[]> {
		const rows: InventoryRow[] = [];
		const ids = new Set<string>();
		const limit = 100;
		let total: number | undefined;
		do {
			const page = await this.request<{ items: InventoryRow[]; total: number }>(
				"GET", `${this.bankBase()}/${resource}?limit=${limit}&offset=${rows.length}`,
			);
			total ??= page.total;
			if (!Array.isArray(page.items) || !Number.isSafeInteger(total) ||
				page.total !== total || (!page.items.length && rows.length < total))
				throw new Error(`Incomplete ${resource} inventory; pause writers and retry`);
			for (const row of page.items) {
				if (!row.id || ids.has(row.id) || !Array.isArray(row.tags) ||
					row.tags.some(tag => typeof tag !== "string"))
					throw new Error(`Invalid or changing ${resource} inventory`);
				ids.add(row.id);
				rows.push(row);
			}
		} while (rows.length < total);
		if (rows.length !== total) throw new Error(`Changing ${resource} inventory`);
		return rows;
	}

	async inventoryDetail(resource: "documents" | "memories", id: string): Promise<InventoryRow> {
		return this.request("GET", `${this.bankBase()}/${resource}/${encodeURIComponent(id)}`);
	}

	async getMemory(id: string, signal?: AbortSignal): Promise<MemoryRow> {
		return this.request("GET", `${this.bankBase()}/memories/${encodeURIComponent(id)}`, undefined, signal);
	}

	async updateDocumentTags(
		id: string,
		update: { tags?: string[]; add_tags?: string[]; remove_tags?: string[]; observation_scopes?: "combined" },
	): Promise<void> {
		await this.requireFields("Document migration", "/documents/{document_id}", "patch", Object.keys(update));
		const result = await this.request<{ success?: boolean }>(
			"PATCH", `${this.bankBase()}/documents/${encodeURIComponent(id)}`, update,
		);
		if (!result?.success) throw new Error(`Document update failed for ${id}`);
	}

	/** GET /v1/{ns}/banks */
	async listBanks(signal?: AbortSignal): Promise<unknown> {
		return this.request(
			"GET",
			`${this.cfg.baseUrl}/v1/${this.cfg.namespace}/banks`,
			undefined,
			signal,
		);
	}

	/** PUT /v1/{ns}/banks/{bank} — idempotent ensure. */
	async ensureBank(name?: string, signal?: AbortSignal): Promise<unknown> {
		return this.request(
			"PUT",
			this.bankBase(),
			{ name: name ?? this.bankId },
			signal,
		);
	}

	/** GET /v1/{ns}/banks/{bank}/config — resolved config plus explicit overrides. */
	async getBankConfig(signal?: AbortSignal): Promise<unknown> {
		return this.request(
			"GET",
			`${this.bankBase()}/config`,
			undefined,
			signal,
			5000,
		);
	}

	/** PATCH /v1/{ns}/banks/{bank}/config — update only the provided keys. */
	async updateBankConfig(
		updates: Record<string, unknown>,
		signal?: AbortSignal,
	): Promise<unknown> {
		return this.request(
			"PATCH",
			`${this.bankBase()}/config`,
			{ updates },
			signal,
		);
	}

	/** POST /v1/{ns}/banks/{bank}/memories — store a single memory item. */
	async retain(
		content: string,
		opts: RetainOptions = {},
		signal?: AbortSignal,
	): Promise<unknown> {
		return this.retainResolved(content, opts, retainSnapshot(this.cfg, this.role, opts.tags), signal);
	}

	async retainResolved(
		content: string,
		opts: Omit<RetainOptions, "tags">,
		snapshot: RetainSnapshot,
		signal?: AbortSignal,
		timeoutMs = 30000,
	): Promise<unknown> {
		const configured = scopeMode(this.cfg, this.role);
		const scope = snapshot.scope;
		if ((configured && scope !== configured) ||
			(scope && (scope === "project") !== (this.role === "project")))
			throw new MemoryScopeError("Retain snapshot does not match the bank scope");
		const tags = scope === "user-or-shared" ? normalizeGlobalTags(snapshot.tags ?? []) : snapshot.tags;
		if (scope === "project" && tags?.filter(tag => tag.startsWith("project:")).length !== 1)
			throw new MemoryScopeError("Project retain snapshot requires exactly one project tag");
		if (scope)
			await this.requireFields("Scoped retention", "/memories", "post", ["tags", "observation_scopes"], true);
		const item = {
			content,
			context: opts.context,
			tags,
			observation_scopes: scope ? "combined" : undefined,
			metadata: opts.metadata,
			timestamp: new Date().toISOString(),
			document_id: opts.documentId,
		};
		return this.request(
			"POST",
			`${this.bankBase()}/memories`,
			{ items: [item], async: opts.async ?? false },
			signal,
			timeoutMs,
		);
	}

	/**
	 * DELETE /v1/{ns}/banks/{bank}/documents/{doc_id} — remove a document and
	 * its extracted memories. Tolerates 404 (already gone).
	 */
	async deleteDocument(docId: string, signal?: AbortSignal, timeoutMs?: number): Promise<void> {
		try {
			await this.request(
				"DELETE",
				`${this.bankBase()}/documents/${encodeURIComponent(docId)}`,
				undefined,
				signal,
				timeoutMs,
			);
		} catch (err) {
			if (err instanceof HindsightError && err.status === 404) return;
			throw err;
		}
	}

	/** Fetch the original document and its metadata for review. */
	async getDocument(docId: string, signal?: AbortSignal): Promise<Record<string, unknown> | undefined> {
		return this.request(
			"GET", `${this.bankBase()}/documents/${encodeURIComponent(docId)}`, undefined, signal, 5000,
		);
	}

	/**
	 * PATCH /v1/{ns}/banks/{bank}/memories/{id} — soft-retire ONE fact.
	 *
	 * Request shape verified against the live server (Hindsight 0.9.0,
	 * `UpdateMemoryRequest`): the body field is `reason`, NOT `invalidation_reason`
	 * — the latter is what the row reads back as in `memories/list`.
	 *
	 * An invalidated fact leaves recall, consolidation and the graph but stays in
	 * the bank for audit, and can be restored. Two rejections are expected and
	 * reported as false rather than failing the write that triggered them:
	 *   404 — the memory is already gone;
	 *   400 — the id is an OBSERVATION. Observations are derived and regenerate
	 *         from their sources, so the server refuses to curate them.
	 */
	async invalidate(
		id: string,
		reason: string,
		signal?: AbortSignal,
	): Promise<boolean> {
		try {
			await this.request(
				"PATCH",
				`${this.bankBase()}/memories/${encodeURIComponent(id)}`,
				{ state: "invalidated", reason },
				signal,
			);
			return true;
		} catch (err) {
			if (
				err instanceof HindsightError &&
				(err.status === 404 || err.status === 400)
			)
				return false;
			throw err;
		}
	}

	/**
	 * PATCH /v1/{ns}/banks/{bank}/memories/{id} — bring ONE retired fact back.
	 *
	 * The exact inverse of `invalidate`, verified against the live server (Hindsight
	 * 0.9.0, `UpdateMemoryRequest`): `state: "valid"` and nothing else. `reason`
	 * belongs to the kill and is deliberately not repeated here — it is the record of
	 * why the fact died, not of why it came back, and resending it would overwrite
	 * the audit trail the kill left behind.
	 *
	 * Return false for rows the bank cannot restore, so the caller can report
	 * the outcome without adding a successful restore to the log:
	 *   404 — the memory is gone for good (the document was deleted or reprocessed),
	 *         so there is nothing to bring back;
	 *   400 — the id is an OBSERVATION. Observations are derived and regenerate from
	 *         their sources, so the server refuses to curate them either way.
	 */
	async restore(id: string, signal?: AbortSignal): Promise<boolean> {
		try {
			await this.request(
				"PATCH",
				`${this.bankBase()}/memories/${encodeURIComponent(id)}`,
				{ state: "valid" },
				signal,
			);
			return true;
		} catch (err) {
			if (
				err instanceof HindsightError &&
				(err.status === 404 || err.status === 400)
			)
				return false;
			throw err;
		}
	}

	/**
	 * POST /v1/{ns}/banks/{bank}/reflect — Hindsight synthesized answer.
	 *
	 * Timed out at 30s, reflect had never once succeeded in production: measured
	 * across four banks it takes 28-59s, and the curve is flat in bank size (a
	 * 10-fact bank still answers in 28s) because it is an LLM-bound agent loop,
	 * not a retrieval problem. This ceiling is for the DELIBERATE `hindsight_reflect`
	 * tool call, where the agent chose to wait; automatic callers stay bounded by
	 * their own, much shorter, abort ceiling.
	 */
	async reflect(query: string, signal?: AbortSignal): Promise<unknown> {
		const predicate = recallTags(this.cfg, this.role);
		if ("tag_groups" in predicate || predicate.tags_match)
			throw new MemoryScopeError("Scoped synthesis is unavailable: Hindsight Reflect can include untagged directives and stored models with unverified sources");
		return this.request(
			"POST",
			`${this.bankBase()}/reflect`,
			{ query },
			signal,
			180000,
		);
	}

	/** POST /v1/{ns}/banks/{bank}/memories/recall — semantic search. */
	async recall(
		query: string,
		opts: RecallOptions = {},
		signal?: AbortSignal,
	): Promise<unknown> {
		const predicate = recallTags(this.cfg, this.role, opts.tags);
		const compound = "tag_groups" in predicate;
		if (compound)
			await this.requireFields("Scoped recall", "/memories/recall", "post", ["tag_groups"]);
		else if (predicate.tags_match)
			await this.requireFields("Scoped recall", "/memories/recall", "post", ["tags", "tags_match"]);
		try {
			return await this.request(
				"POST",
				`${this.bankBase()}/memories/recall`,
				{
					query,
					max_tokens: opts.maxTokens ?? this.cfg.recallMaxTokens,
					budget: opts.budget ?? this.cfg.recallBudget,
					...predicate,
					types: opts.types,
					prefer_observations: opts.preferObservations ?? true,
				},
				signal,
				30000,
			);
		} catch (err) {
			if ((compound || predicate.tags_match) && err instanceof HindsightError &&
				(err.status === 400 || err.status === 422))
				throw new MemoryScopeError(`Hindsight rejected scoped recall (HTTP ${err.status})`);
			throw err;
		}
	}

	/** GET /v1/{ns}/banks/{bank}/mental-models/{id} — a stored reflect answer. */
	async mentalModel(
		id: string,
		signal?: AbortSignal,
		timeoutMs?: number,
	): Promise<unknown> {
		const predicate = recallTags(this.cfg, this.role);
		if ("tag_groups" in predicate || predicate.tags_match)
			throw new MemoryScopeError("Scoped mental model unavailable: its stored content has no verified generation policy");
		return this.request(
			"GET",
			`${this.bankBase()}/mental-models/${encodeURIComponent(id)}`,
			undefined,
			signal,
			timeoutMs,
		);
	}
}

interface ApiField {
	$ref?: string;
	properties?: Record<string, ApiField>;
	items?: ApiField;
}

interface ApiOperation {
	parameters?: { name: string }[];
	requestBody?: { content?: Record<string, { schema?: ApiField }> };
}

interface ApiSchema {
	paths: Record<string, Partial<Record<"get" | "post" | "patch", ApiOperation>>>;
	components?: { schemas?: Record<string, ApiField> };
}

function apiProperties(api: ApiSchema, field: ApiField | undefined): Record<string, ApiField> {
	const prefix = "#/components/schemas/";
	if (field?.$ref?.startsWith(prefix))
		return api.components?.schemas?.[field.$ref.slice(prefix.length)]?.properties ?? {};
	return field?.properties ?? {};
}
