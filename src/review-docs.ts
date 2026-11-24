/**
 * Data layer for the /mem Review tab.
 *
 * The review QUEUE (review-queue.ts) only tracks which documents still need a
 * look; the BANK is the source of truth for their text. This module joins the
 * two: it hydrates queue entries with the stored document, and applies the three
 * review actions (approve / delete / edit) against whatever bank coordinates the
 * queue recorded — entries can come from OTHER projects, so we never assume the
 * current session's client.
 *
 * Remote URLs must match the origin project's configured endpoint.
 * Legacy loopback URLs can still be used without a credential.
 */

import * as path from "node:path";
import { loadConfig, type HindsightConfig } from "./config.ts";
import { HindsightClient, HindsightError } from "./hindsight.ts";
import { bankScope, retainSnapshot, scopeMode, type RetainSnapshot } from "./memory-scope.ts";
import {
	type PendingDoc,
	loadPending,
	markDone,
	projectLanguage,
} from "./review-queue.ts";
import { retainContext, retainMetadata } from "./retain-hygiene.ts";

const DOC_ID_RE = /^[\w-]+$/;

/** A queue entry joined with the document text stored in the bank. */
export interface ReviewDoc {
	docId: string;
	bank: string;
	baseUrl: string;
	namespace: string;
	project: string;
	reason: string;
	ts: string;
	text: string;
	createdAt: string;
	factCount: number;
	/**
	 * Language of the bank this document belongs to — from the queue entry, which
	 * recorded it in the ORIGIN project. "" only for entries written before the
	 * field existed AND whose project no longer declares one.
	 */
	language: string;
	retainTags?: string[];
	retainSnapshot?: RetainSnapshot;
	documentTags?: string[];
	/** True when the bank could not be reached for this entry. */
	unreachable: boolean;
}

function httpBaseUrl(u: string): string | undefined {
	const url = URL.parse(u);
	if (url && (url.protocol === "http:" || url.protocol === "https:") &&
		!url.username && !url.password && !url.search && !url.hash)
		return url.href.replace(/\/+$/, "");
	return undefined;
}

function isLocalServer(baseUrl: string): boolean {
	const url = new URL(baseUrl);
	return url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname);
}

function sameLocalServer(left: string, right: string): boolean {
	const base = httpBaseUrl(right);
	if (!base || !isLocalServer(left) || !isLocalServer(base)) return false;
	const first = new URL(left);
	const second = new URL(base);
	return first.port === second.port && first.pathname === second.pathname;
}

function reviewConfig(doc: Pick<ReviewDoc, "docId" | "baseUrl" | "project" | "bank" | "namespace" | "retainSnapshot">) {
	const baseUrl = httpBaseUrl(doc.baseUrl);
	if (!baseUrl || !DOC_ID_RE.test(doc.docId)) return undefined;
	// Historical entries came from automatic project retention.
	const role = doc.retainSnapshot?.scope === "user-or-shared" ? "global" : "project";
	const config = loadConfig(doc.project, role === "project" ? doc.bank : undefined);
	const configuredEndpoint = baseUrl === httpBaseUrl(config.baseUrl);
	if (!configuredEndpoint && !isLocalServer(baseUrl)) return undefined;
	return {
		role,
		cfg: {
			...config,
			baseUrl,
			namespace: doc.namespace,
			apiKey: configuredEndpoint ? config.apiKey : undefined,
			userBankId: role === "global" ? doc.bank : config.userBankId,
		},
	} as const;
}

async function hydrate(p: PendingDoc): Promise<ReviewDoc | undefined> {
	const target = reviewConfig(p);
	// A malformed docId or bad baseUrl can never be actioned safely — drop it.
	// Stamped `auto` so the audit trail does not later read as a human decision.
	if (!target) {
		markDone(p.docId, "approved", "auto");
		return undefined;
	}
	const shell: ReviewDoc = {
		docId: p.docId,
		bank: p.bank,
		baseUrl: target.cfg.baseUrl,
		namespace: p.namespace,
		project: p.project,
		reason: p.reason,
		ts: p.ts,
		text: "",
		createdAt: "",
		factCount: 0,
		// Legacy entries carry no language: fall back to the origin project's own
		// config rather than to the reviewing session's.
		language: p.language || projectLanguage(p.project),
		retainTags: p.retainTags,
		retainSnapshot: p.retainSnapshot,
		unreachable: false,
	};
	let doc: Record<string, unknown>;
	try {
		doc = await new HindsightClient(target.cfg, target.role).getDocument(p.docId) ?? {};
	} catch (err) {
		if (err instanceof HindsightError && err.status === 404) {
			markDone(p.docId, "approved", "auto");
			return undefined;
		}
		return { ...shell, unreachable: true };
	}
	return {
		...shell,
		documentTags: Array.isArray(doc.tags) && doc.tags.every(tag => typeof tag === "string")
			? doc.tags : undefined,
		text: typeof doc.original_text === "string" ? doc.original_text : "",
		createdAt: typeof doc.created_at === "string" ? doc.created_at : "",
		factCount:
			typeof doc.memory_unit_count === "number" ? doc.memory_unit_count : 0,
	};
}

/** The current pending set, newest first, joined with bank document text. */
export async function loadReviewDocs(): Promise<ReviewDoc[]> {
	const settled = await Promise.allSettled(loadPending().map(hydrate));
	const out: ReviewDoc[] = [];
	for (const r of settled)
		if (r.status === "fulfilled" && r.value) out.push(r.value);
	return out.sort((a, b) => b.ts.localeCompare(a.ts));
}

/** Approve: leave the document in the bank, drop it from the queue. */
export function approveDoc(doc: ReviewDoc): void {
	markDone(doc.docId, "approved");
}

/** Delete the document (and its facts) from the bank, then drop it from the queue. */
export async function deleteDoc(doc: ReviewDoc): Promise<void> {
	const target = reviewConfig(doc);
	if (!target) throw new Error("Invalid review document coordinates");
	await new HindsightClient(target.cfg, target.role).deleteDocument(doc.docId, undefined, 10_000);
	markDone(doc.docId, "deleted");
}

/**
 * Re-retain the edited text under the SAME document_id → Hindsight upserts
 * (deletes the old document + its facts, then re-extracts). Stays in the queue
 * so the user can review the result of their edit and then approve it.
 *
 * `language` comes from the caller because a queue entry can belong to ANOTHER
 * project, whose bank may be kept in a different language than this session's.
 */
export async function editDoc(
	doc: ReviewDoc,
	text: string,
	language: string,
	reviewingConfig?: HindsightConfig,
): Promise<void> {
	const provenance = {
		project: path.basename(doc.project) || doc.bank,
		language,
	};
	const target = reviewConfig(doc);
	if (!target) throw new Error("Invalid review document coordinates");
	const { cfg, role } = target;
	if (reviewingConfig?.configError) throw new Error(reviewingConfig.configError);
	if (role === "project" && reviewingConfig?.userBankId === doc.bank &&
		reviewingConfig.namespace === doc.namespace &&
		(cfg.baseUrl === httpBaseUrl(reviewingConfig.baseUrl) ||
			sameLocalServer(cfg.baseUrl, reviewingConfig.baseUrl)) &&
		scopeMode(reviewingConfig, "global") === "user-or-shared")
		throw new Error("The reviewing checkout uses this project document's bank as its scoped global bank");
	const client = new HindsightClient(cfg, role);
	let snapshot = doc.retainSnapshot;
	if (!snapshot?.scope) {
		const provenanceTags = [doc.bank, role === "global" ? "user-manual" : "agent-summary"];
		const original = snapshot?.tags ?? doc.documentTags ??
			(doc.retainTags ? [...provenanceTags, ...doc.retainTags] : undefined);
		const scope = bankScope(cfg, role);
		if (original && scope && role === "project") {
			const projects = [...new Set(original.filter(tag => tag.startsWith("project:")))];
			if (projects.length > 1) throw new Error("Review document has conflicting project tags");
			snapshot = { tags: [...new Set([...original, projects[0] ?? scope.tags[0]!])], scope: "project" };
		} else if (original) {
			snapshot = { tags: [...new Set(original)], scope: scope ? "user-or-shared" : undefined };
		} else {
			snapshot = retainSnapshot(cfg, role, provenanceTags);
		}
	}
	await client.retainResolved(text, {
		documentId: doc.docId,
		context: retainContext("user-edit", provenance),
		metadata: retainMetadata("user-edit", provenance),
		async: true,
	}, snapshot, undefined, 10_000);
}
