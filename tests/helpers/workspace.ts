import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { EdgeType, NodeKind, NodeState } from "@caphtech/casegraph-core";
import {
  addEdge,
  addNode,
  changeNodeState,
  createCase,
  createDefaultMutationContext,
  initWorkspace,
  recordEventNode
} from "@caphtech/casegraph-core";

export async function createTempWorkspace(prefix = "casegraph-"): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  await initWorkspace({ workspaceRoot: root, title: "Test Workspace" });
  return root;
}

export async function removeTempWorkspace(root: string): Promise<void> {
  await rm(root, { recursive: true, force: true });
}

export type FixtureAction =
  | {
      op: "change_state";
      node_id: string;
      state: NodeState;
    }
  | {
      op: "record_event";
      node_id: string;
    };

export async function seedFixture(
  workspaceRoot: string,
  fixture: {
    case: { case_id: string; title: string; description: string };
    nodes: Array<{
      node_id: string;
      kind: NodeKind;
      title: string;
      state: NodeState;
      metadata?: Record<string, unknown>;
    }>;
    edges: Array<{
      edge_id: string;
      type: EdgeType;
      source_id: string;
      target_id: string;
      metadata?: Record<string, unknown>;
    }>;
  }
): Promise<void> {
  await createCase(workspaceRoot, fixture.case, createDefaultMutationContext());

  for (const node of fixture.nodes) {
    await addNode(
      workspaceRoot,
      {
        caseId: fixture.case.case_id,
        node: {
          node_id: node.node_id,
          kind: node.kind,
          title: node.title,
          description: "",
          state: node.state,
          labels: [],
          acceptance: [],
          metadata: node.metadata ?? {},
          extensions: {}
        }
      },
      createDefaultMutationContext()
    );
  }

  for (const edge of fixture.edges) {
    await addEdge(
      workspaceRoot,
      {
        caseId: fixture.case.case_id,
        edge: {
          edge_id: edge.edge_id,
          type: edge.type,
          source_id: edge.source_id,
          target_id: edge.target_id,
          metadata: edge.metadata ?? {},
          extensions: {}
        }
      },
      createDefaultMutationContext()
    );
  }
}

export async function advanceReleaseFixture(workspaceRoot: string, caseId: string): Promise<void> {
  await applyFixtureActions(workspaceRoot, caseId, [
    { op: "change_state", node_id: "task_run_regression", state: "done" },
    { op: "change_state", node_id: "task_update_notes", state: "done" },
    { op: "record_event", node_id: "event_release_live" }
  ]);
}

export async function advanceMoveFixture(workspaceRoot: string, caseId: string): Promise<void> {
  await applyFixtureActions(workspaceRoot, caseId, [
    { op: "change_state", node_id: "decision_pick_move_date", state: "done" },
    { op: "record_event", node_id: "event_mover_quote_returned" },
    { op: "record_event", node_id: "event_lease_confirmed" }
  ]);
}

export async function applyFixtureActions(
  workspaceRoot: string,
  caseId: string,
  actions: FixtureAction[]
): Promise<void> {
  for (const action of actions) {
    if (action.op === "change_state") {
      await changeNodeState(
        workspaceRoot,
        { caseId, nodeId: action.node_id, state: action.state },
        createDefaultMutationContext()
      );
      continue;
    }

    await recordEventNode(
      workspaceRoot,
      { caseId, nodeId: action.node_id },
      createDefaultMutationContext()
    );
  }
}
