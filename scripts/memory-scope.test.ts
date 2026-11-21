import assert from "node:assert/strict";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { mock } from "bun:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { globalConfigPath, loadConfig, patchConfigFile, projectConfigPath } from "../src/config.ts";
import { HindsightClient, type InventoryRow } from "../src/hindsight.ts";
import { normalizeGlobalTags, recallTags, retainSnapshot } from "../src/memory-scope.ts";
import { QUERY_BUILDER, DEDUP_INVALIDATE, DEDUP_QUERIES } from "../src/prompts.ts";
import { editDoc, type ReviewDoc } from "../src/review-docs.ts";
import { HindsightStatus } from "../src/ui.ts";
import { bank, bankOf, BASE_URL, hostPrompt, makeCwd, MARKER, newHarness, THEME, wire } from "./user-block-harness.ts";
import { auditScope } from "./scope-migration.ts";

const post = (...fields: string[]) => ({
	requestBody: { content: { "application/json": { schema: {
		properties: Object.fromEntries(fields.map(field => [field, {}])),
	} } } },
});
const schema = {
	paths: {
		"/v1/default/banks/{bank_id}/memories/recall": { post: post("tags", "tags_match", "tag_groups") },
		"/v1/default/banks/{bank_id}/memories/list": { get: { parameters: [{ name: "tags" }, { name: "tags_match" }] } },
		"/v1/default/banks/{bank_id}/memories": { post: {
			requestBody: { content: { "application/json": { schema: { properties: {
				items: { items: { properties: { tags: {}, observation_scopes: {} } } },
			} } } } },
		} },
	},
};
bank.schema = schema;
process.env.HINDSIGHT_USER = "Amy";
process.env.HINDSIGHT_PROJECT = "my-app";
process.env.HINDSIGHT_AGENT = "pi";
writeFileSync(globalConfigPath(), JSON.stringify({
	retain_tags: ["legacy:{bankId}"],
	memory: {
		global: { recallScope: "user-or-shared", recallFilters: ["topic:engineering"] },
		project: { recallScope: "project", recallFilters: ["agent:{agent}", "type:preference"] },
	},
}));
const cwd = makeCwd("scope", { memory: { global: { retainTags: [], recallFilters: [] } } });
const cfg = loadConfig(cwd);
const projectPredicate = {
	tag_groups: [
		{ tags: ["project:my-app"], match: "all_strict" },
		{ tags: ["agent:pi", "type:preference"], match: "any_strict" },
	],
};
assert.deepEqual(recallTags(cfg, "project"), projectPredicate);
assert.deepEqual(recallTags(cfg, "global"), { tags: ["user:amy", "scope:shared"], tags_match: "any_strict" });
assert.deepEqual(retainSnapshot(cfg, "global"), { tags: ["scope:shared"], scope: "user-or-shared" });
assert.deepEqual(retainSnapshot({ ...cfg, memory: undefined }, "project", ["manual"]).tags, ["manual", "legacy:project-bank"]);
assert.deepEqual(retainSnapshot(cfg, "project").tags, ["user:amy", "project:my-app", "agent:pi", "legacy:project-bank"]);
assert.deepEqual(normalizeGlobalTags(["scope:shared", "user:bob", "topic:engineering"]), ["user:bob", "topic:engineering"]);
assert.deepEqual(normalizeGlobalTags(["topic:engineering"]), ["topic:engineering", "scope:shared"]);

const harness = newHarness({ cwd });
const recallCalls = () => wire.filter(call => call.url.endsWith("/memories/recall"));
const lastPost = () => wire.findLast(call => call.method === "POST" && call.url.endsWith("/memories"));
const lastItem = () => (lastPost()?.body?.items as Record<string, unknown>[] | undefined)?.[0];
const assertProjectRequest = () => {
	const call = recallCalls().at(-1);
	assert.match(call?.url ?? "", /\/banks\/project-bank\//);
	assert.deepEqual(call?.body?.tag_groups, projectPredicate.tag_groups);
	assert.equal(call?.body?.tags, undefined);
};

try {
	bank.user.items = bankOf(["standing fixture"]);
	await harness.start();
	const list = new URL(wire.find(call => call.url.includes("/user-bank/memories/list"))!.url);
	assert.deepEqual(list.searchParams.getAll("tags"), ["user:amy", "scope:shared"]);
	assert.equal(list.searchParams.get("tags_match"), "any_strict");
	assert.match((await harness.turn(hostPrompt(MARKER))).final, /standing fixture/);
	await harness.callTool("hindsight_recall", { query: "manual" });
	assertProjectRequest();
	await harness.command("mem-recall", "command");
	assertProjectRequest();
	assert.match(await harness.callTool("hindsight_reflect", { query: "reflect" }), /Scoped synthesis is unavailable/);
	assert.equal(wire.some(call => call.url.endsWith("/reflect")), false);

	await harness.callTool("hindsight_retain_user", { content: "the shared fixture", tags: ["topic:engineering"] });
	assert.deepEqual(lastItem()?.tags, ["user-bank", "user-manual", "fact", "topic:engineering", "scope:shared"]);
	assert.equal(lastItem()?.observation_scopes, "combined");
	await harness.callTool("hindsight_retain_user", { content: "the owned fixture", tags: ["scope:shared", "user:bob"] });
	assert.deepEqual(lastItem()?.tags, ["user-bank", "user-manual", "fact", "user:bob"]);
	await harness.callTool("hindsight_retain", { content: "the project fixture", tags: ["topic:engineering"] });
	assert.ok((lastItem()?.tags as string[]).includes("project:my-app"));

	process.env.HINDSIGHT_USER = "Bob";
	bank.user.mode = "error";
	await harness.compact();
	assert.doesNotMatch((await harness.turn(hostPrompt(MARKER))).final, /standing fixture/);
	assert.match(harness.notices().at(-1)?.message ?? "", /500/);
} finally {
	harness.done();
	bank.user.mode = "ok";
}

process.env.HINDSIGHT_USER = "Amy";
const reviewBase = "http://localhost:8888";
const badConfigCwd = makeCwd("broken-policy", {
	baseUrl: reviewBase,
	memory: { global: { recallScope: "user-or-shared" } },
});
const globalFile = globalConfigPath();
const originalGlobal = readFileSync(globalFile, "utf8");
writeFileSync(globalFile, JSON.stringify({ baseUrl: reviewBase, userBankId: "user-bank" }));
const originCwd = makeCwd("review-origin", { bankId: "review-origin-bank", userBankId: "" });
const reviewFixture: ReviewDoc = {
	docId: "original-note", bank: "user-bank", project: originCwd, namespace: "default",
	baseUrl: reviewBase, reason: "test", ts: "", text: "original", createdAt: "",
	factCount: 1, language: "en", unreachable: false,
	retainSnapshot: { tags: ["user:amy"] }, documentTags: ["user:bob"],
};
const harnessFetch = globalThis.fetch;
globalThis.fetch = ((url, opts) =>
	harnessFetch(String(url).replace(`${reviewBase}/`, `${BASE_URL}/`), opts)) as typeof fetch;
initTheme();
const badConfig = newHarness({ cwd: badConfigCwd });
const saveReview = async (doc: ReviewDoc): Promise<string> => {
	let rendered = "";
	await badConfig.command("mem", "", async factory => {
		const panel = factory({ requestRender() {} }, THEME, {}, () => {}) as {
			performEdit: (doc: ReviewDoc, text: string) => Promise<void>;
			render: (width: number) => string[];
		};
		await panel.performEdit(doc, "updated");
		rendered = panel.render(240).join("\n");
		return false;
	});
	return rendered;
};
try {
	await badConfig.start();
	assert.match((await badConfig.turn(hostPrompt(MARKER))).final, /standing fixture/);
	const file = projectConfigPath(badConfigCwd);
	const valid = readFileSync(file, "utf8");
	const callsBefore = wire.length;
	writeFileSync(file, "{");
	await badConfig.compact();
	assert.doesNotMatch((await badConfig.turn(hostPrompt(MARKER))).final, /standing fixture/);
	assert.match(badConfig.notices().at(-1)?.message ?? "", /Cannot load memory policy/);
	assert.match(await badConfig.callTool("hindsight_retain_user", { content: "must be blocked" }), /Cannot load memory policy/);
	assert.ok(!wire.slice(callsBefore).some(call => call.url.includes("/user-bank/memories")));
	await assert.rejects(new HindsightClient(loadConfig(badConfigCwd), "global").recall("startup"), /Cannot load memory policy/);

	writeFileSync(file, valid);
	await badConfig.compact();
	assert.match((await badConfig.turn(hostPrompt(MARKER))).final, /standing fixture/);
	assert.deepEqual(new URL(wire.findLast(call => call.url.includes("/user-bank/memories/list"))!.url).searchParams.getAll("tags"), ["user:amy", "scope:shared"]);

	const beforeMissing = wire.length;
	renameSync(file, `${file}.saved`);
	try {
		assert.match(await saveReview(reviewFixture), /save failed: Cannot load memory policy/);
		await badConfig.compact();
		await badConfig.compact();
		assert.doesNotMatch((await badConfig.turn(hostPrompt(MARKER))).final, /standing fixture/);
		assert.match(badConfig.notices().at(-1)?.message ?? "", /Restore the file or use \/reload/);
		assert.match(await badConfig.callTool("hindsight_retain_user", { content: "blocked while absent" }), /Cannot load memory policy/);
		assert.match(await saveReview(reviewFixture), /save failed: Cannot load memory policy/);
		assert.equal(reviewFixture.text, "original");
		assert.ok(!wire.slice(beforeMissing).some(call => call.url.includes("/user-bank/memories")));
	} finally {
		renameSync(`${file}.saved`, file);
	}
	const ordinaryReview = { ...reviewFixture, bank: "review-origin-bank" };
	assert.match(await saveReview(ordinaryReview), /save failed: Cannot load memory policy/);
	await badConfig.compact();
	assert.match((await badConfig.turn(hostPrompt(MARKER))).final, /standing fixture/);
	assert.match(await saveReview(reviewFixture), /reviewing checkout uses this project document's bank as its scoped global bank/);
	assert.match(await saveReview(ordinaryReview), /saved — the bank is re-extracting the facts/);
	assert.equal(ordinaryReview.text, "updated");
} finally {
	badConfig.done();
	globalThis.fetch = harnessFetch;
	writeFileSync(globalFile, originalGlobal);
}

process.env.HINDSIGHT_USER = "Amy";
const queryMarker = "<!-- hindsight:user query: engineering -->";
const queryCwd = makeCwd("query-scope", {}, queryMarker);
const queryHarness = newHarness({ cwd: queryCwd });
try {
	await queryHarness.start();
	assert.deepEqual(recallCalls().at(-1)?.body?.tag_groups, [
		{ tags: ["user:amy", "scope:shared"], match: "any_strict" },
		{ tags: ["topic:engineering"], match: "any_strict" },
	]);
	await assert.rejects(new HindsightClient(loadConfig(queryCwd), "global").listMemories(2), /query marker is required/);
	await assert.rejects(new HindsightClient(loadConfig(queryCwd), "global").mentalModel("existing"), /verified generation policy/);
} finally {
	queryHarness.done();
}

const before = recallCalls().length;
await assert.rejects(new HindsightClient({ ...cfg, identity: {} }, "global").recall("q"), /Missing memory identity/);
await assert.rejects(new HindsightClient({ ...cfg, userBankId: cfg.bankId }).recall("q"), /distinct/);
await assert.rejects(new HindsightClient({ ...cfg, memory: { project: { recallScope: "other" } } }).recall("q"), /Invalid/);
await assert.rejects(new HindsightClient({ ...cfg, memory: { project: { recallFilters: null } } }).recall("q"), /array/);
bank.schema = { paths: {} };
await assert.rejects(new HindsightClient(cfg).recall("q"), /does not advertise tag_groups/);
assert.equal(recallCalls().length, before);
bank.schema = schema;

const model = await import("../src/model.ts");
const evidence = "The old Ninja preset was removed from the repository today";
mock.module("../src/model.ts", () => ({
	...model,
	runModel: async (_ctx: unknown, _chain: unknown, prompt: string) => {
		if (prompt === QUERY_BUILDER) return JSON.stringify({ shouldQuery: true, op: "recall", queries: ["automatic project recall"] });
		if (prompt === DEDUP_QUERIES) return '["project duplicate lookup"]';
		if (prompt === DEDUP_INVALIDATE) return JSON.stringify({
			verdicts: [{ id: "obsolete", verdict: "contradicts", quote: evidence }],
		});
		return "- Build the new sample with CMake.";
	},
}));
const { runRecall } = await import("../src/recall.ts");
const { Memorizer } = await import("../src/memorize.ts");
const ctx = {
	cwd,
	sessionManager: { getEntries: () => [] },
	ui: { notify() {} },
} as unknown as Parameters<typeof runRecall>[0];
const chain = { label: "test", primary: { model: { contextWindow: 4096 } } } as Parameters<typeof runRecall>[3];
const client = new HindsightClient(cfg);
bank.user.items = [{ id: "obsolete", text: "The old Ninja preset is available", fact_type: "world", state: "valid" }];
const autoConfig = { ...cfg, recallFilter: "off" as const, factInvalidation: true };
await runRecall(ctx, autoConfig, client, chain, "ordinary");
assertProjectRequest();
await runRecall(ctx, autoConfig, client, chain, "deep", undefined, { query: "deep project recall" });
assertProjectRequest();
assert.ok(recallCalls().some(call => call.body?.query === "deep project recall"));
const memorizer = new Memorizer({ cfg: autoConfig, client, status: new HindsightStatus(), pi: {} as never });
const snapshot = await Reflect.get(memorizer, "runInline").call(memorizer, ctx, chain, [evidence], evidence, "memo-doc", "session");
assertProjectRequest();
assert.ok(recallCalls().some(call => call.body?.query === "project duplicate lookup"));
assert.ok(wire.some(call => call.method === "PATCH" && call.url.endsWith("/memories/obsolete")));
assert.deepEqual(snapshot.tags, lastItem()?.tags);

const edited: unknown[] = [];
const previousFetch = globalThis.fetch;
globalThis.fetch = (async (url: string, opts?: RequestInit) => {
	if (url.endsWith("/openapi.json")) return Response.json(schema);
	assert.match(url, /\/banks\/original-bank\/memories$/);
	const items = JSON.parse(String(opts?.body)).items;
	edited.push(items[0]);
	return Response.json({});
}) as typeof fetch;
try {
	assert.ok(patchConfigFile(cwd, { memory: { project: { recallScope: "project", retainTags: ["user:reviewer"] } } }));
	const review: ReviewDoc = {
		docId: "existing", bank: "original-bank", project: cwd, namespace: "default",
		baseUrl: "http://localhost:8888", reason: "test", ts: "", text: "", createdAt: "",
		factCount: 1, language: "en", unreachable: false,
		retainSnapshot: { tags: ["project:original", "user:owner"], scope: "project" },
	};
	await editDoc(review, "updated", "en");
	assert.deepEqual((edited[0] as Record<string, unknown>).tags, ["project:original", "user:owner"]);
	assert.equal((edited[0] as Record<string, unknown>).observation_scopes, "combined");
	assert.ok(patchConfigFile(cwd, { memory: { project: {} } }));
	writeFileSync(globalConfigPath(), "{}");
	await editDoc({ ...review, retainSnapshot: { tags: [] }, documentTags: ["ignore"] }, "updated", "en");
	assert.deepEqual((edited[1] as Record<string, unknown>).tags, []);
	const reviewingCwd = makeCwd("reviewing", {
		bankId: "new-project", userBankId: review.bank, baseUrl: "http://127.0.0.1:8888/",
		memory: { global: { recallScope: "user-or-shared" } },
	});
	const reviewingConfig = loadConfig(reviewingCwd);
	const reassigned = { ...review, retainSnapshot: { tags: ["user:amy"] }, documentTags: ["user:bob"] };
	await assert.rejects(editDoc(reassigned, "updated", "en", reviewingConfig), /reviewing checkout/);
	assert.equal(edited.length, 2);
	await editDoc(reassigned, "updated", "en", { ...reviewingConfig, namespace: "other" });
	assert.deepEqual((edited[2] as Record<string, unknown>).tags, ["user:amy"]);
	assert.ok(patchConfigFile(cwd, {
		bankId: "new-project", userBankId: review.bank,
		memory: { global: { recallScope: "user-or-shared" } },
	}));
	for (const saved of [undefined, { tags: [review.bank, "agent-summary"] }]) {
		await assert.rejects(editDoc({ ...review, retainSnapshot: saved }, "updated", "en"), /distinct project and global bank IDs/);
	}
	assert.equal(edited.length, 3);
} finally {
	globalThis.fetch = previousFetch;
}

const foreign: InventoryRow = { id: "foreign", tags: ["project:elsewhere"] };
const foreignUnit: InventoryRow = { id: "foreign-fact", document_id: foreign.id, tags: foreign.tags };
const foreignObservation: InventoryRow = {
	id: "foreign-observation", fact_type: "observation", tags: [], source_memory_ids: [foreignUnit.id],
};
const auditProject = (documents: InventoryRow[], units: InventoryRow[], approvedDocumentIds?: ReadonlySet<string>) =>
	auditScope({
		inventory: async (resource: string) => resource === "documents" ? documents : units,
		inventoryDetail: async () => { throw new Error("Unexpected update candidate"); },
	} as unknown as HindsightClient, { role: "project", projectTag: "project:my-app", approvedDocumentIds });
const foreignAudit = await auditProject([foreign], [foreignUnit, foreignObservation]);
assert.deepEqual(foreignAudit.foreignProjectDocuments, [foreign.id]);
assert.deepEqual(foreignAudit.changes, []);
assert.deepEqual(foreignAudit.unresolved, []);
assert.deepEqual(foreignAudit.observations.mismatches, []);
assert.equal((await auditProject([foreign], [foreignUnit], new Set([foreign.id]))).unresolved.length, 1);
await assert.rejects(auditProject([foreign], [foreignUnit], new Set([foreign.id, "typo"])), /Approved document IDs absent from target bank.*typo/);
assert.equal((await auditProject([foreign], [{ ...foreignUnit, tags: ["project:my-app"] }])).unresolved.length, 1);
assert.deepEqual((await auditProject([foreign], [
	foreignUnit, { ...foreignObservation, tags: ["project:my-app"] },
])).observations.mismatches, [foreignObservation.id]);

console.log("Scope policy, request paths, epoch isolation, and review snapshots passed.");
