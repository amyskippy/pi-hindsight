import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { loadConfig } from "../src/config.ts";
import { HindsightClient } from "../src/hindsight.ts";
import { auditScope } from "./scope-migration.ts";

// Opt-in integration check. Both bank IDs are generated here and isolated
// from the configured banks. The token is only used for the configured host.
const suffix = randomUUID();
const config = loadConfig(process.cwd());
if (config.configError) throw new Error(config.configError);
const cfg = {
	...config,
	bankId: `pi-scope-project-${suffix}`,
	userBankId: `pi-scope-global-${suffix}`,
	identity: { user: "amy", project: "my-app", agent: "pi" },
	retain_tags: [],
	memory: undefined,
};
const token = process.env.HINDSIGHT_MIGRATION_TOKEN ?? "";
const global = new HindsightClient(cfg, "global", token);
const project = new HindsightClient(cfg, "project", token);
const scoped = {
	...cfg,
	memory: {
		global: { recallScope: "user-or-shared" },
		project: { recallScope: "project" },
	},
};
const globalScoped = new HindsightClient(scoped, "global", token);
const projectScoped = new HindsightClient(scoped, "project", token);
const projectTag = "project:my-app";
const globalCases: [string, string[], string][] = [
	["empty", [], "The shared robotics team's preferred voltage is twelve volts."],
	["agent", ["agent:pi"], "The shared robotics team uses a torque wrench for assembly."],
	["engineering", ["topic:engineering"], "The shared robotics team uses a hardened steel bracket."],
	["amy", ["user:amy", "user:carol", "type:preference"], "Amy prefers a brass mounting screw for the shared robotics kit."],
	["bob", ["user:bob", "topic:engineering", "scope:shared"], "Bob's exact private phase calibration phrase is scarlet falcon."],
];
const base = `${cfg.baseUrl}/v1/${encodeURIComponent(cfg.namespace)}/banks`;
const headers = token ? { authorization: `Bearer ${token}` } : undefined;
const created: string[] = [];
const assertUnitDocuments = async (client: HindsightClient, response: unknown, expected: string[]) => {
	const rows = (response as { results?: { id: string }[] }).results ?? [];
	assert.ok(rows.length > 0, "Expected scoped results");
	const sources = new Map((await client.inventory("memories/list")).map(unit => [unit.id, unit.document_id]));
	const ids = new Set(rows.map(row => sources.get(row.id)));
	assert.deepEqual([...ids].sort(), expected.sort());
};
try {
	for (const [id, client] of [[cfg.userBankId, global], [cfg.bankId, project]] as const) {
		await client.ensureBank();
		created.push(id);
	}
	await Promise.all(globalCases.map(([documentId, tags, text]) =>
		global.retain(text, { documentId, tags, metadata: { source: "scope-test" } }),
	));
	await Promise.all([
		project.retain("The sample application is built with Ninja.", { documentId: "missing", tags: ["user:carol", "agent:other"] }),
		project.retain("The other application is built with Maven.", { documentId: "wrong", tags: ["project:other", "user:amy", "agent:pi"] }),
		projectScoped.retain("The sample application is tested with Catch2.", { documentId: "right", tags: ["user:carol", "agent:other"] }),
	]);
	const globalOptions = { role: "global" } as const;
	const projectOptions = {
		role: "project", projectTag, approvedDocumentIds: new Set(["missing"]),
	} as const;
	const globalBefore = await auditScope(global, globalOptions);
	assert.equal(globalBefore.documents.sharedMissing, 3);
	assert.equal(globalBefore.documents.ownedMarkedShared, 1);
	const projectBefore = await auditScope(project, projectOptions);
	assert.equal(projectBefore.documents.projectMissing, 2);
	assert.equal(projectBefore.documents.projectConflicts, 0);
	assert.deepEqual(projectBefore.foreignProjectDocuments, ["wrong"]);
	assert.deepEqual(projectBefore.unresolved, []);
	for (const [client, before] of [[global, globalBefore], [project, projectBefore]] as const)
		for (const { id, update } of before.changes) await client.updateDocumentTags(id, update);
	assert.equal((await auditScope(global, globalOptions)).changes.length, 0);
	assert.equal((await auditScope(project, projectOptions)).changes.length, 0);

	const listed = await globalScoped.listMemories(100);
	assert.ok(listed.every(row => row.tags?.includes("scope:shared") || row.tags?.includes("user:amy")));
	const types = ["world", "experience"];
	const recall = (client: HindsightClient, query: string, maxTokens = 1024) =>
		client.recall(query, { types, maxTokens, preferObservations: false });
	await assertUnitDocuments(global, await recall(globalScoped, "Shared robotics team tools, voltage, brackets and mounting fasteners"), ["empty", "agent", "engineering", "amy"]);
	const compound = new HindsightClient({
		...scoped,
		memory: { global: { recallScope: "user-or-shared", recallFilters: ["topic:engineering", "type:preference"] } },
	}, "global", token);
	await assertUnitDocuments(global, await recall(compound, "Robotics engineering tools and fastener preferences"), ["engineering", "amy"]);
	const bobIds = new Set((await global.inventory("memories/list")).filter(row => row.document_id === "bob").map(row => row.id));
	const exact = (await global.listMemories(100)).find(row => row.id && bobIds.has(row.id))?.text;
	assert.ok(exact, "Expected an extracted Bob memory");
	const ranking: { budget: number; positions: boolean[] }[] = [];
	let checkedBudget = false;
	for (const budget of [25, 35, 50, 70, 100]) {
		const unscoped = await recall(global, exact, budget) as { results: { id: string }[] };
		ranking.push({ budget, positions: unscoped.results.map(row => bobIds.has(row.id)) });
		if (unscoped.results.length >= 3 || !unscoped.results.some(row => bobIds.has(row.id))) continue;
		const tight = await recall(globalScoped, exact, budget) as { results: { id: string }[] };
		assert.ok(tight.results.length, "Eligible results should survive a tight budget");
		assert.ok(tight.results.every(row => !bobIds.has(row.id)));
		if (!tight.results.some(row => !unscoped.results.some(raw => raw.id === row.id))) continue;
		checkedBudget = true;
		break;
	}
	assert.ok(checkedBudget, `Expected scope to replace a highly ranked ineligible result under a small token budget: ${JSON.stringify(ranking)}`);
	await assertUnitDocuments(project, await recall(projectScoped, "Build and test tools for the sample application"), ["missing", "right"]);
	await assert.rejects(projectScoped.reflect("summarize"), /Scoped synthesis is unavailable/);
	console.log("Scoped listing, recall, token limits, retagging, and migration idempotence passed.");
	for (const id of created) {
		const res = await fetch(`${base}/${id}/consolidate`, { method: "POST", headers });
		assert.ok(res.ok, `Consolidate returned ${res.status}`);
	}
	const deadline = Date.now() + 60000;
	while (true) {
		const reports = await Promise.all([auditScope(global, globalOptions), auditScope(project, projectOptions)]);
		if (reports.every(report => report.observations.total > 0 && !report.observations.mismatches.length)) break;
		assert.ok(Date.now() < deadline, "Timed out waiting for correctly scoped observations");
		await new Promise(resolve => setTimeout(resolve, 1000));
	}
	console.log("Rebuilt observations preserved the complete effective source tags.");
} finally {
	for (const id of created) {
		const res = await fetch(`${base}/${id}`, { method: "DELETE", headers });
		if (!res.ok) console.error(`Disposable bank ${id} cleanup returned ${res.status}`);
	}
}
