import type { BankRole, HindsightConfig } from "./config.ts";

export const SHARED_TAG = "scope:shared";

export interface TagGroup {
	tags: string[];
	match: "any_strict" | "all_strict";
}

export type RecallTags =
	| { tags?: string[]; tags_match?: TagGroup["match"] }
	| { tag_groups: TagGroup[] };

const DEFAULT_TAGS = {
	global: ["user:{user}"],
	project: ["user:{user}", "project:{project}", "agent:{agent}"],
};

export class MemoryScopeError extends Error {}

function policy(cfg: HindsightConfig, role: BankRole): Record<string, unknown> {
	const memory = cfg.memory;
	if (memory === undefined) return {};
	if (!memory || typeof memory !== "object" || Array.isArray(memory))
		throw new MemoryScopeError("memory must be an object");
	const section = (memory as Record<string, unknown>)[role];
	if (section === undefined) return {};
	if (!section || typeof section !== "object" || Array.isArray(section))
		throw new MemoryScopeError(`memory.${role} must be an object`);
	const unexpected = Object.keys(section).find(key => !["recallScope", "retainTags", "recallFilters"].includes(key));
	if (unexpected) throw new MemoryScopeError(`Unknown memory.${role} setting: ${unexpected}`);
	return section as Record<string, unknown>;
}

function requiredIdentity(cfg: HindsightConfig, key: "user" | "project" | "agent"): string {
	const value = cfg.identity?.[key];
	if (!value) throw new MemoryScopeError(`Missing memory identity {${key}}`);
	return value;
}

function expandTags(cfg: HindsightConfig, role: BankRole, value: unknown, field: string): string[] {
	if (!Array.isArray(value) || value.some(tag => typeof tag !== "string" || !tag.trim()))
		throw new MemoryScopeError(`memory.${role}.${field} must be an array of non-empty strings`);
	const bankId = role === "global" ? cfg.userBankId : cfg.bankId;
	return [...new Set(value.map((tag: string) =>
		tag.trim().replace(/\{([^{}]+)\}/g, (_, key: string) => {
			if (key === "bankId") return bankId;
			if (key === "user" || key === "project" || key === "agent")
				return requiredIdentity(cfg, key);
			throw new MemoryScopeError(`Unknown memory tag placeholder {${key}}`);
		})
	))];
}

export function scopeMode(cfg: HindsightConfig, role: BankRole): RetainSnapshot["scope"] {
	const scope = policy(cfg, role).recallScope;
	if (cfg.userBankId && cfg.userBankId === cfg.bankId &&
		(scope !== undefined || policy(cfg, role === "global" ? "project" : "global").recallScope !== undefined))
		throw new MemoryScopeError("Scoped banks require distinct project and global bank IDs");
	if (scope === undefined) return undefined;
	if ((role === "global" && scope === "user-or-shared") || (role === "project" && scope === "project"))
		return scope;
	throw new MemoryScopeError(`Invalid memory.${role}.recallScope`);
}

export function bankScope(cfg: HindsightConfig, role: BankRole): TagGroup | undefined {
	const mode = scopeMode(cfg, role);
	if (mode === "user-or-shared")
		return { tags: [`user:${requiredIdentity(cfg, "user")}`, SHARED_TAG], match: "any_strict" };
	if (mode === "project")
		return { tags: [`project:${requiredIdentity(cfg, "project")}`], match: "all_strict" };
	return undefined;
}

export function recallTags(cfg: HindsightConfig, role: BankRole, tags?: string[]): RecallTags {
	const scope = bankScope(cfg, role);
	const { recallFilters = [] } = policy(cfg, role);
	const filters = expandTags(cfg, role, recallFilters, "recallFilters");
	// Configured and caller filters each narrow the eligible set independently.
	const groups: TagGroup[] = scope ? [scope] : [];
	if (filters.length) groups.push({ tags: filters, match: "any_strict" });
	if (!groups.length) return { tags };
	if (tags?.length) groups.push({ tags, match: "any_strict" });
	if (groups.length === 1) return { tags: groups[0]!.tags, tags_match: groups[0]!.match };
	return { tag_groups: groups };
}

export function flatListTags(predicate: RecallTags): Exclude<RecallTags, { tag_groups: TagGroup[] }> {
	if (!("tag_groups" in predicate)) return predicate;
	const clauses = predicate.tag_groups.flatMap(group =>
		group.match === "all_strict" ? group.tags.map(tag => [tag]) : [group.tags]
	);
	const required = [...new Set(clauses.filter(tags => tags.length === 1).map(tags => tags[0]!))];
	const extra = clauses.filter(tags => tags.length > 1 && !tags.some(tag => required.includes(tag)));
	if (!extra.length) return { tags: required, tags_match: "all_strict" };
	if (!required.length) {
		const smallest = extra.find(tags => extra.every(clause => tags.every(tag => clause.includes(tag))));
		if (smallest) return { tags: smallest, tags_match: "any_strict" };
	}
	throw new MemoryScopeError("A query marker is required for compound global recall filters");
}

export function normalizeGlobalTags(tags: readonly string[]): string[] {
	const result = [...new Set(tags.filter(tag => tag !== SHARED_TAG))];
	if (!result.some(tag => tag.startsWith("user:"))) result.push(SHARED_TAG);
	return result;
}

/** A review snapshot carries the original scope even after an identity change. */
export interface RetainSnapshot {
	tags?: string[];
	scope?: "user-or-shared" | "project";
}

export function retainSnapshot(
	cfg: HindsightConfig, role: BankRole, explicit?: string[],
): RetainSnapshot {
	const defaults = policy(cfg, role).retainTags;
	const scope = scopeMode(cfg, role);
	const automatic = defaults !== undefined
		? expandTags(cfg, role, defaults, "retainTags")
		: [
			...(scope ? expandTags(cfg, role, DEFAULT_TAGS[role], "retainTags") : []),
			...(cfg.retain_tags ?? []),
		];
	const provided = (explicit ?? []).map(tag => tag.trim()).filter(Boolean);
	const tags = explicit !== undefined || automatic.length || defaults !== undefined
		? [...new Set([...provided, ...automatic])]
		: undefined;
	if (!scope) return { tags };
	if (scope === "user-or-shared") return { tags: normalizeGlobalTags(tags ?? []), scope };
	const project = `project:${requiredIdentity(cfg, "project")}`;
	if (tags?.some(tag => tag.startsWith("project:") && tag !== project))
		throw new MemoryScopeError(`Project write contains a conflicting project tag (expected ${project})`);
	return { tags: [...new Set([...(tags ?? []), project])], scope };
}
