import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { type BankRole, loadConfig } from "../src/config.ts";
import { HindsightClient, type InventoryRow } from "../src/hindsight.ts";
import { SHARED_TAG } from "../src/memory-scope.ts";

type Update = Parameters<HindsightClient["updateDocumentTags"]>[1];
type AuditOptions = {
	role: BankRole;
	projectTag?: string;
	dedicated?: boolean;
	approvedDocumentIds?: ReadonlySet<string>;
};

const sameTags = (left: string[], right: string[]) =>
	new Set(left).size === new Set(right).size && left.every(tag => right.includes(tag));
const owned = (tags: string[]) => tags.some(tag => tag.startsWith("user:"));
const projectTags = (row: InventoryRow) => [...new Set(row.tags.filter(tag => tag.startsWith("project:")))];

export async function auditScope(client: HindsightClient, opts: AuditOptions) {
	const [documents, units] = await Promise.all([
		client.inventory("documents"), client.inventory("memories/list"),
	]);
	const projectTag = opts.projectTag;
	if (opts.role === "project" && !projectTag) throw new Error("A project identity is required");
	const unitsByDocument = new Map<string, InventoryRow[]>();
	const unitsById = new Map(units.map(unit => [unit.id, unit]));
	const observations = units.filter(unit => unit.fact_type === "observation");
	const orphanUnits = units.filter(unit => unit.fact_type !== "observation");
	const documentIds = new Set(documents.map(doc => doc.id));
	const missingApprovals = [...(opts.approvedDocumentIds ?? [])].filter(id => !documentIds.has(id));
	if (missingApprovals.length)
		throw new Error(`Approved document IDs absent from target bank: ${JSON.stringify(missingApprovals)}`);
	for (const unit of orphanUnits) {
		if (!unit.document_id || !documentIds.has(unit.document_id)) continue;
		const linked = unitsByDocument.get(unit.document_id) ?? [];
		linked.push(unit);
		unitsByDocument.set(unit.document_id, linked);
	}
	const mismatches = (rows: InventoryRow[]) => ({
		sharedMissing: opts.role === "global"
			? rows.filter(row => !owned(row.tags) && !row.tags.includes(SHARED_TAG)).length : 0,
		ownedMarkedShared: opts.role === "global"
			? rows.filter(row => owned(row.tags) && row.tags.includes(SHARED_TAG)).length : 0,
		projectMissing: projectTag ? rows.filter(row => !row.tags.includes(projectTag)).length : 0,
		projectConflicts: projectTag
			? rows.filter(row => projectTags(row).length > 1).length : 0,
	});
	const changes: { id: string; update: Update }[] = [];
	const unresolved: { id: string; reason: string }[] = [];
	const foreignProjectDocuments = new Set<string>();
	for (const doc of documents) {
		const linked = unitsByDocument.get(doc.id) ?? [];
		const rows = [doc, ...linked];
		let add: string | undefined;
		let remove: string | undefined;
		if (opts.role === "global") {
			const owners = linked.length ? linked.map(unit => owned(unit.tags)) : [owned(doc.tags)];
			const mixed = owners.some(owner => owner !== owners[0]) || (owned(doc.tags) && !owners[0]);
			if (mixed) {
				unresolved.push({ id: doc.id, reason: "Mixed document and memory ownership" });
				continue;
			}
			if (!owners[0] && rows.some(row => !row.tags.includes(SHARED_TAG))) add = SHARED_TAG;
			if (owners[0] && rows.some(row => row.tags.includes(SHARED_TAG))) remove = SHARED_TAG;
		} else {
			const established = opts.dedicated || opts.approvedDocumentIds?.has(doc.id);
			const foreign = [...new Set(rows.flatMap(projectTags).filter(tag => tag !== projectTag))];
			if (foreign.length === 1 && !established &&
				rows.every(row => projectTags(row).length === 1 && row.tags.includes(foreign[0]!))) {
				foreignProjectDocuments.add(doc.id);
				continue;
			}
			const missing = rows.some(row => !row.tags.includes(projectTag!));
			if (foreign.length || (missing && !established)) {
				unresolved.push({ id: doc.id, reason: foreign.length ? "Conflicting project tags" : "Project ownership unverified" });
				continue;
			}
			if (missing) add = projectTag;
		}
		const detail = await client.inventoryDetail("documents", doc.id);
		const scopeChange = detail.observation_scopes !== "combined";
		if (!add && !remove && !scopeChange) continue;
		const update: Update = scopeChange ? { observation_scopes: "combined" } : {};
		if (add || remove) {
			// A full replacement is safe only if it preserves every non-migrated
			// tag that the document and its effective units already carry.
			const unchanged = (tags: string[]) => tags.filter(tag => tag !== add && tag !== remove);
			if (linked.every(unit => sameTags(unchanged(doc.tags), unchanged(unit.tags)))) {
				update.tags = [...new Set([...doc.tags.filter(tag => tag !== remove), ...(add ? [add] : [])])];
				if (sameTags(doc.tags, update.tags)) {
					unresolved.push({ id: doc.id, reason: "Document tags already match but effective unit tags differ" });
					continue;
				}
			} else {
				if (add) update.add_tags = [add];
				if (remove) update.remove_tags = [remove];
				if ((add && doc.tags.includes(add)) || (remove && !doc.tags.includes(remove))) {
					unresolved.push({ id: doc.id, reason: "Document and effective scope tags disagree" });
					continue;
				}
			}
		}
		changes.push({ id: doc.id, update });
	}
	const observationMismatches: string[] = [];
	for (const observation of observations) {
		const detail = observation.source_memory_ids || observation.source_fact_ids
			? observation : await client.inventoryDetail("memories", observation.id);
		const sources = detail.source_memory_ids ?? detail.source_fact_ids;
		if (projectTag && !observation.tags.includes(projectTag) && sources?.length &&
			sources.every(id => foreignProjectDocuments.has(unitsById.get(id)?.document_id ?? ""))) continue;
		if (!sources?.length || sources.some(id => {
			const source = unitsById.get(id);
			return !source || !sameTags(source.tags, observation.tags);
		})) observationMismatches.push(observation.id);
	}
	const effectiveDocuments = documents.map(doc => ({
		...doc,
		tags: [...doc.tags, ...(unitsByDocument.get(doc.id) ?? [])
			.flatMap(unit => unit.tags.filter(tag => tag.startsWith("user:")))],
	}));
	return {
		documents: { total: documents.length, ...mismatches(effectiveDocuments) },
		memoryUnits: { total: units.length, ...mismatches(units) },
		observations: { total: observations.length, mismatches: observationMismatches },
		foreignProjectDocuments: [...foreignProjectDocuments],
		unlinkedMemoryUnits: orphanUnits.filter(unit => !unit.document_id || !documentIds.has(unit.document_id)).map(unit => unit.id),
		unresolved,
		changes,
	};
}

if (import.meta.main) {
	const { values, positionals } = parseArgs({
		allowPositionals: true,
		options: {
			apply: { type: "boolean" },
			dedicated: { type: "boolean" },
			documents: { type: "string" },
		},
	});
	const [role, bankId] = positionals;
	if ((role !== "global" && role !== "project") || !bankId || positionals.length !== 2 ||
		(values.dedicated && values.documents !== undefined) ||
		(role === "global" && (values.dedicated || values.documents)))
		throw new Error("Usage: bun scripts/scope-migration.ts global|project BANK [--apply] [--dedicated | --documents FILE]");
	const cfg = loadConfig(process.cwd());
	if (cfg.configError) throw new Error(cfg.configError);
	const docs: unknown = values.documents ? JSON.parse(readFileSync(values.documents, "utf8")) : [];
	if (!Array.isArray(docs) || docs.some(id => typeof id !== "string" || !id))
		throw new Error("--documents expects a JSON array of verified document IDs");
	const client = new HindsightClient(
		role === "global" ? { ...cfg, userBankId: bankId } : { ...cfg, bankId },
		role,
		process.env.HINDSIGHT_MIGRATION_TOKEN,
	);
	const options = {
		role,
		projectTag: role === "project" && cfg.identity?.project ? `project:${cfg.identity.project}` : undefined,
		dedicated: values.dedicated,
		approvedDocumentIds: new Set<string>(docs),
	};
	const before = await auditScope(client, options);
	console.log(JSON.stringify(before, null, 2));
	if (values.apply) {
		for (const { id, update } of before.changes) await client.updateDocumentTags(id, update);
		const after = await auditScope(client, options);
		console.log(JSON.stringify(after, null, 2));
		if (after.changes.length || after.unresolved.length || after.unlinkedMemoryUnits.length ||
			after.observations.mismatches.length) process.exitCode = 1;
	}
}
