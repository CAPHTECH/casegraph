---
name: casegraph-patch
description: Use when proposing AI-driven graph changes to a CaseGraph workspace as a `GraphPatch`. Trigger on references to `cg patch validate|review|apply`, `GraphPatch`, `base_revision`, `patch.applied`, generator metadata, the `casegraph-patch` fenced-block convention, or phrases like "propose as a patch", "wrap this change into a patch", "base_revision is stale", "apply the patch". Encodes ADR-0003 "AI does not own state". For direct manual edits use casegraph; for importer/sink/worker/recovery use casegraph-integrate.
---

# CaseGraph GraphPatch pipeline

## Overview

Core contract: **AI does not mutate workspace state directly. It proposes a `GraphPatch`.** The patch flows through `validate → review → apply`, and on success lands as a single `patch.applied` event in the event log. This skill fixes the ordering, the `base_revision` contract, and the shape of the patch.

## Workspace resolution

`cg` CLI lookup order: `--workspace` → `CASEGRAPH_WORKSPACE` → walk upward from cwd.

## Output contract and exit codes

`--format json` returns `{ "ok": true, "data": ... }` or `{ "ok": false, "error": { "code": "...", "message": "..." } }`. Exit codes: `0` ok, `2` validation error, `3` not found, `4` conflict (most importantly stale `base_revision`).

## Pipeline

```
patch file (JSON) ──▶ cg patch validate ──▶ cg patch review ──▶ cg patch apply ──▶ patch.applied event
```

Never skip a step. Calling `apply` without `review` silences the stale-revision check and may corrupt the event log.

### 1. validate
```
cg patch validate --case <case_id> --patch <patch.json>
```
Schema integrity only. Does not read workspace state.

### 2. review
```
cg patch review --case <case_id> --patch <patch.json>
```
- Compares the current `revision` to the patch's `base_revision`. Mismatch → conflict (exit 4).
- Dry-runs the operations and reports any validation issues that would arise.
- Any `severity: "error"` issue blocks here, before apply.

### 3. apply
```
cg patch apply --case <case_id> --patch <patch.json>
```
Internally: acquire the workspace lock (`.casegraph/.lock`) → re-read events → replay with the new events appended → abort on any `severity: "error"` issue → append to `events.jsonl` → rewrite `case.yaml` → rebuild the SQLite cache for that case.

Exactly **one** `patch.applied` event is appended, regardless of how many operations the patch contains.

## GraphPatch JSON shape

Patches live as external JSON files.

```json
{
  "patch_id": "patch_01JABC...",
  "case_id": "release-1.8.0",
  "base_revision": 12,
  "generator": {
    "kind": "human | importer | worker | sync | agent",
    "name": "...",
    "version": "..."
  },
  "operations": [
    { "op": "add_node", "node": { "...": "Node" } },
    { "op": "update_node", "node_id": "...", "fields": { "...": "partial" } },
    { "op": "add_edge", "edge": { "...": "Edge" } },
    { "op": "remove_edge", "edge_id": "..." },
    { "op": "add_attachment", "attachment": { "...": "Attachment" } }
  ]
}
```

Full schema: `docs/spec/04-graphpatch.md`.

## base_revision semantics

- The `base_revision` is the case revision the patch was authored against.
- Read the current revision via `cg case show --case <id> --format json`.
- If workspace revision has advanced by the time `apply` runs, the patch is stale (exit 4). Regenerate against the latest state; do not force it through.
- Auto-generated patches from importers, workers, and reverse sync follow the same rule. `cg sync pull` and `cg worker run` rewrite `base_revision` to the *post-audit-event* revision before returning the patch — do not reorder.

## Authoring a patch from Claude

Typical flow when Claude produces a patch from code context:

1. Read current state: `cg case show --case <id> --format json`. Note `revision`, existing nodes, existing edges.
2. Express the intent as a minimal list of `operations`.
3. Fill `patch_id` with a unique ULID-like identifier. `packages/core` exports `generateId()` (`helpers.ts`) if running inside the repo.
4. Set `generator.kind` honestly: `"agent"` when Claude wrote the patch directly; `"worker"` when forwarding a patch returned by a worker plugin.
5. `attachments` reference workspace-local paths. `applyPatch` copies and canonicalizes them after review but before emitting the event — do not pre-assign attachment IDs.

## Fenced-block convention (for AI workers)

When a worker plugin returns a patch on stdout, the agreed form (`docs/spec/07-worker-protocol.md §7.10a`) is a fenced block labeled `casegraph-patch` containing the `GraphPatch` JSON.

Extraction rules:
- Prefer the **last** `casegraph-patch` fence, then the last `json` fence.
- Prose with no fence → worker returns `status: "failed"` and `patch: null`. It does not throw `worker_patch_invalid`.
- Patch present but fails validation (wrong `case_id`, bad shape) → `worker_patch_invalid` (exit 2).

Claude can follow the same convention when emitting patches into a transcript. Running `cg patch review` / `apply` still requires a file path today.

## Anti-patterns

- Appending to `events.jsonl` out of band. The only valid event from AI-driven changes is `patch.applied`.
- Skipping `review`. Stale-revision detection only runs there.
- Forcing `apply` of a stale patch instead of regenerating against the latest revision.
- Bundling unrelated intents into one patch. A single `patch.applied` event is atomic: any op failure rejects the whole patch.
- Declaring `generator.kind: "human"` on an AI-authored patch. Breaks the audit trail.

## Related

- Manual authoring via direct CLI → `casegraph`
- Importers / workers / sinks that emit patches → `casegraph-integrate`
- Spec: `docs/spec/04-graphpatch.md`, `docs/adr/0003-patch-mediated-ai.md`
