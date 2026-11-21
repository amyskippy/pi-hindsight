# Scope-aware memory recall and configurable tag filters

Keep the existing two-bank architecture. The optional global bank (`userBankId`) holds cross-project memories. The project bank (`bankId`) holds repository-specific memories. Apply mandatory eligibility in Hindsight before retrieval limits, then intersect it with any additional recall filters.

## Configuration and identity

```json
{
  "memory": {
    "global": {
      "retainTags": ["user:{user}"],
      "recallScope": "user-or-shared",
      "recallFilters": []
    },
    "project": {
      "retainTags": ["user:{user}", "project:{project}", "agent:{agent}"],
      "recallScope": "project",
      "recallFilters": []
    }
  }
}
```

- Merge each bank section field by field using existing config precedence. An array replaces the inherited array. `recallFilters: []` clears an inherited filter. `retainTags` controls automatic tags, while `recallScope` defines eligibility independently. The existing singular `recallFilter` continues to control the relevance judge.
- Keep bank selection and activation in the existing config. Reuse the identity implementation for `{user}`, `{project}`, and `{agent}`. This checkout currently exposes Git-derived project bank IDs and `{bankId}` expansion. Locate the branch with the other placeholder resolvers before wiring them in. Use the resolved project identity consistently for retain and recall. [Config and bank resolution](../src/config.ts)
- Preserve legacy behavior for banks that have yet to opt into scope. Keep `retain_tags`, `HINDSIGHT_RETAIN_TAGS`, and `{bankId}` working. An explicit per-bank `retainTags` takes precedence over the legacy list. Keep activation per bank so existing installations can migrate in stages.
- Report invalid policies, malformed filters, missing required identities, and unsupported server capabilities on the affected path. Issue no unscoped retry. Use explicit bank roles in client construction, and reject the same bank ID for both roles in scoped mode.

## Retention and the shared marker

Global writes default to the resolved user tag. Preserve explicit descriptive tags, and derive the reserved `scope:shared` marker from the final tag set. Add it exactly when there are zero `user:` tags. Adding the first user tag removes the marker. Removing the last user tag adds it. Every writer or retag operation that touches the scoped global bank must follow that rule. Project writes default to the resolved user, project, and agent tags and must carry the exact current project tag when project scoping is active.

Centralize tag resolution and merging for the retain tools, the automatic project Memorizer, and review edits. Preserve existing provenance tags and deduplicate the final list. Keep automatic retention on the project bank. Review edits send their own retain request. Store resolved tags with new review records and reuse that snapshot, including an explicitly empty snapshot. For legacy records, use the original document tags or resolve from the recorded project and bank. Keep a review edit in its original scope even when it is performed from another checkout. [Retain client](../src/hindsight.ts) · [Tools](../src/tools.ts) · [Automatic retention](../src/memorize.ts) · [Review edits](../src/review-docs.ts)

Use observation scopes that preserve the complete effective tag set on scoped writes. Audit existing observation settings and derived tags during migration. An observation derived from an owned memory needs to preserve ownership, and an observation derived from shared memory needs the shared marker. [Hindsight observation scopes](https://hindsight.vectorize.io/developer/api/retain#observation_scopes)

## Recall request construction

With no additional filters, global recall for Amy sends `tags: ["user:amy", "scope:shared"]` with `tags_match: "any_strict"`. Project recall sends `tags: ["project:my-app"]` with `tags_match: "all_strict"`. The project scope accepts other user and agent tags whenever the required project tag is present.

With `recallFilters`, use Hindsight `tag_groups`. The first group enforces scope. A second `any_strict` group requires at least one configured filter tag. Omit the second group when the list is empty. Hindsight ANDs the groups and accepts either flat `tags` or `tag_groups` in a request. `tags_match: "any"` with only `user:amy` admits completely untagged memories and misses shared memories carrying descriptive tags. The marker lets those memories satisfy both groups. [Hindsight Recall API](https://hindsight.vectorize.io/developer/api/recall#tag_groups) · [Hindsight v0.9.1 request schema](https://github.com/vectorize-io/hindsight/blob/v0.9.1/hindsight-api-slim/hindsight_api/api/http.py#L298)

```json
{
  "tag_groups": [
    { "tags": ["user:amy", "scope:shared"], "match": "any_strict" },
    { "tags": ["topic:engineering", "type:preference"], "match": "any_strict" }
  ]
}
```

Apply the same builder to manual project recall, `/mem-recall`, ordinary and deep automatic recall, and the Memorizer’s duplicate and invalidation lookup. Keep the existing relevance, budgets, and routing. Apply scope to reflect where the target server enforces it across every enabled source. If the target cannot enforce it, report that scoped synthesis is unavailable. [Automatic recall](../src/recall.ts) · [Commands](../src/commands.ts) · [Hindsight Reflect API](https://hindsight.vectorize.io/developer/api/reflect)

For the global prompt block, apply the same scope to query markers. The bare marker uses a list endpoint that supports flat tag filters in v0.9.1. Use the scoped list when flat matching expresses the whole predicate. Require a query marker when additional filters need compound matching and the deployed list endpoint lacks it. A stored mental model is eligible only when its generation policy is known to enforce the same predicate. Preserve epoch-boundary refresh and clear a cached block when the bank, identity, or policy changes. [Global prompt block](../src/index.ts) · [v0.9.1 list route](https://github.com/vectorize-io/hindsight/blob/v0.9.1/hindsight-api-slim/hindsight_api/api/http.py#L3937) · [Mental models](https://hindsight.vectorize.io/developer/api/mental-models)

## Migration and rollout

1. Dry-run an inventory of global documents and effective memory tags. Count shared records missing the marker and owned records carrying it. Include untagged and metadata-tagged rows. Inventory project records that lack the current project tag or have conflicting project tags.
2. Coordinate the backfill with all global writers and pending jobs. Add or remove the marker using the effective ownership tags and preserve existing metadata. Use the supported tag-update API where the deployed version allows it. Verify propagation to memory units, including entity-derived tags if used. Rebuild affected observations and verify their tags before cutover. [Hindsight document updates](https://hindsight.vectorize.io/developer/api/documents)
3. Backfill the project tag where ownership is established by a dedicated bank, recorded provenance, or an explicit mapping. Unresolved project rows stay outside strict recall. Run the inventory again to verify the migration is repeatable, then enable each bank’s policy independently.

## Verification

Use a disposable bank to test all expected cases. For Amy, shared rows `[]`, `["agent:pi"]`, and `["topic:engineering"]` become eligible after marker normalization. Rows with `user:amy` are eligible even when another user tag is also present. Bob-only rows stay excluded even with descriptive tags. With the filters in the example, shared engineering and Amy preference rows qualify, while completely untagged shared rows and Bob engineering rows are excluded. For projects, cover the correct, wrong, and missing project tags, with user and agent tags varied independently.

Assert request bodies across the tool, command, automatic, deep, invalidation, prompt-block, and reflect paths. Cover review edits from another checkout, explicit empty arrays, legacy config, missing identity, unsupported capabilities, cache invalidation, and adding or removing the last ownership tag. Re-run the migration twice and verify that the second run produces no tag changes. Test retrieval with a small token budget and highly ranked ineligible rows to confirm scope is applied before ranking and limits. Run `make check` and verify behavior against the deployed Hindsight version before enabling scope. [Repository quality gates](../Makefile)
