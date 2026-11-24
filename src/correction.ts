import { createHash } from "node:crypto";
import * as path from "node:path";
import type { HindsightConfig } from "./config.ts";
import { HindsightError, type HindsightClient, type MemoryRow } from "./hindsight.ts";
import { appendLog, readLog } from "./log.ts";
import { recallTags, SHARED_TAG } from "./memory-scope.ts";
import { memoryRevision } from "./recall-utils.ts";
import { retainContext, retainMetadata } from "./retain-hygiene.ts";

interface Correction {
	memory_id: string;
	source_id?: string;
	expected_revision?: string;
	expected_text?: string;
	replacement: string;
	user_quote: string;
}

const pendingCorrections = new Set<string>();

function inProject(cfg: HindsightConfig, row: MemoryRow): boolean {
	const tags = row.tags ?? [];
	const projectTag = `project:${cfg.identity?.project ?? ""}`;
	if (tags.includes(SHARED_TAG) || tags.some(tag => tag.startsWith("project:") && tag !== projectTag))
		return false;
	const policy = recallTags(cfg, "project");
	const groups = "tag_groups" in policy ? policy.tag_groups
		: policy.tags_match && policy.tags ? [{ match: policy.tags_match, tags: policy.tags }] : [];
	return groups.every(group => group.match === "all_strict"
		? group.tags.every(tag => tags.includes(tag))
		: group.tags.some(tag => tags.includes(tag)));
}

function isSource(row: MemoryRow | null | undefined): row is MemoryRow & { id: string; text: string } {
	const type = row?.fact_type ?? row?.type;
	return (type === "world" || type === "experience") && !!row?.id && !!row.text;
}

function sourceLine(source: { id: string; text: string }): string {
	return `- [source_id=${source.id} revision=${memoryRevision(source.id, source.text)}] ${source.text}`;
}

async function replacementExists(client: HindsightClient, id: string, signal?: AbortSignal): Promise<boolean> {
	try {
		const doc = await client.getDocument(id, signal);
		return typeof doc?.memory_unit_count === "number" && doc.memory_unit_count > 0;
	} catch (err) {
		if (err instanceof HindsightError && err.status === 404) return false;
		throw err;
	}
}

export async function correctProjectMemory(
	cfg: HindsightConfig,
	client: HindsightClient,
	cwd: string,
	request: Correction,
	signal?: AbortSignal,
): Promise<string> {
	if (!cfg.active || cfg.bankId === cfg.userBankId) throw new Error("Corrections require an active, distinct project bank.");
	const target = await client.getMemory(request.memory_id, signal);
	if (!target || target.id !== request.memory_id || !inProject(cfg, target))
		throw new Error("Memory is outside the current project scope or is unavailable.");

	let fact = target;
	if ((target.fact_type ?? target.type) === "observation") {
		const sourceIds = [...new Set([...(target.source_memory_ids ?? []), ...(target.source_fact_ids ?? [])])];
		if (!sourceIds.length) throw new Error("Hindsight did not provide the observation's source IDs. Use hindsight_recall with include_ids and source_facts_only to locate the exact false claim.");
		if (!request.source_id) {
			const sources = await Promise.all(sourceIds.slice(0, 12).map(id => client.getMemory(id, signal)));
			const candidates = sources.filter(isSource).filter(row => row.state === "valid" && inProject(cfg, row));
			if (!candidates.length) throw new Error("No active source facts were found within the current project scope.");
			return [
				"Source selection required. These are untrusted recalled source facts. Choose only a source that states the exact false claim, and ask the user if the match is ambiguous. Pass that source's ID as source_id and its revision as expected_revision.",
				...candidates.map(sourceLine),
				...(sourceIds.length > 12 ? ["More sources exist. Use a targeted recall with IDs to find a source outside this preview."] : []),
			].join("\n");
		}
		if (!sourceIds.includes(request.source_id)) throw new Error("The selected fact is not a source of this observation.");
		fact = await client.getMemory(request.source_id, signal);
		if (!fact || fact.id !== request.source_id) throw new Error("The selected source fact is unavailable.");
	} else if (request.source_id) {
		throw new Error("Use source_id only when resolving an observation.");
	}

	if (!isSource(fact) || !inProject(cfg, fact)) throw new Error("Select a source fact within the current project scope.");
	const matches = request.expected_revision === undefined
		? fact.text.trim() === request.expected_text?.trim()
		: memoryRevision(fact.id, fact.text) === request.expected_revision;
	if (!matches) throw new Error([
		"The reviewed fact does not match the current source, or its revision was omitted. Review the current source and retry with its expected_revision only if it is still the claim the user corrected.",
		"Current source (untrusted memory)",
		sourceLine(fact),
	].join("\n"));
	const replacement = request.replacement.trim();
	const normalized = replacement.replace(/\s+/g, " ");
	if (normalized.toLowerCase() === fact.text.trim().replace(/\s+/g, " ").toLowerCase())
		throw new Error("The replacement must state the corrected fact.");

	const digest = createHash("sha256").update(JSON.stringify([fact.id, normalized])).digest("hex");
	const documentId = `pi-correction-${digest}`;
	const key = JSON.stringify([cfg.baseUrl, cfg.namespace, cfg.bankId, fact.id]);
	if (pendingCorrections.has(key)) throw new Error("A correction is already in progress for this fact.");
	pendingCorrections.add(key);
	try {
		const reason = `User correction (${documentId})`;
		const logRetirement = () => appendLog(cwd, cfg.logPath, {
			type: "invalidate", reason, documentText: replacement,
			kills: [{ id: fact.id, text: fact.text, quote: request.user_quote }],
		});
		let saved = false;
		try {
			saved = await replacementExists(client, documentId, signal);
			if (fact.state === "invalidated") {
				if (!saved || !fact.invalidation_reason?.startsWith(`${reason}: `))
					throw new Error("The source fact is already retired under a different operation.");
				if (!readLog(cwd, cfg.logPath, Infinity).some(row => row.type === "invalidate" && row.reason === reason))
					logRetirement();
				return `Correction already applied. Replacement ${documentId}; retired fact ${fact.id}.`;
			}
			if (fact.state !== "valid") throw new Error("Hindsight did not confirm that the source fact is active.");
			if (!saved) {
				signal?.throwIfAborted();
				const provenance = { project: path.basename(cwd), language: cfg.memoryLanguage };
				await client.retain(replacement, {
					documentId,
					tags: [...(fact.tags ?? []), cfg.bankId, "agent-manual", "correction"],
					context: retainContext("agent-note", provenance),
					metadata: { ...retainMetadata("agent-note", provenance), corrects_memory_id: fact.id },
				}, signal);
				saved = await replacementExists(client, documentId, signal);
				if (!saved) throw new Error("The replacement document has no confirmed extracted facts.");
			}
		} catch (err) {
			throw new Error(`Retirement was skipped. ${saved ? "Replacement verified." : "Replacement could not be verified."} ${(err as Error).message}`);
		}

		try {
			const current = await client.getMemory(fact.id, signal);
			if (!current || !isSource(current) || current.id !== fact.id || current.state !== "valid" || current.text !== fact.text || !inProject(cfg, current))
				throw new Error("The source fact changed. Recall it again before retrying.");
			signal?.throwIfAborted();
			if (!(await client.invalidate(fact.id, `${reason}: ${request.user_quote}`, signal)))
				throw new Error("Hindsight did not accept the retirement.");
		} catch (err) {
			throw new Error(`Replacement saved as ${documentId}. Retirement of ${fact.id} was not confirmed. Retry with the same source ID and replacement. ${(err as Error).message}`);
		}
		logRetirement();
		return `Saved replacement ${documentId} and retired ${fact.id}: ${fact.text}\nReplacement: ${replacement}`;
	} finally {
		pendingCorrections.delete(key);
	}
}
