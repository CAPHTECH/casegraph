import { CaseGraphError } from "./errors.js";
import type {
  CaseStateView,
  EdgeRecord,
  NodeKind,
  NodeRecord,
  NodeState,
  RevisionSnapshot
} from "./types.js";

type HardDependencyType = "depends_on" | "waits_for";

const HARD_DEPENDENCY_TYPES = new Set<EdgeRecord["type"]>(["depends_on", "waits_for"]);

interface TraversalEdge {
  edge_id: string;
  node_id: string;
  type: HardDependencyType;
}

export type MinimalUnblockBlockerKind = "actionable_leaf" | "wait_leaf" | "state_leaf";

export interface MinimalUnblockBlockerSummary {
  node_id: string;
  kind: MinimalUnblockBlockerKind;
  node_kind: NodeKind;
  state: NodeState;
  title: string;
  distance: number;
  via_node_ids: string[];
  via_edge_ids: string[];
  actionable: boolean;
}

export interface MinimalUnblockSetResult {
  case_id: string;
  revision: RevisionSnapshot;
  target_node_id: string;
  actionable_leaf_node_ids: string[];
  blockers: MinimalUnblockBlockerSummary[];
  warnings: string[];
}

export function analyzeMinimalUnblockSet(
  state: CaseStateView,
  targetNodeId: string
): MinimalUnblockSetResult {
  const targetNode = state.nodes.get(targetNodeId);
  if (!targetNode) {
    throw new CaseGraphError("node_not_found", `Node ${targetNodeId} not found`, {
      exitCode: 3
    });
  }

  const targetDerived = state.derived.get(targetNodeId);
  if (targetDerived?.is_ready === true) {
    return {
      case_id: state.caseRecord.case_id,
      revision: state.caseRecord.case_revision,
      target_node_id: targetNodeId,
      actionable_leaf_node_ids: [],
      blockers: [],
      warnings: ["target_already_ready"]
    };
  }

  const hardAdjacency = buildHardAdjacency(state.edges);
  assertAcyclicScope(targetNodeId, hardAdjacency);

  const blockerById = new Map<string, MinimalUnblockBlockerSummary>();
  collectLeafBlockers(state, targetNodeId, hardAdjacency, [targetNodeId], [], null, blockerById);

  const blockers = [...blockerById.values()].sort(compareBlockers);
  const actionableLeafNodeIds = blockers
    .filter((blocker) => blocker.actionable)
    .map((blocker) => blocker.node_id)
    .sort((left, right) => left.localeCompare(right));

  return {
    case_id: state.caseRecord.case_id,
    revision: state.caseRecord.case_revision,
    target_node_id: targetNodeId,
    actionable_leaf_node_ids: actionableLeafNodeIds,
    blockers,
    warnings: collectWarnings(blockers)
  };
}

function buildHardAdjacency(edges: Map<string, EdgeRecord>): Map<string, TraversalEdge[]> {
  const adjacency = new Map<string, TraversalEdge[]>();

  for (const edge of edges.values()) {
    if (!isHardDependencyType(edge.type)) {
      continue;
    }

    if (!adjacency.has(edge.source_id)) {
      adjacency.set(edge.source_id, []);
    }

    adjacency.get(edge.source_id)?.push({
      edge_id: edge.edge_id,
      node_id: edge.target_id,
      type: edge.type
    });
  }

  for (const [nodeId, neighbors] of adjacency.entries()) {
    neighbors.sort(compareTraversalEdges);
    adjacency.set(nodeId, neighbors);
  }

  return adjacency;
}

function isHardDependencyType(type: EdgeRecord["type"]): type is HardDependencyType {
  return HARD_DEPENDENCY_TYPES.has(type);
}

function assertAcyclicScope(targetNodeId: string, adjacency: Map<string, TraversalEdge[]>): void {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const stack: string[] = [];

  function visit(nodeId: string): void {
    if (visited.has(nodeId)) {
      return;
    }
    if (visiting.has(nodeId)) {
      const cycleStart = stack.indexOf(nodeId);
      const cyclePath = [...stack.slice(cycleStart), nodeId];
      throw new CaseGraphError(
        "analysis_cycle_present",
        "Minimal unblock scope contains a hard cycle",
        {
          exitCode: 2,
          details: { node_ids: cyclePath }
        }
      );
    }

    visiting.add(nodeId);
    stack.push(nodeId);

    for (const edge of adjacency.get(nodeId) ?? []) {
      visit(edge.node_id);
    }

    stack.pop();
    visiting.delete(nodeId);
    visited.add(nodeId);
  }

  visit(targetNodeId);
}

function collectLeafBlockers(
  state: CaseStateView,
  nodeId: string,
  adjacency: Map<string, TraversalEdge[]>,
  pathNodeIds: string[],
  pathEdgeIds: string[],
  incomingEdgeType: TraversalEdge["type"] | null,
  blockerById: Map<string, MinimalUnblockBlockerSummary>
): void {
  const node = getNodeOrThrow(state, nodeId);
  if (node.state === "done") {
    return;
  }

  if (incomingEdgeType === "waits_for") {
    addBlocker(blockerById, summarizeLeaf(node, "wait_leaf", false, pathNodeIds, pathEdgeIds));
    return;
  }

  const derived = state.derived.get(nodeId);
  if (derived?.is_ready === true) {
    addBlocker(blockerById, summarizeLeaf(node, "actionable_leaf", true, pathNodeIds, pathEdgeIds));
    return;
  }

  const unresolvedPrerequisites = (adjacency.get(nodeId) ?? []).filter((edge) => {
    const targetNode = state.nodes.get(edge.node_id);
    return targetNode?.state !== "done";
  });

  if (unresolvedPrerequisites.length > 0) {
    for (const edge of unresolvedPrerequisites) {
      collectLeafBlockers(
        state,
        edge.node_id,
        adjacency,
        [...pathNodeIds, edge.node_id],
        [...pathEdgeIds, edge.edge_id],
        edge.type,
        blockerById
      );
    }
    return;
  }

  addBlocker(blockerById, summarizeLeaf(node, "state_leaf", false, pathNodeIds, pathEdgeIds));
}

function summarizeLeaf(
  node: NodeRecord,
  kind: MinimalUnblockBlockerKind,
  actionable: boolean,
  pathNodeIds: string[],
  pathEdgeIds: string[]
): MinimalUnblockBlockerSummary {
  return {
    node_id: node.node_id,
    kind,
    node_kind: node.kind,
    state: node.state,
    title: node.title,
    distance: pathEdgeIds.length,
    via_node_ids: [...pathNodeIds].reverse(),
    via_edge_ids: [...pathEdgeIds].reverse(),
    actionable
  };
}

function addBlocker(
  blockerById: Map<string, MinimalUnblockBlockerSummary>,
  candidate: MinimalUnblockBlockerSummary
): void {
  const existing = blockerById.get(candidate.node_id);
  if (!existing || compareDuplicateCandidates(candidate, existing) < 0) {
    blockerById.set(candidate.node_id, candidate);
  }
}

function compareDuplicateCandidates(
  left: MinimalUnblockBlockerSummary,
  right: MinimalUnblockBlockerSummary
): number {
  if (left.actionable !== right.actionable) {
    return left.actionable ? -1 : 1;
  }
  if (left.distance !== right.distance) {
    return left.distance - right.distance;
  }

  const kindDelta = blockerKindRank(left.kind) - blockerKindRank(right.kind);
  if (kindDelta !== 0) {
    return kindDelta;
  }

  const viaNodeDelta = compareStringArrays(left.via_node_ids, right.via_node_ids);
  if (viaNodeDelta !== 0) {
    return viaNodeDelta;
  }

  return compareStringArrays(left.via_edge_ids, right.via_edge_ids);
}

function compareBlockers(
  left: MinimalUnblockBlockerSummary,
  right: MinimalUnblockBlockerSummary
): number {
  if (left.actionable !== right.actionable) {
    return left.actionable ? -1 : 1;
  }
  if (left.distance !== right.distance) {
    return left.distance - right.distance;
  }
  return left.node_id.localeCompare(right.node_id);
}

function blockerKindRank(kind: MinimalUnblockBlockerKind): number {
  switch (kind) {
    case "actionable_leaf":
      return 0;
    case "wait_leaf":
      return 1;
    case "state_leaf":
      return 2;
  }
}

function compareTraversalEdges(left: TraversalEdge, right: TraversalEdge): number {
  const nodeDelta = left.node_id.localeCompare(right.node_id);
  if (nodeDelta !== 0) {
    return nodeDelta;
  }

  return left.edge_id.localeCompare(right.edge_id);
}

function compareStringArrays(left: string[], right: string[]): number {
  const maxLength = Math.max(left.length, right.length);
  for (let index = 0; index < maxLength; index += 1) {
    const leftValue = left[index];
    const rightValue = right[index];
    if (leftValue === rightValue) {
      continue;
    }
    if (leftValue === undefined) {
      return -1;
    }
    if (rightValue === undefined) {
      return 1;
    }
    return leftValue.localeCompare(rightValue);
  }
  return 0;
}

function collectWarnings(blockers: MinimalUnblockBlockerSummary[]): string[] {
  const warnings: string[] = [];

  if (blockers.some((blocker) => blocker.kind === "state_leaf" && blocker.state === "waiting")) {
    warnings.push("leaf_waiting_blocker_present");
  }
  if (blockers.some((blocker) => blocker.kind === "state_leaf" && blocker.state === "failed")) {
    warnings.push("leaf_failed_blocker_present");
  }
  if (
    blockers.some(
      (blocker) =>
        blocker.kind === "state_leaf" && blocker.state !== "waiting" && blocker.state !== "failed"
    )
  ) {
    warnings.push("leaf_non_actionable_blocker_present");
  }

  return warnings;
}

function getNodeOrThrow(state: CaseStateView, nodeId: string): NodeRecord {
  const node = state.nodes.get(nodeId);
  if (!node) {
    throw new CaseGraphError("node_not_found", `Node ${nodeId} not found`, {
      exitCode: 3
    });
  }
  return node;
}
