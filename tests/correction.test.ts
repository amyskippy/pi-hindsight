import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test, type TestContext } from "node:test";
import type { MemoryRow } from "../src/hindsight.ts";
import extension from "../src/index.ts";
import { readLog } from "../src/log.ts";

const oldText = "This project uses .NET.";
const replacement = "This project uses Python.";
const correction = {
	memory_id: "old",
	expected_text: oldText,
	replacement,
	user_quote: "Actually Python",
};

type Handler = (event: unknown, ctx: unknown) => unknown;
type Tool = {
	name: string;
	execute(id: string, input: unknown, signal: undefined, update: undefined, ctx: unknown): Promise<{
		content: Array<{ text: string }>;
		isError?: boolean;
	}>;
};

async function fixture(t: TestContext, options: { refuseRetire?: boolean; emptyReplacement?: boolean } = {}) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "hindsight-correction-"));
	const cwd = path.join(root, "project");
	const previousHome = process.env.HOME;
	process.env.HOME = root;
	fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
	fs.writeFileSync(path.join(cwd, ".pi/hindsight.json"), JSON.stringify({
		bankId: "project-bank", baseUrl: "http://correction.fixture",
		autoRecall: false, autoMemorize: false,
	}));
	const handlers = new Map<string, Handler[]>();
	const tools = new Map<string, Tool>();
	const rows = new Map<string, MemoryRow>([["old", { id: "old", text: oldText, type: "world", state: "valid", tags: [] }]]);
	const documents = new Map<string, number>();
	const writes: string[] = [];
	const global = globalThis as { __piHindsightDispose?: () => void };
	const context = {
		cwd, hasUI: false, agent: { kind: "main" },
		ui: { notify() {}, setWidget() {}, setStatus() {} },
		sessionManager: { getSessionId: () => "session", getSessionName: () => undefined, getEntries: () => [] },
	};
	t.after(() => {
		global.__piHindsightDispose?.();
		delete global.__piHindsightDispose;
		if (previousHome === undefined) delete process.env.HOME;
		else process.env.HOME = previousHome;
		fs.rmSync(root, { recursive: true, force: true });
	});
	t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
		const endpoint = new URL(url).pathname.replace("/v1/default/banks/project-bank", "");
		const method = init.method;
		const body = init.body ? JSON.parse(String(init.body)) : undefined;
		if (endpoint === "/memories/recall") return Response.json({ results: [...rows.values()] });
		if (endpoint === "/memories" && method === "POST") {
			const item = body.items[0];
			assert.equal(item.content, replacement);
			assert.equal(body.async, false);
			documents.set(item.document_id, options.emptyReplacement ? 0 : 1);
			writes.push(`save:${item.document_id}`);
			return Response.json({ success: true });
		}
		if (endpoint.startsWith("/documents/")) {
			const count = documents.get(endpoint.slice("/documents/".length));
			return count === undefined ? new Response(null, { status: 404 }) : Response.json({ memory_unit_count: count });
		}
		if (endpoint.startsWith("/memories/")) {
			const id = endpoint.slice("/memories/".length);
			const row = rows.get(id);
			if (!row) return new Response(null, { status: 404 });
			if (method === "PATCH") {
				writes.push(`retire:${id}`);
				if (options.refuseRetire) {
					options.refuseRetire = false;
					return new Response(null, { status: 400 });
				}
				row.state = body.state;
				row.invalidation_reason = body.reason;
			}
			return Response.json(row);
		}
		assert.ok(["", "/config", "/stats"].includes(endpoint), `${method} ${url}`);
		return Response.json({});
	});
	extension({
		registerFlag() {}, registerShortcut() {}, registerCommand() {},
		registerTool(tool: Tool) { tools.set(tool.name, tool); },
		on(type: string, handler: Handler) {
			const list = handlers.get(type) ?? [];
			list.push(handler);
			handlers.set(type, list);
		},
	} as never);
	async function emit(type: string, event: object) {
		for (const handler of handlers.get(type) ?? []) await handler({ type, ...event }, context);
	}
	await emit("session_start", {});
	return {
		rows, writes, documents,
		log: () => readLog(cwd, ".pi/hindsight/log.jsonl"),
		end: () => emit("agent_end", {}),
		async prompt(text: string, source = "interactive") {
			await emit("input", { text, source });
			await emit("before_agent_start", { prompt: text, reason: "prompt", systemPrompt: "" });
		},
		async call(input: object = correction, toolName = "hindsight_correct") {
			const tool = tools.get(toolName);
			assert.ok(tool);
			const result = await tool.execute("call", input, undefined, undefined, context);
			return { text: result.content[0].text, error: result.isError === true };
		},
	};
}

test("a user can correct a recalled false fact, and a retry reuses the saved replacement", async t => {
	const h = await fixture(t, { refuseRetire: true });
	await h.prompt(correction.user_quote);
	const partial = await h.call();
	assert.equal(partial.error, true);
	assert.match(partial.text, /Replacement saved.*Retirement of old was not confirmed/);
	assert.equal(h.log().length, 0);
	const complete = await h.call();
	assert.equal(complete.error, false);
	assert.deepEqual(h.writes.map(write => write.split(":")[0]), ["save", "retire", "retire"]);
	assert.equal(h.documents.size, 1);
	assert.deepEqual(h.log()[0].kills, [{ id: "old", text: oldText, quote: correction.user_quote }]);
	assert.equal(h.log()[0].documentText, replacement);
	assert.match((await h.call()).text, /Correction already applied/);
	assert.equal(h.writes.length, 3);
	assert.equal(h.log().length, 1);
});

test("a replacement that extracts no facts leaves the old fact active", async t => {
	const h = await fixture(t, { emptyReplacement: true });
	await h.prompt(correction.user_quote);
	const result = await h.call();
	assert.match(result.text, /Retirement was skipped.*no confirmed extracted facts/);
	assert.equal(result.error, true);
	assert.equal(h.rows.get("old")?.state, "valid");
	assert.equal(h.writes.length, 1);
});

test("only current user input can authorize a correction of the exact stored text", async t => {
	const h = await fixture(t);
	await h.prompt(correction.user_quote, "extension");
	assert.match((await h.call()).text, /exact quote from the current user message/);
	await h.prompt(correction.user_quote);
	assert.match((await h.call({ ...correction, user_quote: "Invented evidence" })).text, /exact quote/);
	assert.match((await h.call({ ...correction, expected_text: "Different fact" })).text, /does not match/);
	await h.end();
	assert.match((await h.call()).text, /exact quote/);
	assert.deepEqual(h.writes, []);
});

test("recall revisions detect a changed source and provide the current revision without another recall", async t => {
	const h = await fixture(t);
	await h.prompt(correction.user_quote);
	const first = await h.call({ query: ".NET", include_ids: true }, "hindsight_recall");
	const oldRevision = first.text.match(/id=old revision=([0-9a-f]{16})/)?.[1];
	assert.ok(oldRevision);
	h.rows.get("old")!.text += " | Involving: project | Hindsight provenance.";
	const request = { memory_id: "old", replacement, user_quote: correction.user_quote };
	const stale = await h.call({ ...request, expected_revision: oldRevision });
	assert.equal(stale.error, true);
	assert.match(stale.text, /does not match the current source/);
	assert.deepEqual(h.writes, []);
	const newRevision = stale.text.match(/source_id=old revision=([0-9a-f]{16})/)?.[1];
	assert.ok(newRevision);
	assert.notEqual(oldRevision, newRevision);
	assert.equal((await h.call({ ...request, expected_revision: newRevision })).error, false);
	assert.equal(h.writes.length, 2);
});

test("observation provenance requires a source selection and respects project boundaries", async t => {
	const h = await fixture(t);
	h.rows.get("old")!.text += " | Involving: project | Hindsight provenance.";
	h.rows.set("other", { id: "other", text: "The frontend uses .NET.", fact_type: "world", state: "valid" });
	h.rows.set("foreign", { id: "foreign", text: "Foreign fact", type: "world", state: "valid", tags: ["project:other"] });
	h.rows.set("obs", { id: "obs", text: oldText, fact_type: "observation", state: "valid", source_memory_ids: ["old", "other", "foreign"] });
	await h.prompt(correction.user_quote);
	const recall = await h.call({ query: ".NET", include_ids: true }, "hindsight_recall");
	assert.match(recall.text, /\[world id=old revision=[0-9a-f]{16}\]/);
	assert.match(recall.text, /\[observation id=obs revision=[0-9a-f]{16}\]/);
	const observation = { memory_id: "obs", replacement, user_quote: correction.user_quote };
	const preview = await h.call(observation);
	assert.match(preview.text, /source_id=old/);
	assert.match(preview.text, /source_id=other/);
	assert.doesNotMatch(preview.text, /Foreign fact/);
	assert.match((await h.call({ ...observation, source_id: "foreign" })).text, /current project scope/);
	assert.match((await h.call({ ...observation, source_id: "unrelated" })).text, /not a source/);
	assert.deepEqual(h.writes, []);
	const revision = preview.text.match(/source_id=old revision=([0-9a-f]{16})/)?.[1];
	assert.ok(revision);
	assert.equal((await h.call({ ...observation, source_id: "old", expected_revision: revision })).error, false);
	assert.equal(h.rows.get("old")?.state, "invalidated");
	assert.equal(h.rows.get("other")?.state, "valid");
	assert.equal(h.rows.get("obs")?.state, "valid");
});
