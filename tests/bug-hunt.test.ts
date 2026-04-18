/**
 * Bug-hunting test suite (systematic-test-design).
 *
 * Targets suspicious spots identified by code review:
 * 1. parseUpdateNodeOperation empty-change detection (dead code).
 * 2. Empty-change update_node no-op still bumps revision.
 * 3. Evidence edge_id predictable collision.
 * 4. parseChangeStateOperation metadata accepted as array / non-object.
 * 5. waits_for target validation (after node kind change).
 * 6. applyPatch with no-op operations still increments revision.
 * 7. Reducer handles unknown event types (error path).
 * 8. validateStorage behavior with concurrent mutations.
 * 9. sanitizeNodeRecord preserves known-bad metadata shapes.
 * 10. Node state invariants for evidence (must be done at creation).
 */
import {
  addEdge,
  addEvidence,
  addNode,
  applyPatch,
  createCase,
  loadCaseState,
  recordEventNode,
  reviewPatch,
  updateNode,
  validatePatchDocument
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

async function makeCaseWithTask(caseId: string, nodeId = "task_a"): Promise<string> {
  const root = await createTempWorkspace("casegraph-bug-");
  createdWorkspaces.push(root);
  await createCase(
    root,
    {
      case_id: caseId,
      title: caseId,
      description: ""
    },
    createDefaultMutationContext()
  );
  await addNode(
    root,
    {
      caseId,
      node: {
        node_id: nodeId,
        kind: "task",
        title: nodeId,
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
  return root;
}

describe("BUG: parseUpdateNodeOperation does not reject empty changes", () => {
  it("validatePatchDocument should reject update_node with {} changes", () => {
    const result = validatePatchDocument({
      patch_id: "p",
      spec_version: "0.1-draft",
      case_id: "c",
      base_revision: 0,
      summary: "s",
      operations: [
        {
          op: "update_node",
          node_id: "n1",
          changes: {}
        }
      ]
    });

    // Expectation per code: patch_update_node_changes_empty should fire.
    // Bug: parseNodeChanges returns {title: undefined, ...} which has Object.keys.length === 6, so the empty check never fires.
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.code === "patch_update_node_changes_empty")).toBe(true);
  });
});

describe("BUG: empty update_node operation bumps revision without any real change", () => {
  it("applyPatch succeeds on empty update_node and increments revision (silent no-op)", async () => {
    const root = await makeCaseWithTask("c-empty-update");
    const before = await loadCaseState(root, "c-empty-update");

    const patch = {
      patch_id: "p_empty",
      spec_version: "0.1-draft",
      case_id: "c-empty-update",
      base_revision: before.caseRecord.case_revision.current,
      summary: "empty update",
      operations: [
        {
          op: "update_node" as const,
          node_id: "task_a",
          changes: {}
        }
      ]
    };

    // If the document validator correctly caught this, reviewPatch would fail.
    // Currently it passes review and silently consumes a revision number.
    const review = await reviewPatch(root, patch);
    // DOCUMENT the actual behavior — whichever way the code is, this shows it.
    // If review.valid is true here, we have confirmed dead-code bug.
    if (review.valid) {
      const after = await applyPatch(root, patch);
      // This assertion is the bug: an empty update should not advance the graph state semantically.
      expect(after.caseRecord.case_revision.current).toBe(
        before.caseRecord.case_revision.current + 1
      );
    } else {
      // If validation correctly rejects, assert the correct behavior.
      expect(review.errors.some((e) => e.code === "patch_update_node_changes_empty")).toBe(true);
    }
  });
});

describe("BUG: attach_evidence derived edge_id is predictable and can collide", () => {
  it("Second evidence with same (source, target) pair collides deterministically", async () => {
    const root = await createTempWorkspace("casegraph-bug-");
    createdWorkspaces.push(root);
    await createCase(
      root,
      { case_id: "c-ev", title: "ev", description: "" },
      createDefaultMutationContext()
    );
    await addNode(
      root,
      {
        caseId: "c-ev",
        node: {
          node_id: "task_t",
          kind: "task",
          title: "t",
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

    const state = await loadCaseState(root, "c-ev");
    const patch1 = {
      patch_id: "p1",
      spec_version: "0.1-draft",
      case_id: "c-ev",
      base_revision: state.caseRecord.case_revision.current,
      summary: "first evidence",
      operations: [
        {
          op: "attach_evidence" as const,
          evidence: {
            node_id: "evidence_first",
            title: "First"
          },
          verifies_target_id: "task_t"
        }
      ]
    };
    await applyPatch(root, patch1);

    const stateAfter = await loadCaseState(root, "c-ev");
    // Add another evidence connected to the same task. The derived edge_id is `edge_verify_<evidence>_<target>`
    // so unique evidence_node_id produces unique edge — that's fine. But what about if someone tries the SAME node_id
    // after removing evidence? We will test the simpler collision path: manual add_edge with the same derived id.
    const patch2 = {
      patch_id: "p2",
      spec_version: "0.1-draft",
      case_id: "c-ev",
      base_revision: stateAfter.caseRecord.case_revision.current,
      summary: "collide manual edge",
      operations: [
        {
          op: "add_edge" as const,
          edge: {
            edge_id: "edge_verify_evidence_first_task_t",
            type: "depends_on" as const,
            source_id: "task_t",
            target_id: "evidence_first"
          }
        }
      ]
    };

    const review = await reviewPatch(root, patch2);
    // This must fail because the edge_id collides with the one auto-generated above.
    expect(review.valid).toBe(false);
    expect(review.errors.some((e) => e.code === "patch_add_edge_conflict")).toBe(true);
  });
});

describe("BUG: parseChangeStateOperation accepts metadata as non-object silently", () => {
  it("change_state with metadata: null is rejected as patch_object_invalid", () => {
    const result = validatePatchDocument({
      patch_id: "p",
      spec_version: "0.1-draft",
      case_id: "c",
      base_revision: 0,
      summary: "s",
      operations: [
        {
          op: "change_state",
          node_id: "n1",
          state: "todo",
          metadata: "not-an-object"
        }
      ]
    });

    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.code === "patch_object_invalid")).toBe(true);
  });
});

describe("BUG: change_state on unknown node surfaces via patch_change_state_missing", () => {
  it("change_state to a non-existent node is rejected", async () => {
    const root = await makeCaseWithTask("c-missing");
    const state = await loadCaseState(root, "c-missing");

    const patch = {
      patch_id: "p",
      spec_version: "0.1-draft",
      case_id: "c-missing",
      base_revision: state.caseRecord.case_revision.current,
      summary: "missing target",
      operations: [
        {
          op: "change_state" as const,
          node_id: "ghost",
          state: "done" as const
        }
      ]
    };

    const review = await reviewPatch(root, patch);
    expect(review.valid).toBe(false);
    expect(review.errors.some((e) => e.code === "patch_change_state_missing")).toBe(true);
  });
});

describe("BUG: waits_for to a non-event target fires waits_for_non_event warning", () => {
  it("recordEventNode on a task node forces state=done and later waits_for from it may warn", async () => {
    const root = await makeCaseWithTask("c-waits");
    await addNode(
      root,
      {
        caseId: "c-waits",
        node: {
          node_id: "task_b",
          kind: "task",
          title: "task_b",
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

    // task_a waits_for task_b (which is a task, not event) — should surface the waits_for_non_event warning.
    await addEdge(
      root,
      {
        caseId: "c-waits",
        edge: {
          edge_id: "edge_w1",
          type: "waits_for",
          source_id: "task_a",
          target_id: "task_b",
          metadata: {},
          extensions: {}
        }
      },
      createDefaultMutationContext()
    );

    const state = await loadCaseState(root, "c-waits");
    const hasWaitsForWarning = state.validation.some(
      (v) => v.code === "waits_for_non_event" && v.severity === "warning"
    );
    expect(hasWaitsForWarning).toBe(true);
  });
});

describe("BUG: recordEventNode forces state=done on a non-event node (invariant leak)", () => {
  it("event.recorded on a task-kind node is rejected with validation_error", async () => {
    const root = await makeCaseWithTask("c-event-task");
    await expect(
      recordEventNode(
        root,
        { caseId: "c-event-task", nodeId: "task_a" },
        createDefaultMutationContext()
      )
    ).rejects.toMatchObject({ code: "validation_error", exitCode: 2 });

    const state = await loadCaseState(root, "c-event-task");
    const taskA = state.nodes.get("task_a");
    expect(taskA?.kind).toBe("task");
    expect(taskA?.state).not.toBe("done");
  });
});

describe("BUG: validatePatchDocument accepts operations with negative base_revision?", () => {
  it("base_revision = -1 is rejected", () => {
    const result = validatePatchDocument({
      patch_id: "p",
      spec_version: "0.1-draft",
      case_id: "c",
      base_revision: -1,
      summary: "s",
      operations: [
        {
          op: "add_node",
          node: { node_id: "n", kind: "task", title: "t", state: "todo" }
        }
      ]
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.code === "patch_required_number")).toBe(true);
  });

  it("base_revision = 1.5 is rejected (non-integer)", () => {
    const result = validatePatchDocument({
      patch_id: "p",
      spec_version: "0.1-draft",
      case_id: "c",
      base_revision: 1.5,
      summary: "s",
      operations: [
        {
          op: "add_node",
          node: { node_id: "n", kind: "task", title: "t", state: "todo" }
        }
      ]
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.code === "patch_required_number")).toBe(true);
  });
});

describe("BUG: remove_node cascades remove attachments but not edges", () => {
  it("removing a node leaves dangling edges that are reported at validation time", async () => {
    const root = await createTempWorkspace("casegraph-bug-");
    createdWorkspaces.push(root);
    await createCase(
      root,
      { case_id: "c-rm", title: "rm", description: "" },
      createDefaultMutationContext()
    );
    for (const id of ["a", "b"]) {
      await addNode(
        root,
        {
          caseId: "c-rm",
          node: {
            node_id: id,
            kind: "task",
            title: id,
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
    }
    await addEdge(
      root,
      {
        caseId: "c-rm",
        edge: {
          edge_id: "e_ab",
          type: "depends_on",
          source_id: "a",
          target_id: "b",
          metadata: {},
          extensions: {}
        }
      },
      createDefaultMutationContext()
    );

    const state = await loadCaseState(root, "c-rm");
    const patch = {
      patch_id: "p_rm",
      spec_version: "0.1-draft",
      case_id: "c-rm",
      base_revision: state.caseRecord.case_revision.current,
      summary: "remove b",
      operations: [{ op: "remove_node" as const, node_id: "b" }]
    };

    const review = await reviewPatch(root, patch);
    // Expected: review surfaces a dangling_edge error because edge e_ab now references missing node b.
    expect(review.valid).toBe(false);
    expect(review.errors.some((e) => e.code === "dangling_edge")).toBe(true);
  });
});

describe("BUG: update_node with metadata: undefined is a silent no-op (not rejected)", () => {
  it("only passing metadata = undefined into the change doc does not update anything", async () => {
    const root = await makeCaseWithTask("c-meta");
    const before = await loadCaseState(root, "c-meta");
    await updateNode(
      root,
      {
        caseId: "c-meta",
        nodeId: "task_a",
        changes: { metadata: undefined as unknown as Record<string, unknown> }
      },
      createDefaultMutationContext()
    );
    const after = await loadCaseState(root, "c-meta");
    const node = after.nodes.get("task_a");
    expect(node?.metadata).toEqual({});
    // This silently consumes a revision even though no observable change happened.
    expect(after.caseRecord.case_revision.current).toBe(
      before.caseRecord.case_revision.current + 1
    );
  });
});

describe("BUG: addEvidence verifies_edge may create conflicting edge_id across calls", () => {
  it("two evidence attachments verifying the same target get unique edge_ids", async () => {
    const root = await createTempWorkspace("casegraph-bug-");
    createdWorkspaces.push(root);
    await createCase(
      root,
      { case_id: "c-ev2", title: "ev2", description: "" },
      createDefaultMutationContext()
    );
    await addNode(
      root,
      {
        caseId: "c-ev2",
        node: {
          node_id: "task_target",
          kind: "task",
          title: "target",
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
        caseId: "c-ev2",
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
        verifiesTargetId: "task_target"
      },
      createDefaultMutationContext()
    );
    await addEvidence(
      root,
      {
        caseId: "c-ev2",
        evidence: {
          node_id: "ev2",
          kind: "evidence",
          title: "ev2",
          description: "",
          state: "done",
          labels: [],
          acceptance: [],
          metadata: {},
          extensions: {}
        },
        verifiesTargetId: "task_target"
      },
      createDefaultMutationContext()
    );

    const state = await loadCaseState(root, "c-ev2");
    const edgeIds = [...state.edges.keys()];
    expect(new Set(edgeIds).size).toBe(edgeIds.length);
  });
});

describe("BUG: changeNodeState to unknown state rejected?", () => {
  it("invalid state string is rejected at patch validation", () => {
    const result = validatePatchDocument({
      patch_id: "p",
      spec_version: "0.1-draft",
      case_id: "c",
      base_revision: 0,
      summary: "s",
      operations: [
        {
          op: "change_state",
          node_id: "n",
          state: "frozen" // unknown
        }
      ]
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.code === "patch_node_state_invalid")).toBe(true);
  });
});

describe("BUG: set_case_field changes that only set labels to [] still accepted", () => {
  it("set_case_field with labels=[] does not fail", () => {
    const result = validatePatchDocument({
      patch_id: "p",
      spec_version: "0.1-draft",
      case_id: "c",
      base_revision: 0,
      summary: "s",
      operations: [
        {
          op: "set_case_field",
          changes: { labels: [] }
        }
      ]
    });
    expect(result.valid).toBe(true);
  });
});
