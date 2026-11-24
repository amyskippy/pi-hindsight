/**
 * Standalone unit test for the three-layer config merge + bank-gated activation
 * (run with bun or node).
 *
 *   bun scripts/config-merge.test.ts
 *   node --experimental-strip-types scripts/config-merge.test.ts
 *
 * Points HOME at a throwaway dir so `globalConfigPath()` resolves under a temp
 * tree, writes temp global/project override files, and asserts the precedence
 * env(base) → global → project plus the activation rules.
 */

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { HindsightClient } from "../src/hindsight.ts";

// Redirect HOME (used by os.homedir() → globalConfigPath()) and clear any env
// bank so the base layer stays neutral BEFORE importing the module.
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "cfg-home-"));
process.env.HOME = tmpHome;
process.env.USERPROFILE = tmpHome;
delete process.env.HINDSIGHT_BANK;

const { loadConfig, globalConfigPath, readProjectOverrides, CONFIG_ALLOW } =
	await import("../src/config.ts");

let failures = 0;
function check(name: string, cond: boolean): void {
	console.log(`${cond ? "PASS" : "FAIL"}  ${name}`);
	if (!cond) failures++;
}

function writeGlobal(obj: Record<string, unknown> | null): void {
	const file = globalConfigPath();
	fs.mkdirSync(path.dirname(file), { recursive: true });
	if (obj === null) fs.rmSync(file, { force: true });
	else fs.writeFileSync(file, JSON.stringify(obj, null, 2));
}

function makeCwd(name: string, obj: Record<string, unknown> | null): string {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), `cfg-${name}-`));
	if (obj !== null) {
		fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
		fs.writeFileSync(
			path.join(cwd, ".pi", "hindsight.json"),
			JSON.stringify(obj, null, 2),
		);
	}
	return cwd;
}

const cleanup: string[] = [tmpHome];
function slugOf(cwd: string): string {
	return path.basename(cwd)
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 64);
}

// (a) project overrides global overrides base ------------------------------
{
	writeGlobal({ namespace: "global-ns", memoryLanguage: "fr" });
	const cwd = makeCwd("a", { namespace: "project-ns" });
	cleanup.push(cwd);
	const cfg = loadConfig(cwd);
	check(
		"(a) project wins: namespace = project-ns",
		cfg.namespace === "project-ns",
	);
	check(
		"(a) global fills gap: memoryLanguage = fr",
		cfg.memoryLanguage === "fr",
	);
	check(
		"(a) base default kept: baseUrl",
		cfg.baseUrl === "http://localhost:8888",
	);
}

// (b) global "auto" activates with folder-slug bank ------------------------
{
	writeGlobal({ bankId: "auto", retain_tags: "project:{bankId}" });
	const cwd = makeCwd("b", null);
	cleanup.push(cwd);
	const cfg = loadConfig(cwd);
	check("(b) global auto → active", cfg.active === true);
	check("(b) global auto → folder-slug bank", cfg.bankId === slugOf(cwd));
	check(
		"(b) {bankId} uses the derived folder slug",
		cfg.retain_tags[0] === `project:${slugOf(cwd)}`,
	);

	const projectDir = path.join(cwd, "My Project");
	const posixCwd = projectDir.replace(/\\/g, "/");
	const windowsCwd = projectDir.replace(/\//g, "\\");
	check(
		"(b) auto derives the bank from a slash-separated path",
		loadConfig(posixCwd).bankId === "my-project",
	);
	check(
		"(b) auto derives the same bank from a backslash-separated path",
		loadConfig(windowsCwd).bankId === "my-project",
	);
}

// (c) global concrete bankId does NOT activate -----------------------------
{
	writeGlobal({ bankId: "shared-bank" });
	const cwd = makeCwd("c", null);
	cleanup.push(cwd);
	const cfg = loadConfig(cwd);
	check("(c) global concrete bank → inactive", cfg.active === false);
	check(
		"(c) global concrete bank ignored → folder slug",
		cfg.bankId === slugOf(cwd),
	);
}

// (d) project concrete bankId activates ------------------------------------
{
	writeGlobal({ bankId: "shared-bank" });
	const cwd = makeCwd("d", { bankId: "My Project Bank" });
	cleanup.push(cwd);
	const cfg = loadConfig(cwd);
	check("(d) project concrete bank → active", cfg.active === true);
	check("(d) project bank slugified", cfg.bankId === "my-project-bank");
}

// (e) no bank anywhere → active=false --------------------------------------
{
	writeGlobal(null);
	const cwd = makeCwd("e", { namespace: "x" });
	cleanup.push(cwd);
	const cfg = loadConfig(cwd);
	check("(e) no bank declared → inactive", cfg.active === false);
	check("(e) inactive still has folder-slug bank", cfg.bankId === slugOf(cwd));
}

// (f) HINDSIGHT_AUTO_OFF overrides every layer -----------------------------
{
	writeGlobal({ bankId: "auto", autoRecall: true, autoMemorize: true });
	const cwd = makeCwd("f", {
		bankId: "proj",
		autoRecall: true,
		autoMemorize: true,
	});
	cleanup.push(cwd);
	const on = loadConfig(cwd);
	check("(f) without the flag, config layers win", on.autoRecall === true);

	process.env.HINDSIGHT_AUTO_OFF = "1";
	const off = loadConfig(cwd);
	delete process.env.HINDSIGHT_AUTO_OFF;
	check("(f) auto-off beats project autoRecall", off.autoRecall === false);
	check("(f) auto-off beats project autoMemorize", off.autoMemorize === false);
	check("(f) auto-off leaves the bank active", off.active === true);
}

// (g) `recallOperation` is gone, not merely ignored -------------------------
{
	// It was a documented, /mem-settable, persisted switch that NOTHING read:
	// parseQueryPlan hard-codes op:"recall" and runRecall never looked at it. A
	// user flipped it and nothing happened, so the key must not survive anywhere
	// — including as an accepted config-file key that gets written back to
	// .pi/hindsight.json.
	process.env.HINDSIGHT_RECALL_OPERATION = "reflect";
	writeGlobal({ bankId: "g" });
	const cwd = makeCwd("g", { recallOperation: "reflect" } as never);
	cleanup.push(cwd);
	const cfg = loadConfig(cwd) as Record<string, unknown>;
	delete process.env.HINDSIGHT_RECALL_OPERATION;
	check("(g) recallOperation is not a config key", !("recallOperation" in cfg));
	check(
		"(g) a recallOperation in the project file is not accepted",
		!("recallOperation" in readProjectOverrides(cwd)),
	);
	check("(g) CONFIG_ALLOW has dropped it", !CONFIG_ALLOW.has("recallOperation" as never));
}

// (h) the review auto-approval window is an ordinary allow-listed key ------
{
	// Documents awaiting review used to wait forever. The window that ages them
	// out is a normal config key, so it must follow the same three-layer merge as
	// every other one — including a project file that wants a shorter leash.
	writeGlobal(null);
	const plain = makeCwd("h-default", null);
	cleanup.push(plain);
	const def = loadConfig(plain) as unknown as Record<string, unknown>;
	check(
		"(h) Default value: reviewAutoApproveDays defaults to 7",
		def.reviewAutoApproveDays === 7,
	);

	process.env.HINDSIGHT_REVIEW_AUTO_APPROVE_DAYS = "3";
	const fromEnv = loadConfig(plain) as unknown as Record<string, unknown>;
	check(
		"(h) Environment override: HINDSIGHT_REVIEW_AUTO_APPROVE_DAYS=3 beats the default",
		fromEnv.reviewAutoApproveDays === 3,
	);

	writeGlobal({ reviewAutoApproveDays: 5 });
	const cwd = makeCwd("h-file", { reviewAutoApproveDays: 2 });
	cleanup.push(cwd);
	const merged = loadConfig(cwd) as unknown as Record<string, unknown>;
	delete process.env.HINDSIGHT_REVIEW_AUTO_APPROVE_DAYS;
	check(
		"(h) File override: the project file beats the global file and the env",
		merged.reviewAutoApproveDays === 2,
	);
	check(
		"(h) File override: the key is allow-listed",
		CONFIG_ALLOW.has("reviewAutoApproveDays" as never),
	);
	check(
		"(h) File override: 0 survives the merge (expiry off, not a falsy fallback to 7)",
		(
			loadConfig(makeCwd("h-zero", { reviewAutoApproveDays: 0 })) as unknown as Record<
				string,
				unknown
			>
		).reviewAutoApproveDays === 0,
	);
	writeGlobal(null);
}

// (i) "repo" derives the bank from Git and falls back to the folder --------
{
	const root = makeCwd("repo", null);
	cleanup.push(root);
	execFileSync("git", ["init", "--quiet"], { cwd: root });
	const cwd = path.join(root, "Nested Project");
	fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
	fs.writeFileSync(
		path.join(cwd, ".pi", "hindsight.json"),
		JSON.stringify({ bankId: "repo" }),
	);

	const local = loadConfig(cwd);
	check("(i) repo mode in a project config activates memory", local.active);
	check(
		"(i) a repo without origin uses its root folder",
		local.bankId === slugOf(root),
	);

	for (const origin of [
		"https://example.com/team/Shared-Repo.git",
		"git@example.com:Shared-Repo.git",
		"C:\\Repos\\Shared-Repo.git",
	]) {
		execFileSync("git", ["config", "--local", "remote.origin.url", origin], {
			cwd: root,
		});
		check(
			`(i) uses the origin basename from ${origin}`,
			loadConfig(cwd).bankId === "shared-repo",
		);
	}

	writeGlobal({ bankId: "repo", retain_tags: "project:{bankId}" });
	const global = loadConfig(root);
	check(
		"(i) global repo mode activates memory",
		global.active && global.bankId === "shared-repo",
	);
	check(
		"(i) {bankId} uses the derived repository slug",
		global.retain_tags[0] === "project:shared-repo",
	);

	process.env.HINDSIGHT_BANK = "env-bank";
	check(
		"(i) the env bank overrides global repo mode",
		loadConfig(root).bankId === "env-bank",
	);
	check(
		"(i) project repo mode overrides the env bank",
		loadConfig(cwd).bankId === "shared-repo",
	);
	process.env.HINDSIGHT_BANK = "repo";
	writeGlobal(null);
	check(
		"(i) HINDSIGHT_BANK can enable repo mode",
		loadConfig(root).bankId === "shared-repo",
	);
	delete process.env.HINDSIGHT_BANK;

	const outside = makeCwd("repo-fallback", {
		bankId: "repo",
		retain_tags: "project:{bankId}",
	});
	cleanup.push(outside);
	const fallback = loadConfig(outside);
	check(
		"(i) outside Git, repo mode acts like auto",
		fallback.active && fallback.bankId === slugOf(outside),
	);
	check(
		"(i) {bankId} uses the folder slug when repo mode falls back",
		fallback.retain_tags[0] === `project:${slugOf(outside)}`,
	);
}

// (j) configured retain tags are merged into the outgoing item ------------
{
	process.env.HINDSIGHT_RETAIN_TAGS = " user:env, project:{bankId},,user:env ";
	check(
		"(j) the environment provides comma-separated default tags",
		JSON.stringify(loadConfig(tmpHome).retain_tags) ===
			JSON.stringify(["user:env", `project:${slugOf(tmpHome)}`]),
	);
	writeGlobal({ retain_tags: " user:amy " });
	check(
		"(j) the global tag overrides the environment",
		JSON.stringify(loadConfig(tmpHome).retain_tags) === JSON.stringify(["user:amy"]),
	);
	const cwd = makeCwd("retain-tags", {
		bankId: "My Project",
		retain_tags: [
			"user:amy",
			" team:platform ",
			"project:{bankId}",
			"project:my-project",
			"",
			7,
		],
	});
	cleanup.push(cwd);
	const cfg = loadConfig(cwd);
	check(
		"(j) normalized project tags override the global and environment tags",
		JSON.stringify(cfg.retain_tags) ===
			JSON.stringify(["user:amy", "team:platform", "project:my-project"]),
	);

	const cleared = makeCwd("retain-tags-clear", { retain_tags: [] });
	cleanup.push(cleared);
	check(
		"(j) an empty project list clears inherited tags",
		loadConfig(cleared).retain_tags.length === 0,
	);

	const requests: { url: string; tags?: string[] }[] = [];
	const originalFetch = globalThis.fetch;
	globalThis.fetch = (async (url: string, init?: RequestInit) => {
		const item = JSON.parse(String(init?.body)).items[0];
		requests.push({ url, tags: item.tags });
		return Response.json({});
	}) as typeof fetch;
	try {
		await new HindsightClient(cfg).retain("note", {
			tags: ["my-project", "agent-summary", "team:platform"],
		});
		await new HindsightClient({ ...cfg, bankId: "user-bank" }).retain("note");
		writeGlobal(null);
		delete process.env.HINDSIGHT_RETAIN_TAGS;
		await new HindsightClient(loadConfig(tmpHome)).retain("note");
		check(
			"(j) configured tags extend built-in tags in the outgoing project request",
			JSON.stringify(requests[0]?.tags) ===
				JSON.stringify([
					"my-project",
					"agent-summary",
					"team:platform",
					"user:amy",
					"project:my-project",
				]),
		);
		check(
			"(j) user-bank requests keep the project ID in configured tags",
			requests[1]?.url.endsWith("/user-bank/memories") &&
				JSON.stringify(requests[1].tags) === JSON.stringify(cfg.retain_tags),
		);
		check("(j) an untagged request still omits tags", requests[2]?.tags === undefined);
	} finally {
		globalThis.fetch = originalFetch;
	}
}

// (k) API keys follow config precedence and stay with their endpoint.
{
	const baseUrl = "https://memory.example";
	const inherited = makeCwd("auth-inherited", null);
	const override = makeCwd("auth-override", { apiKey: "project-key" });
	const different = makeCwd("auth-different", { baseUrl: "https://other.example" });
	cleanup.push(inherited, override, different);
	process.env.HINDSIGHT_API_KEY = "env-key";
	writeGlobal({ baseUrl });
	check("(k) environment supplies the API key", loadConfig(inherited).apiKey === "env-key");
	writeGlobal({ baseUrl, apiKey: " global-key " });
	const cfg = loadConfig(inherited);
	check("(k) global key overrides the environment", cfg.apiKey === "global-key");
	check("(k) project key overrides the global key", loadConfig(override).apiKey === "project-key");
	const requests: { authorization: string | null; redirect?: RequestRedirect }[] = [];
	const originalFetch = globalThis.fetch;
	globalThis.fetch = (async (_url: string, init?: RequestInit) => {
		requests.push({
			authorization: new Headers(init?.headers).get("authorization"),
			redirect: init?.redirect,
		});
		return Response.json({});
	}) as typeof fetch;
	try {
		await new HindsightClient(cfg, "global").health();
		await new HindsightClient(loadConfig(different)).health();
		await new HindsightClient(cfg, "project", "migration-token").health();
		await new HindsightClient(cfg, "project", "").health();
		check("(k) requests use bearer authentication and reject redirects",
			requests[0]?.authorization === "Bearer global-key" && requests[0]?.redirect === "error");
		check("(k) an endpoint override does not inherit the global key", requests[1]?.authorization === null);
		check("(k) an explicit script token takes precedence", requests[2]?.authorization === "Bearer migration-token");
		check("(k) a script can opt out of the normal key", requests[3]?.authorization === null);
	} finally {
		globalThis.fetch = originalFetch;
		writeGlobal(null);
	}
}

for (const dir of cleanup) fs.rmSync(dir, { recursive: true, force: true });
console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
