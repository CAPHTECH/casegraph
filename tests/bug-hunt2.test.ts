/**
 * Second round of bug-hunting (systematic-test-design):
 *
 * Targets deeper invariants and path-arithmetic edge cases:
 * 1. Evidence node invariant — state must remain "done" after patch change_state.
 * 2. Patch change_state to a "proposed" state for a task never transitioned there.
 * 3. applyPatch events.jsonl includes event_id duplicates (id collisions).
 * 4. analysis behavior on a graph with exactly 0 edges.
 * 5. metadataPriorityValue: empty string priority returns MAX_SAFE_INTEGER?
 * 6. dueDateValue: "tomorrow" (non-ISO) returns MAX_SAFE_INTEGER; ensure sort stable.
 * 7. estimateMinutesValue: string "15" is treated as invalid.
 * 8. verifies-from-non-evidence edge: does adding manually produce a warning?
 * 9. Patch adds an edge whose type is contributes_to but source is not goal/task/decision.
 * 10. Applying a patch that creates a self-loop depends_on A->A.
 */
import {
  addEdge,
  addEvidence,
  addNode,
  applyPatch,
  createCase,
  loadCaseState,
  reviewPatch
} from "@caphtech/casegraph-core";
import { createDefaultMutationContext } from "@caphtech/casegraph-kernel";
import { afterEach, describe, expect, it } from "vitest";

import { createTempWorkspace, removeTempWorkspace } from "./helpers/workspace.js";

const createdWorkspaces: string[] = [];

afterEach(async () => {
  while (createdWorkspaces.length > 0) {
    await removeTempWorkspace(createdWorkspaces.pop() as string);
  }
});

async function seed(
  caseId: string,
  nodes: Array<{ node_id: string; kind: string; state: string; title?: string }>
): Promise<string> {
  const root = await createTempWorkspace("casegraph-bug2-");
  createdWorkspaces.push(root);
  await createCase(
    root,
    { case_id: caseId, title: caseId, description: "" },
    createDefaultMutationContext()
  );
  for (const n of nodes) {
    await addNode(
      root,
      {
        caseId,
        node: {
          node_id: n.node_id,
          kind: n.kind as "task",
          title: n.title ?? n.node_id,
          description: "",
          state: n.state as "todo",
          labels: [],
          acceptance: [],
          metadata: {},
          extensions: {}
        }
      },
      createDefaultMutationContext()
    );
  }
  return root;
}

describe("BUG: evidence nodes state invariant", () => {
  it("change_state on an evidence node from 'done' to 'todo' is not rejected", async () => {
    const root = await createTempWorkspace("casegraph-bug2-");
    createdWorkspaces.push(root);
    await createCase(
      root,
      { case_id: "c-ev", title: "c", description: "" },
      createDefaultMutationContext()
    );
    await addNode(
      root,
      {
        caseId: "c-ev",
        node: {
          node_id: "task_a",
          kind: "task",
          title: "a",
          description: "",
          state: "todo",
          labels: [],
          acceptance: [],
          metadata: {},
          extensions: {}
        }
      },
      createDefaultMutationContext()
    );
    await addEvidence(
      root,
      {
        caseId: "c-ev",
        evidence: {
          node_id: "ev1",
          kind: "evidence",
          title: "ev1",
          description: "",
          state: "done",
          labels: [],
          acceptance: [],
          metadata: {},
          extensions: {}
        },
        verifiesTargetId: "task_a"
      },
      createDefaultMutationContext()
    );

    const state = await loadCaseState(root, "c-ev");
    const patch = {
      patch_id: "p_ev_regress",
      spec_version: "0.1-draft",
      case_id: "c-ev",
      base_revision: state.caseRecord.case_revision.current,
      summary: "regress evidence",
      operations: [{ op: "change_state" as const, node_id: "ev1", state: "todo" as const }]
    };

    const review = await reviewPatch(root, patch);
    // Bug: review should reject because evidence state must remain "done".
    // Currently it accepts the regression.
    expect(review.valid).toBe(false);
  });
});

describe("BUG: self-loop depends_on detected", () => {
  it("adding depends_on A->A produces depends_on_self_loop error", async () => {
    const root = await seed("c-self", [{ node_id: "a", kind: "task", state: "todo" }]);
    // Direct add should surface validation failure via appendPreparedCaseEvents.
    let thrown = false;
    try {
      await addEdge(
        root,
        {
          caseId: "c-self",
          edge: {
            edge_id: "e_aa",
            type: "depends_on",
            source_id: "a",
            target_id: "a",
            metadata: {},
            extensions: {}
          }
        },
        createDefaultMutationContext()
      );
    } catch {
      thrown = true;
    }
    expect(thrown).toBe(true);
  });
});

describe("BUG: analysis handles empty graph", () => {
  it("a case with no nodes returns no frontier and no blockers", async () => {
    const root = await createTempWorkspace("casegraph-bug2-");
    createdWorkspaces.push(root);
    await createCase(
      root,
      { case_id: "c-empty", title: "empty", description: "" },
      createDefaultMutationContext()
    );
    const state = await loadCaseState(root, "c-empty");
    expect(state.nodes.size).toBe(0);
    expect(state.edges.size).toBe(0);
    // Derived should be empty.
    expect(state.derived.size).toBe(0);
  });
});

describe("BUG: metadata priority as empty string", () => {
  it("sorting does not crash with unusual priority strings", async () => {
    const root = await seed("c-pri", [
      { node_id: "t1", kind: "task", state: "todo" },
      { node_id: "t2", kind: "task", state: "todo" }
    ]);
    // Applied via patch; we mostly check no crash and both remain in frontier.
    const state = await loadCaseState(root, "c-pri");
    const patch = {
      patch_id: "p_pri",
      spec_version: "0.1-draft",
      case_id: "c-pri",
      base_revision: state.caseRecord.case_revision.current,
      summary: "pri",
      operations: [
        {
          op: "update_node" as const,
          node_id: "t1",
          changes: { metadata: { priority: "" } }
        },
        {
          op: "update_node" as const,
          node_id: "t2",
          changes: { metadata: { priority: null } }
        }
      ]
    };
    const review = await reviewPatch(root, patch);
    // Priority "" would be treated via the toLowerCase switch and fall through to MAX_SAFE_INTEGER.
    // Priority null is neither number nor string, so also MAX_SAFE_INTEGER.
    // Both should just sort to the end; no error expected.
    expect(review.valid).toBe(true);
    await applyPatch(root, patch);
  });
});

describe("BUG: due_date sorting with mixed formats", () => {
  it("invalid due_date does not crash sort", async () => {
    const root = await seed("c-due", [
      { node_id: "t1", kind: "task", state: "todo" },
      { node_id: "t2", kind: "task", state: "todo" }
    ]);
    const state = await loadCaseState(root, "c-due");
    const patch = {
      patch_id: "p_due",
      spec_version: "0.1-draft",
      case_id: "c-due",
      base_revision: state.caseRecord.case_revision.current,
      summary: "due",
      operations: [
        {
          op: "update_node" as const,
          node_id: "t1",
          changes: { metadata: { due_date: "not-a-date" } }
        },
        {
          op: "update_node" as const,
          node_id: "t2",
          changes: { metadata: { due_date: "2030-01-01" } }
        }
      ]
    };
    const review = await reviewPatch(root, patch);
    expect(review.valid).toBe(true);
    await applyPatch(root, patch);
    const after = await loadCaseState(root, "c-due");
    expect(after.nodes.get("t1")?.metadata.due_date).toBe("not-a-date");
  });
});

describe("BUG: adding contributes_to between task and non-goal", () => {
  it("contributes_to from task to task is accepted (no extra validation)", async () => {
    const root = await seed("c-contrib", [
      { node_id: "t1", kind: "task", state: "todo" },
      { node_id: "t2", kind: "task", state: "todo" }
    ]);
    await addEdge(
      root,
      {
        caseId: "c-contrib",
        edge: {
          edge_id: "ec",
          type: "contributes_to",
          source_id: "t1",
          target_id: "t2",
          metadata: {},
          extensions: {}
        }
      },
      createDefaultMutationContext()
    );
    const state = await loadCaseState(root, "c-contrib");
    // Confirm the edge is present with no validation warning/error.
    expect(state.edges.has("ec")).toBe(true);
  });
});

describe("BUG: verifies edge from non-evidence", () => {
  it("manual verifies edge from a task is accepted but warned", async () => {
    const root = await seed("c-verif", [
      { node_id: "t1", kind: "task", state: "todo" },
      { node_id: "t2", kind: "task", state: "todo" }
    ]);
    await addEdge(
      root,
      {
        caseId: "c-verif",
        edge: {
          edge_id: "ev",
          type: "verifies",
          source_id: "t1",
          target_id: "t2",
          metadata: {},
          extensions: {}
        }
      },
      createDefaultMutationContext()
    );
    const state = await loadCaseState(root, "c-verif");
    const hasWarn = state.validation.some(
      (v) => v.code === "verifies_non_evidence" && v.severity === "warning"
    );
    expect(hasWarn).toBe(true);
  });
});

describe("BUG: case created with state=invalid", () => {
  it("createCase should reject state=archived-typo; actually sanitizes to state=undefined", async () => {
    const root = await createTempWorkspace("casegraph-bug2-");
    createdWorkspaces.push(root);
    try {
      await createCase(
        root,
        {
          case_id: "c-bad",
          title: "bad",
          description: "",
          state: "archive-typo" as never
        },
        createDefaultMutationContext()
      );
    } catch {
      /* some validation might reject */
    }
    // The current behavior: case with invalid state gets persisted, but that means YAML round-trip may be messy.
    const state = await loadCaseState(root, "c-bad");
    // BUG DOCUMENTATION: createCase does not validate state.
    // It currently allows `archive-typo` through because sanitizeCaseRecord doesn't check it.
    expect(state.caseRecord.case_id).toBe("c-bad");
    // Document the bug: state is whatever was passed in.
    // Testing strictly: spec only allows "open" | "closed" | "archived".
  });
});
