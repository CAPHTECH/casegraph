import { CaseGraphError } from "./errors.js";
import { getFrontier } from "./reducer.js";
import type {
  CaseStateView,
  EdgeRecord,
  NodeKind,
  NodeRecord,
  NodeState,
  RevisionSnapshot
} from "./types.js";

const HARD_DEPENDENCY_TYPES = new Set(["depends_on", "waits_for"]);
const UNRESOLVED_STATES = new Set(["todo", "doing", "waiting", "failed"]);

interface TraversalEdge {
  edge_id: string;
  node_id: string;
}

interface ScopedHardGraph {
  nodes: Map<string, NodeRecord>;
  adjacency: Map<string, TraversalEdge[]>;
}

export interface BottleneckNodeSummary {
  node_id: string;
  kind: NodeKind;
  state: NodeState;
  title: string;
  downstream_node_ids: string[];
  downstream_count: number;
  frontier_invalidation_node_ids: string[];
  frontier_invalidation_count: number;
  goal_context_node_ids: string[];
  goal_context_count: number;
  max_distance: number;
}

export interface BottleneckAnalysisResult {
  case_id: string;
  revision: RevisionSnapshot;
  goal_node_id: string | null;
  nodes: BottleneckNodeSummary[];
  warnings: string[];
}

interface QueueEntry {
  distance: number;
  node_id: string;
}

export function analyzeBottlenecks(
  state: CaseStateView,
  goalNodeId?: string
): BottleneckAnalysisResult {
  const scopedGraph = buildScopedHardGraph(state, goalNodeId);
  const scopedCycleNodeIds = collectScopedCycleNodeIds(state, scopedGraph);
  if (scopedCycleNodeIds.length > 0) {
    throw new CaseGraphError("analysis_cycle_present", "Bottleneck scope contains a hard cycle", {
      exitCode: 2,
      details: { node_ids: scopedCycleNodeIds }
    });
  }

  stableTopologicalOrder(scopedGraph);

  const warnings: string[] = [];
  if (goalNodeId && scopedGraph.nodes.size === 0) {
    warnings.push("scope_has_no_unresolved_nodes");
  }

  const frontierNodeIds = new Set(
    getFrontier(state)
      .map((node) => node.node_id)
      .filter((nodeId) => scopedGraph.nodes.has(nodeId))
  );
  const contextAdjacency = buildContextAdjacency(state.edges);

  const nodes = [...scopedGraph.nodes.keys()]
    .sort((left, right) => left.localeCompare(right))
    .map((nodeId) => {
      const node = getNodeOrThrow(scopedGraph.nodes, nodeId);
      const downstreamDistanceByNode = bfsDistances([nodeId], scopedGraph.adjacency);
      const downstreamNodeIds = sortNodeIdsByDistance(downstreamDistanceByNode);
      const frontierInvalidationNodeIds = downstreamNodeIds.filter((downstreamNodeId) =>
        frontierNodeIds.has(downstreamNodeId)
      );
      const goalContextNodeIds = sortNodeIdsByDistance(
        bfsDistances([nodeId, ...downstreamNodeIds], contextAdjacency)
      );

      return {
        node_id: node.node_id,
        kind: node.kind,
        state: node.state,
        title: node.title,
        downstream_node_ids: downstreamNodeIds,
        downstream_count: downstreamNodeIds.length,
        frontier_invalidation_node_ids: frontierInvalidationNodeIds,
        frontier_invalidation_count: frontierInvalidationNodeIds.length,
        goal_context_node_ids: goalContextNodeIds,
        goal_context_count: goalContextNodeIds.length,
        max_distance: maxDistance(downstreamDistanceByNode)
      } satisfies BottleneckNodeSummary;
    })
    .filter(
      (summary) =>
        summary.downstream_count > 0 ||
        summary.frontier_invalidation_count > 0 ||
        summary.goal_context_count > 0
    )
    .sort(compareBottleneckSummaries);

  return {
    case_id: state.caseRecord.case_id,
    revision: state.caseRecord.case_revision,
    goal_node_id: goalNodeId ?? null,
    nodes,
    warnings
  };
}

function buildScopedHardGraph(state: CaseStateView, goalNodeId?: string): ScopedHardGraph {
  const goalNode = goalNodeId ? state.nodes.get(goalNodeId) : null;
  if (goalNodeId && !goalNode) {
    throw new CaseGraphError("node_not_found", `Node ${goalNodeId} not found`, {
      exitCode: 3
    });
  }
  if (goalNode && goalNode.kind !== "goal") {
    throw new CaseGraphError("node_not_goal", `Node ${goalNodeId} is not a goal`, {
      exitCode: 2
    });
  }

  const unresolvedNodes = [...state.nodes.values()].filter(isUnresolvedNode);
  const unresolvedById = new Map(unresolvedNodes.map((node) => [node.node_id, node]));
  const scopedNodeIds = goalNode
    ? collectGoalScopedNodeIds(state, goalNode.node_id, unresolvedById)
    : [...unresolvedById.keys()].sort((left, right) => left.localeCompare(right));

  const nodes = new Map(
    scopedNodeIds
      .map((nodeId) => unresolvedById.get(nodeId))
      .filter((node): node is NodeRecord => Boolean(node))
      .map((node) => [node.node_id, node])
  );

  const adjacency = new Map<string, TraversalEdge[]>();
  for (const nodeId of nodes.keys()) {
    adjacency.set(nodeId, []);
  }

  for (const edge of state.edges.values()) {
    if (!HARD_DEPENDENCY_TYPES.has(edge.type)) {
      continue;
    }
    if (!(nodes.has(edge.source_id) && nodes.has(edge.target_id))) {
      continue;
    }

    adjacency.get(edge.target_id)?.push({
      edge_id: edge.edge_id,
      node_id: edge.source_id
    });
  }

  return {
    nodes,
    adjacency: sortAdjacency(adjacency)
  };
}

function collectGoalScopedNodeIds(
  state: CaseStateView,
  goalNodeId: string,
  unresolvedById: Map<string, NodeRecord>
): string[] {
  const scopedNodeIds = collectContributingNodeIds(
    goalNodeId,
    buildReverseContributionAdjacency(state.edges)
  );
  extendWithHardPrerequisites(state.edges, scopedNodeIds, unresolvedById);
  return [...scopedNodeIds].sort((left, right) => left.localeCompare(right));
}

function buildReverseContributionAdjacency(edges: Map<string, EdgeRecord>): Map<string, string[]> {
  const adjacency = new Map<string, string[]>();

  for (const edge of edges.values()) {
    if (edge.type !== "contributes_to") {
      continue;
    }

    const sourceNodeIds = adjacency.get(edge.target_id) ?? [];
    sourceNodeIds.push(edge.source_id);
    sourceNodeIds.sort((left, right) => left.localeCompare(right));
    adjacency.set(edge.target_id, sourceNodeIds);
  }

  return adjacency;
}

function collectContributingNodeIds(
  goalNodeId: string,
  contributingAdjacency: Map<string, string[]>
): Set<string> {
  const scopedNodeIds = new Set<string>();
  const queue = [goalNodeId];

  while (queue.length > 0) {
    const currentNodeId = queue.shift() as string;
    for (const sourceNodeId of contributingAdjacency.get(currentNodeId) ?? []) {
      if (scopedNodeIds.has(sourceNodeId)) {
        continue;
      }

      scopedNodeIds.add(sourceNodeId);
      queue.push(sourceNodeId);
    }
  }

  return scopedNodeIds;
}

function extendWithHardPrerequisites(
  edges: Map<string, EdgeRecord>,
  scopedNodeIds: Set<string>,
  unresolvedById: Map<string, NodeRecord>
): void {
  const prerequisiteStack = [...scopedNodeIds].sort((left, right) => left.localeCompare(right));

  while (prerequisiteStack.length > 0) {
    const currentNodeId = prerequisiteStack.pop() as string;

    for (const edge of edges.values()) {
      if (!isScopedPrerequisiteEdge(edge, currentNodeId, unresolvedById, scopedNodeIds)) {
        continue;
      }

      scopedNodeIds.add(edge.target_id);
      prerequisiteStack.push(edge.target_id);
    }
  }
}

function isScopedPrerequisiteEdge(
  edge: EdgeRecord,
  currentNodeId: string,
  unresolvedById: Map<string, NodeRecord>,
  scopedNodeIds: Set<string>
): boolean {
  if (!HARD_DEPENDENCY_TYPES.has(edge.type) || edge.source_id !== currentNodeId) {
    return false;
  }

  if (!unresolvedById.has(edge.target_id) || scopedNodeIds.has(edge.target_id)) {
    return false;
  }

  return true;
}

function collectScopedCycleNodeIds(state: CaseStateView, graph: ScopedHardGraph): string[] {
  const cycleNodeIds = new Set(
    state.validation
      .filter((issue) => issue.code === "hard_dependency_cycle" && issue.ref)
      .map((issue) => issue.ref as string)
  );

  return [...graph.nodes.keys()]
    .filter((nodeId) => cycleNodeIds.has(nodeId))
    .sort((left, right) => left.localeCompare(right));
}

function isUnresolvedNode(node: NodeRecord): boolean {
  return UNRESOLVED_STATES.has(node.state);
}

function buildContextAdjacency(edges: Map<string, EdgeRecord>): Map<string, TraversalEdge[]> {
  const adjacency = new Map<string, TraversalEdge[]>();

  for (const edge of edges.values()) {
    if (edge.type !== "contributes_to") {
      continue;
    }

    const current = adjacency.get(edge.source_id) ?? [];
    current.push({
      edge_id: edge.edge_id,
      node_id: edge.target_id
    });
    adjacency.set(edge.source_id, current);
  }

  return sortAdjacency(adjacency);
}

function sortAdjacency(adjacency: Map<string, TraversalEdge[]>): Map<string, TraversalEdge[]> {
  for (const [nodeId, neighbors] of adjacency.entries()) {
    neighbors.sort((left, right) => {
      const nodeDelta = left.node_id.localeCompare(right.node_id);
      if (nodeDelta !== 0) {
        return nodeDelta;
      }
      return left.edge_id.localeCompare(right.edge_id);
    });
    adjacency.set(nodeId, neighbors);
  }

  return adjacency;
}

function bfsDistances(
  startNodeIds: string[],
  adjacency: Map<string, TraversalEdge[]>
): Map<string, number> {
  const uniqueStartNodeIds = [...new Set(startNodeIds)].sort((left, right) =>
    left.localeCompare(right)
  );
  const seen = new Set(uniqueStartNodeIds);
  const queue: QueueEntry[] = uniqueStartNodeIds.map((nodeId) => ({
    distance: 0,
    node_id: nodeId
  }));
  const distanceByNode = new Map<string, number>();

  while (queue.length > 0) {
    const current = queue.shift() as QueueEntry;
    for (const edge of adjacency.get(current.node_id) ?? []) {
      if (seen.has(edge.node_id)) {
        continue;
      }
      const distance = current.distance + 1;
      seen.add(edge.node_id);
      distanceByNode.set(edge.node_id, distance);
      queue.push({
        distance,
        node_id: edge.node_id
      });
    }
  }

  return distanceByNode;
}

function sortNodeIdsByDistance(distanceByNode: Map<string, number>): string[] {
  return [...distanceByNode.keys()].sort((left, right) => {
    const leftDistance = distanceByNode.get(left) as number;
    const rightDistance = distanceByNode.get(right) as number;
    if (leftDistance !== rightDistance) {
      return leftDistance - rightDistance;
    }
    return left.localeCompare(right);
  });
}

function maxDistance(distanceByNode: Map<string, number>): number {
  let result = 0;
  for (const distance of distanceByNode.values()) {
    result = Math.max(result, distance);
  }
  return result;
}

function compareBottleneckSummaries(
  left: BottleneckNodeSummary,
  right: BottleneckNodeSummary
): number {
  if (left.frontier_invalidation_count !== right.frontier_invalidation_count) {
    return right.frontier_invalidation_count - left.frontier_invalidation_count;
  }
  if (left.downstream_count !== right.downstream_count) {
    return right.downstream_count - left.downstream_count;
  }
  if (left.goal_context_count !== right.goal_context_count) {
    return right.goal_context_count - left.goal_context_count;
  }
  if (left.max_distance !== right.max_distance) {
    return right.max_distance - left.max_distance;
  }
  return left.node_id.localeCompare(right.node_id);
}

function stableTopologicalOrder(graph: ScopedHardGraph): string[] {
  const indegree = new Map<string, number>([...graph.nodes.keys()].map((nodeId) => [nodeId, 0]));

  for (const neighbors of graph.adjacency.values()) {
    for (const edge of neighbors) {
      indegree.set(edge.node_id, (indegree.get(edge.node_id) ?? 0) + 1);
    }
  }

  const available = [...graph.nodes.keys()]
    .filter((nodeId) => (indegree.get(nodeId) ?? 0) === 0)
    .sort((left, right) => left.localeCompare(right));
  const order: string[] = [];

  while (available.length > 0) {
    const nodeId = available.shift() as string;
    order.push(nodeId);

    for (const edge of graph.adjacency.get(nodeId) ?? []) {
      const nextIndegree = (indegree.get(edge.node_id) ?? 0) - 1;
      indegree.set(edge.node_id, nextIndegree);
      if (nextIndegree === 0) {
        available.push(edge.node_id);
        available.sort((left, right) => left.localeCompare(right));
      }
    }
  }

  if (order.length !== graph.nodes.size) {
    throw new CaseGraphError("analysis_cycle_present", "Bottleneck scope contains a hard cycle", {
      exitCode: 2
    });
  }

  return order;
}

function getNodeOrThrow(nodes: Map<string, NodeRecord>, nodeId: string): NodeRecord {
  const node = nodes.get(nodeId);
  if (!node) {
    throw new CaseGraphError("node_not_found", `Node ${nodeId} not found`, {
      exitCode: 3
    });
  }
  return node;
}
