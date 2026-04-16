import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { EdgeType, NodeKind, NodeState } from "@casegraph/core";
import {
  addEdge,
  addNode,
  changeNodeState,
  createCase,
  createDefaultMutationContext,
  initWorkspace,
  recordEventNode
} from "@casegraph/core";

export async function createTempWorkspace(prefix = "casegraph-"): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  await initWorkspace({ workspaceRoot: root, title: "Test Workspace" });
  return root;
}

export async function removeTempWorkspace(root: string): Promise<void> {
  await rm(root, { recursive: true, force: true });
}

export async function seedFixture(
  workspaceRoot: string,
  fixture: {
    case: { case_id: string; title: string; description: string };
    nodes: Array<{ node_id: string; kind: NodeKind; title: string; state: NodeState }>;
    edges: Array<{ edge_id: string; type: EdgeType; source_id: string; target_id: string }>;
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
          metadata: {},
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
          metadata: {},
          extensions: {}
        }
      },
      createDefaultMutationContext()
    );
  }
}

export async function advanceReleaseFixture(workspaceRoot: string, caseId: string): Promise<void> {
  for (const nodeId of ["task_run_regression", "task_update_notes"]) {
    await changeNodeState(
      workspaceRoot,
      { caseId, nodeId, state: "done" },
      createDefaultMutationContext()
    );
  }

  await recordEventNode(
    workspaceRoot,
    { caseId, nodeId: "event_release_live" },
    createDefaultMutationContext()
  );
}

export async function advanceMoveFixture(workspaceRoot: string, caseId: string): Promise<void> {
  await changeNodeState(
    workspaceRoot,
    { caseId, nodeId: "decision_pick_move_date", state: "done" },
    createDefaultMutationContext()
  );
  await recordEventNode(
    workspaceRoot,
    { caseId, nodeId: "event_mover_quote_returned" },
    createDefaultMutationContext()
  );
  await recordEventNode(
    workspaceRoot,
    { caseId, nodeId: "event_lease_confirmed" },
    createDefaultMutationContext()
  );
}
