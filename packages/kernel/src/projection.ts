import type { ProjectionNodeSnapshot, ProjectionTargets } from "./sink-types.js";
import type { CaseStateView, NodeRecord } from "./types.js";

const ACTIONABLE_KINDS = new Set<NodeRecord["kind"]>(["task", "decision"]);
const ACTIONABLE_STATES = new Set<NodeRecord["state"]>(["todo", "doing"]);

export function selectProjectionTargets(state: CaseStateView): ProjectionTargets {
  const actionable: ProjectionNodeSnapshot[] = [];
  const waiting: ProjectionNodeSnapshot[] = [];
  const waitingFromEdges = collectWaitingFromEdges(state);

  for (const node of state.nodes.values()) {
    if (node.state === "waiting") {
      waiting.push(toSnapshot(node));
      continue;
    }

    if (
      ACTIONABLE_KINDS.has(node.kind) &&
      ACTIONABLE_STATES.has(node.state) &&
      state.derived.get(node.node_id)?.is_ready === true
    ) {
      actionable.push(toSnapshot(node));
      continue;
    }

    if (waitingFromEdges.has(node.node_id) && !isTerminal(node.state)) {
      waiting.push(toSnapshot(node));
    }
  }

  actionable.sort(compareSnapshots);
  waiting.sort(compareSnapshots);
  return { actionable, waiting };
}

function toSnapshot(node: NodeRecord): ProjectionNodeSnapshot {
  return {
    node_id: node.node_id,
    kind: node.kind,
    state: node.state,
    title: node.title,
    labels: [...node.labels],
    metadata: { ...node.metadata },
    created_at: node.created_at,
    updated_at: node.updated_at
  };
}

function collectWaitingFromEdges(state: CaseStateView): Set<string> {
  const pending = new Set<string>();
  for (const edge of state.edges.values()) {
    if (edge.type !== "waits_for") {
      continue;
    }
    const target = state.nodes.get(edge.target_id);
    if (!target || target.state === "done") {
      continue;
    }
    pending.add(edge.source_id);
  }
  return pending;
}

function isTerminal(nodeState: NodeRecord["state"]): boolean {
  return nodeState === "done" || nodeState === "cancelled" || nodeState === "failed";
}

function compareSnapshots(left: ProjectionNodeSnapshot, right: ProjectionNodeSnapshot): number {
  if (left.kind !== right.kind) {
    return left.kind.localeCompare(right.kind);
  }
  const createdDelta = Date.parse(left.created_at) - Date.parse(right.created_at);
  if (createdDelta !== 0) {
    return createdDelta;
  }
  return left.node_id.localeCompare(right.node_id);
}
