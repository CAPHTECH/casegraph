import { CaseGraphError } from "./errors.js";
import { estimateMinutesValue } from "./helpers.js";
import { getFrontier } from "./reducer.js";
import type {
  CaseStateView,
  CriticalPathAnalysisResult,
  CriticalPathSummary,
  EdgeRecord,
  ImpactAnalysisResult,
  ImpactedNodeSummary,
  NodeRecord
} from "./types.js";

const HARD_DEPENDENCY_TYPES = new Set(["depends_on", "waits_for"]);
const UNRESOLVED_STATES = new Set(["todo", "doing", "waiting", "failed"]);

interface TraversalEdge {
  edge_id: string;
  node_id: string;
}

interface TraceRecord {
  distance: number;
  via_node_ids: string[];
  via_edge_ids: string[];
}

interface ScopedHardGraph {
  nodes: Map<string, NodeRecord>;
  adjacency: Map<string, TraversalEdge[]>;
  edge_lookup: Map<string, EdgeRecord>;
}

interface PathCandidate {
  node_ids: string[];
  edge_ids: string[];
  estimate_complete: boolean;
  total_estimate_minutes: number | null;
}

type PathComparator = (left: PathCandidate, right: PathCandidate) => number;

export function analyzeImpact(state: CaseStateView, sourceNodeId: string): ImpactAnalysisResult {
  const sourceNode = state.nodes.get(sourceNodeId);
  if (!sourceNode) {
    throw new CaseGraphError("node_not_found", `Node ${sourceNodeId} not found`, {
      exitCode: 3
    });
  }

  const reverseHardAdjacency = buildReverseAdjacency(state.edges);
  const contextAdjacency = buildContextAdjacency(state.edges);
  const hardImpactTrace = bfsTraces([sourceNodeId], reverseHardAdjacency);
  const hardImpactIds = [...hardImpactTrace.keys()]
    .filter((nodeId) => nodeId !== sourceNodeId)
    .sort((left, right) => compareTrace(left, right, hardImpactTrace));
  const seedTrace = new Map<string, TraceRecord>([
    [sourceNodeId, { distance: 0, via_node_ids: [sourceNodeId], via_edge_ids: [] }]
  ]);
  for (const [nodeId, trace] of hardImpactTrace.entries()) {
    seedTrace.set(nodeId, trace);
  }
  const contextTrace = bfsTraces([sourceNodeId, ...hardImpactIds], contextAdjacency, seedTrace);
  const contextSeedIds = new Set<string>([sourceNodeId, ...hardImpactIds]);
  const contextImpactIds = [...contextTrace.keys()]
    .filter((nodeId) => !contextSeedIds.has(nodeId))
    .sort((left, right) => compareTrace(left, right, contextTrace));
  const frontierIds = new Set(getFrontier(state).map((node) => node.node_id));
  const frontierInvalidationIds = hardImpactIds.filter((nodeId) => frontierIds.has(nodeId));

  return {
    case_id: state.caseRecord.case_id,
    revision: state.caseRecord.case_revision,
    source_node_id: sourceNodeId,
    hard_impact: hardImpactIds.map((nodeId) =>
      summarizeImpactedNode(getNodeOrThrow(state, nodeId), getTraceOrThrow(hardImpactTrace, nodeId))
    ),
    context_impact: contextImpactIds.map((nodeId) =>
      summarizeImpactedNode(getNodeOrThrow(state, nodeId), getTraceOrThrow(contextTrace, nodeId))
    ),
    frontier_invalidations: frontierInvalidationIds.map((nodeId) =>
      summarizeImpactedNode(getNodeOrThrow(state, nodeId), getTraceOrThrow(hardImpactTrace, nodeId))
    ),
    warnings: collectImpactWarnings(state, [sourceNodeId, ...hardImpactIds, ...contextImpactIds])
  };
}

export function analyzeCriticalPath(
  state: CaseStateView,
  goalNodeId?: string
): CriticalPathAnalysisResult {
  const scopedGraph = buildScopedHardGraph(state, goalNodeId);
  const cycleNodes = new Set(
    state.validation
      .filter((issue) => issue.code === "hard_dependency_cycle" && issue.ref)
      .map((issue) => issue.ref as string)
  );
  const scopedCycleNodes = [...scopedGraph.nodes.keys()]
    .filter((nodeId) => cycleNodes.has(nodeId))
    .sort();
  if (scopedCycleNodes.length > 0) {
    throw new CaseGraphError(
      "analysis_cycle_present",
      "Critical path scope contains a hard cycle",
      {
        exitCode: 2,
        details: { node_ids: scopedCycleNodes }
      }
    );
  }

  const missingEstimateNodeIds = [...scopedGraph.nodes.values()]
    .filter((node) => node.kind !== "event" && estimateMinutesValue(node) === null)
    .map((node) => node.node_id)
    .sort((left, right) => left.localeCompare(right));

  const topologicalOrder = stableTopologicalOrder(scopedGraph);
  const depthPathCandidate = longestPathByDepth(scopedGraph, topologicalOrder);
  const durationPathCandidate = longestPathByDuration(scopedGraph, topologicalOrder);

  const warnings: string[] = [];
  if (scopedGraph.nodes.size === 0) {
    warnings.push("scope_has_no_unresolved_nodes");
  }
  if (missingEstimateNodeIds.length > 0) {
    warnings.push("missing_estimates_present");
  }
  if (durationPathCandidate.node_ids.length === 0 && missingEstimateNodeIds.length > 0) {
    warnings.push("duration_path_unavailable_due_to_missing_estimates");
  }

  return {
    case_id: state.caseRecord.case_id,
    revision: state.caseRecord.case_revision,
    goal_node_id: goalNodeId ?? null,
    depth_path: summarizePath(scopedGraph, depthPathCandidate),
    duration_path:
      durationPathCandidate.node_ids.length > 0
        ? summarizePath(scopedGraph, durationPathCandidate)
        : null,
    missing_estimate_node_ids: missingEstimateNodeIds,
    warnings
  };
}

function buildReverseAdjacency(edges: Map<string, EdgeRecord>): Map<string, TraversalEdge[]> {
  const adjacency = new Map<string, TraversalEdge[]>();

  for (const edge of edges.values()) {
    if (!HARD_DEPENDENCY_TYPES.has(edge.type)) {
      continue;
    }

    if (!adjacency.has(edge.target_id)) {
      adjacency.set(edge.target_id, []);
    }

    adjacency.get(edge.target_id)?.push({
      edge_id: edge.edge_id,
      node_id: edge.source_id
    });
  }

  return sortAdjacency(adjacency);
}

function buildContextAdjacency(edges: Map<string, EdgeRecord>): Map<string, TraversalEdge[]> {
  const adjacency = new Map<string, TraversalEdge[]>();

  for (const edge of edges.values()) {
    if (edge.type !== "contributes_to") {
      continue;
    }

    if (!adjacency.has(edge.source_id)) {
      adjacency.set(edge.source_id, []);
    }

    adjacency.get(edge.source_id)?.push({
      edge_id: edge.edge_id,
      node_id: edge.target_id
    });
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

function bfsTraces(
  startNodeIds: string[],
  adjacency: Map<string, TraversalEdge[]>,
  seedTrace: Map<string, TraceRecord> = new Map()
): Map<string, TraceRecord> {
  const result = new Map(seedTrace);
  const queue = startNodeIds
    .filter((nodeId, index, values) => values.indexOf(nodeId) === index)
    .sort((left, right) => {
      const leftTrace = result.get(left);
      const rightTrace = result.get(right);
      if (leftTrace && rightTrace && leftTrace.distance !== rightTrace.distance) {
        return leftTrace.distance - rightTrace.distance;
      }
      return left.localeCompare(right);
    });

  for (const nodeId of queue) {
    if (!result.has(nodeId)) {
      result.set(nodeId, {
        distance: 0,
        via_node_ids: [nodeId],
        via_edge_ids: []
      });
    }
  }

  while (queue.length > 0) {
    const currentNodeId = queue.shift() as string;
    const currentTrace = result.get(currentNodeId) as TraceRecord;
    for (const edge of adjacency.get(currentNodeId) ?? []) {
      if (result.has(edge.node_id)) {
        continue;
      }
      result.set(edge.node_id, {
        distance: currentTrace.distance + 1,
        via_node_ids: [...currentTrace.via_node_ids, edge.node_id],
        via_edge_ids: [...currentTrace.via_edge_ids, edge.edge_id]
      });
      queue.push(edge.node_id);
    }
  }

  return result;
}

function compareTrace(
  leftNodeId: string,
  rightNodeId: string,
  traces: Map<string, TraceRecord>
): number {
  const leftTrace = traces.get(leftNodeId) as TraceRecord;
  const rightTrace = traces.get(rightNodeId) as TraceRecord;
  if (leftTrace.distance !== rightTrace.distance) {
    return leftTrace.distance - rightTrace.distance;
  }

  return leftNodeId.localeCompare(rightNodeId);
}

function summarizeImpactedNode(node: NodeRecord, trace: TraceRecord): ImpactedNodeSummary {
  return {
    node_id: node.node_id,
    kind: node.kind,
    state: node.state,
    title: node.title,
    distance: trace.distance,
    via_node_ids: trace.via_node_ids,
    via_edge_ids: trace.via_edge_ids
  };
}

function collectImpactWarnings(state: CaseStateView, scopedNodeIds: string[]): string[] {
  const cycleNodes = new Set(
    state.validation
      .filter((issue) => issue.code === "hard_dependency_cycle" && issue.ref)
      .map((issue) => issue.ref as string)
  );
  if (scopedNodeIds.some((nodeId) => cycleNodes.has(nodeId))) {
    return ["hard_dependency_cycle_present"];
  }
  return [];
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

function getTraceOrThrow(traces: Map<string, TraceRecord>, nodeId: string): TraceRecord {
  const trace = traces.get(nodeId);
  if (!trace) {
    throw new CaseGraphError("analysis_trace_missing", `Missing analysis trace for ${nodeId}`, {
      exitCode: 2
    });
  }
  return trace;
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

  const allUnresolvedNodes = [...state.nodes.values()].filter(isUnresolvedNode);
  const unresolvedById = new Map(allUnresolvedNodes.map((node) => [node.node_id, node]));
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
  const edgeLookup = new Map<string, EdgeRecord>();
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
    edgeLookup.set(edge.edge_id, edge);
  }

  return {
    nodes,
    adjacency: sortAdjacency(adjacency),
    edge_lookup: edgeLookup
  };
}

function collectGoalScopedNodeIds(
  state: CaseStateView,
  goalNodeId: string,
  unresolvedById: Map<string, NodeRecord>
): string[] {
  const scoped = collectReachableNodeIds(
    [goalNodeId],
    buildContributingSourceAdjacency(state.edges)
  );
  expandScopeWithUnresolvedDependents(
    scoped,
    buildHardDependencySourceAdjacency(state.edges),
    unresolvedById
  );
  return [...scoped].sort((left, right) => left.localeCompare(right));
}

function isUnresolvedNode(node: NodeRecord): boolean {
  return UNRESOLVED_STATES.has(node.state);
}

function stableTopologicalOrder(graph: ScopedHardGraph): string[] {
  const indegree = new Map<string, number>([...graph.nodes.keys()].map((nodeId) => [nodeId, 0]));
  for (const edges of graph.adjacency.values()) {
    for (const edge of edges) {
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
    throw new CaseGraphError(
      "analysis_cycle_present",
      "Critical path scope contains a hard cycle",
      {
        exitCode: 2
      }
    );
  }

  return order;
}

function longestPathByDepth(graph: ScopedHardGraph, order: string[]): PathCandidate {
  return findBestPathCandidate(graph, order, comparePathCandidates, false);
}

function longestPathByDuration(graph: ScopedHardGraph, order: string[]): PathCandidate {
  return findBestPathCandidate(graph, order, compareDurationCandidates, true);
}

function buildContributingSourceAdjacency(edges: Map<string, EdgeRecord>): Map<string, string[]> {
  return buildStringAdjacency(
    edges,
    (edge) => edge.type === "contributes_to",
    "target_id",
    "source_id"
  );
}

function buildHardDependencySourceAdjacency(edges: Map<string, EdgeRecord>): Map<string, string[]> {
  return buildStringAdjacency(
    edges,
    (edge) => HARD_DEPENDENCY_TYPES.has(edge.type),
    "source_id",
    "target_id"
  );
}

function buildStringAdjacency(
  edges: Map<string, EdgeRecord>,
  include: (edge: EdgeRecord) => boolean,
  fromKey: "source_id" | "target_id",
  toKey: "source_id" | "target_id"
): Map<string, string[]> {
  const adjacency = new Map<string, string[]>();
  for (const edge of edges.values()) {
    if (!include(edge)) {
      continue;
    }
    const fromId = edge[fromKey];
    const toId = edge[toKey];
    if (!adjacency.has(fromId)) {
      adjacency.set(fromId, []);
    }
    adjacency.get(fromId)?.push(toId);
  }

  for (const [nodeId, linkedNodeIds] of adjacency.entries()) {
    linkedNodeIds.sort((left, right) => left.localeCompare(right));
    adjacency.set(nodeId, linkedNodeIds);
  }

  return adjacency;
}

function collectReachableNodeIds(
  startNodeIds: string[],
  adjacency: Map<string, string[]>
): Set<string> {
  const visited = new Set<string>();
  const queue = [...startNodeIds];
  while (queue.length > 0) {
    const currentNodeId = queue.shift() as string;
    for (const adjacentNodeId of adjacency.get(currentNodeId) ?? []) {
      if (visited.has(adjacentNodeId)) {
        continue;
      }
      visited.add(adjacentNodeId);
      queue.push(adjacentNodeId);
    }
  }

  return visited;
}

function expandScopeWithUnresolvedDependents(
  scoped: Set<string>,
  adjacency: Map<string, string[]>,
  unresolvedById: Map<string, NodeRecord>
): void {
  const stack = [...scoped].sort((left, right) => left.localeCompare(right));
  while (stack.length > 0) {
    const currentNodeId = stack.pop() as string;
    for (const dependentNodeId of adjacency.get(currentNodeId) ?? []) {
      if (!shouldAddScopedNode(scoped, unresolvedById, dependentNodeId)) {
        continue;
      }
      scoped.add(dependentNodeId);
      stack.push(dependentNodeId);
    }
  }
}

function shouldAddScopedNode(
  scoped: Set<string>,
  unresolvedById: Map<string, NodeRecord>,
  nodeId: string
): boolean {
  return unresolvedById.has(nodeId) && !scoped.has(nodeId);
}

function findBestPathCandidate(
  graph: ScopedHardGraph,
  order: string[],
  compare: PathComparator,
  requireEstimateComplete: boolean
): PathCandidate {
  const bestByNode = new Map<string, PathCandidate>();
  let bestOverall = emptyPathCandidate();

  for (const nodeId of order) {
    const normalizedBest = getSeedPathCandidate(
      graph,
      nodeId,
      bestByNode,
      compare,
      requireEstimateComplete
    );
    if (!normalizedBest) {
      continue;
    }

    bestByNode.set(nodeId, normalizedBest);
    bestOverall = preferPathCandidate(bestOverall, normalizedBest, compare);
    bestOverall = propagatePathCandidates(
      graph,
      nodeId,
      normalizedBest,
      bestByNode,
      bestOverall,
      compare,
      requireEstimateComplete
    );
  }

  return bestOverall;
}

function getSeedPathCandidate(
  graph: ScopedHardGraph,
  nodeId: string,
  bestByNode: Map<string, PathCandidate>,
  compare: PathComparator,
  requireEstimateComplete: boolean
): PathCandidate | null {
  const node = graph.nodes.get(nodeId) as NodeRecord;
  const fallback = buildSingleNodeCandidate(node);
  if (!isEligiblePathCandidate(fallback, requireEstimateComplete)) {
    return null;
  }
  return preferPathCandidate(bestByNode.get(nodeId), fallback, compare);
}

function propagatePathCandidates(
  graph: ScopedHardGraph,
  nodeId: string,
  seedCandidate: PathCandidate,
  bestByNode: Map<string, PathCandidate>,
  bestOverall: PathCandidate,
  compare: PathComparator,
  requireEstimateComplete: boolean
): PathCandidate {
  let nextBestOverall = bestOverall;
  for (const edge of graph.adjacency.get(nodeId) ?? []) {
    const nextNode = graph.nodes.get(edge.node_id) as NodeRecord;
    const candidate = appendNodeToCandidate(seedCandidate, nextNode, edge.edge_id);
    if (!isEligiblePathCandidate(candidate, requireEstimateComplete)) {
      continue;
    }

    bestByNode.set(
      edge.node_id,
      preferPathCandidate(bestByNode.get(edge.node_id), candidate, compare)
    );
    nextBestOverall = preferPathCandidate(nextBestOverall, candidate, compare);
  }

  return nextBestOverall;
}

function isEligiblePathCandidate(
  candidate: PathCandidate,
  requireEstimateComplete: boolean
): boolean {
  return !requireEstimateComplete || candidate.estimate_complete;
}

function preferPathCandidate(
  current: PathCandidate | undefined,
  candidate: PathCandidate,
  compare: PathComparator
): PathCandidate {
  if (!current) {
    return candidate;
  }
  return compare(candidate, current) > 0 ? candidate : current;
}

function summarizePath(graph: ScopedHardGraph, candidate: PathCandidate): CriticalPathSummary {
  return {
    node_ids: candidate.node_ids,
    edge_ids: candidate.edge_ids,
    hop_count: Math.max(0, candidate.node_ids.length - 1),
    total_estimate_minutes: candidate.total_estimate_minutes,
    steps: candidate.node_ids.map((nodeId) => {
      const node = graph.nodes.get(nodeId) as NodeRecord;
      return {
        node_id: node.node_id,
        kind: node.kind,
        state: node.state,
        title: node.title,
        estimate_minutes: estimateMinutesValue(node)
      };
    })
  };
}

function buildSingleNodeCandidate(node: NodeRecord): PathCandidate {
  const estimate = estimateMinutesValue(node);
  return {
    node_ids: [node.node_id],
    edge_ids: [],
    estimate_complete: estimate !== null,
    total_estimate_minutes: estimate
  };
}

function appendNodeToCandidate(
  candidate: PathCandidate,
  node: NodeRecord,
  edgeId: string
): PathCandidate {
  const estimate = estimateMinutesValue(node);
  const estimateComplete = candidate.estimate_complete && estimate !== null;
  return {
    node_ids: [...candidate.node_ids, node.node_id],
    edge_ids: [...candidate.edge_ids, edgeId],
    estimate_complete: estimateComplete,
    total_estimate_minutes:
      estimateComplete && candidate.total_estimate_minutes !== null && estimate !== null
        ? candidate.total_estimate_minutes + estimate
        : null
  };
}

function emptyPathCandidate(): PathCandidate {
  return {
    node_ids: [],
    edge_ids: [],
    estimate_complete: true,
    total_estimate_minutes: 0
  };
}

function comparePathCandidates(left: PathCandidate, right: PathCandidate): number {
  const hopDelta = left.node_ids.length - right.node_ids.length;
  if (hopDelta !== 0) {
    return hopDelta;
  }

  const leftEstimate = left.total_estimate_minutes ?? Number.NEGATIVE_INFINITY;
  const rightEstimate = right.total_estimate_minutes ?? Number.NEGATIVE_INFINITY;
  if (leftEstimate !== rightEstimate) {
    return leftEstimate - rightEstimate;
  }

  const leftKey = left.node_ids.join("\u0000");
  const rightKey = right.node_ids.join("\u0000");
  return rightKey.localeCompare(leftKey);
}

function compareDurationCandidates(left: PathCandidate, right: PathCandidate): number {
  const leftEstimate = left.total_estimate_minutes ?? Number.NEGATIVE_INFINITY;
  const rightEstimate = right.total_estimate_minutes ?? Number.NEGATIVE_INFINITY;
  if (leftEstimate !== rightEstimate) {
    return leftEstimate - rightEstimate;
  }

  return comparePathCandidates(left, right);
}
