import { CaseGraphError } from "./errors.js";
import type { CaseStateView, EdgeRecord, NodeRecord, NodeState } from "./types.js";

const HARD_DEPENDENCY_TYPES = new Set<EdgeRecord["type"]>(["depends_on", "waits_for"]);
const UNRESOLVED_STATES = new Set<NodeState>(["todo", "doing", "waiting", "failed"]);

export type TopologyProjection = "hard_unresolved" | "hard_goal_scope";

export interface TopologyAnalysisOptions {
  projection?: TopologyProjection;
  goalNodeId?: string;
}

export interface TopologyComponentSummary {
  node_ids: string[];
  edge_count: number;
}

export interface TopologyCycleWitnessEdge {
  source_id: string;
  target_id: string;
}

export interface TopologyCycleWitness {
  node_ids: string[];
  edge_pairs: TopologyCycleWitnessEdge[];
}

export interface NormalizedTopologyOptions {
  projection: TopologyProjection;
  goal_node_id: string | null;
}

export interface SimpleUndirectedEdge {
  key: string;
  source_id: string;
  target_id: string;
}

export interface TopologyGraph {
  nodes: Map<string, NodeRecord>;
  adjacency: Map<string, string[]>;
  edges: SimpleUndirectedEdge[];
  warnings: Set<string>;
}

export interface ProjectedTopologyGraph {
  graph: TopologyGraph;
  projection: TopologyProjection;
  goal_node_id: string | null;
}

export interface TopologyComponentTraversalOptions {
  allowedNodeIds?: Set<string>;
  omitEdgeKeys?: Set<string>;
  omitNodeIds?: Set<string>;
}

export function normalizeTopologyOptions(
  options: TopologyAnalysisOptions = {}
): NormalizedTopologyOptions {
  const projection =
    options.projection ?? (options.goalNodeId ? "hard_goal_scope" : "hard_unresolved");

  if (projection === "hard_goal_scope" && !options.goalNodeId) {
    throw new CaseGraphError(
      "analysis_goal_node_required",
      "Topology goal scope requires a goal node id",
      {
        exitCode: 2
      }
    );
  }

  if (projection === "hard_unresolved" && options.goalNodeId) {
    throw new CaseGraphError(
      "analysis_goal_node_invalid_for_projection",
      "Topology hard_unresolved projection does not accept a goal node id",
      {
        exitCode: 2
      }
    );
  }

  return {
    projection,
    goal_node_id: options.goalNodeId ?? null
  };
}

export function projectTopologyGraph(
  state: CaseStateView,
  options: TopologyAnalysisOptions = {}
): ProjectedTopologyGraph {
  const normalizedOptions = normalizeTopologyOptions(options);
  const scopedNodes = collectScopedNodes(state, normalizedOptions);

  return {
    graph: buildSimpleUndirectedGraph(state, scopedNodes),
    projection: normalizedOptions.projection,
    goal_node_id: normalizedOptions.goal_node_id
  };
}

export function collectTopologyComponents(
  graph: TopologyGraph,
  options: TopologyComponentTraversalOptions = {}
): TopologyComponentSummary[] {
  const activeNodeIds = collectActiveNodeIds(graph, options);
  const activeNodeIdSet = new Set(activeNodeIds);
  const visited = new Set<string>();
  const components: TopologyComponentSummary[] = [];

  for (const nodeId of activeNodeIds) {
    if (visited.has(nodeId)) {
      continue;
    }

    const componentNodeIds = collectComponentNodeIds(
      graph,
      nodeId,
      visited,
      activeNodeIdSet,
      options
    );
    componentNodeIds.sort((left, right) => left.localeCompare(right));
    const componentNodeSet = new Set(componentNodeIds);
    const edgeCount = graph.edges.filter((edge) =>
      isActiveEdge(edge, componentNodeSet, options.omitEdgeKeys)
    ).length;

    components.push({
      node_ids: componentNodeIds,
      edge_count: edgeCount
    });
  }

  return components;
}

export function collectCycleWitnesses(
  graph: TopologyGraph,
  components: TopologyComponentSummary[] = collectTopologyComponents(graph)
): TopologyCycleWitness[] {
  const witnesses: TopologyCycleWitness[] = [];
  const witnessKeys = new Set<string>();

  for (const component of components) {
    if (component.edge_count <= component.node_ids.length - 1) {
      continue;
    }

    const componentNodeSet = new Set(component.node_ids);
    const componentEdges = graph.edges.filter((edge) => isActiveEdge(edge, componentNodeSet));
    const { depthByNode, parentByNode, treeEdgeKeys } = buildSpanningTree(
      graph,
      component.node_ids
    );
    const nonTreeEdges = componentEdges.filter((edge) => !treeEdgeKeys.has(edge.key));

    for (const nonTreeEdge of nonTreeEdges) {
      const pathNodeIds = collectTreePath(
        nonTreeEdge.source_id,
        nonTreeEdge.target_id,
        parentByNode,
        depthByNode
      );
      const edgePairs = buildWitnessEdgePairs(pathNodeIds, nonTreeEdge);
      const witnessKey = edgePairs
        .map((edgePair) => edgeKey(edgePair.source_id, edgePair.target_id))
        .sort((left, right) => left.localeCompare(right))
        .join("|");

      if (witnessKeys.has(witnessKey)) {
        continue;
      }

      witnessKeys.add(witnessKey);
      witnesses.push({
        node_ids: [...pathNodeIds].sort((left, right) => left.localeCompare(right)),
        edge_pairs: edgePairs
      });
    }
  }

  return witnesses.sort(compareCycleWitnesses);
}

export function canonicalizeNodePair(leftNodeId: string, rightNodeId: string): [string, string] {
  return leftNodeId.localeCompare(rightNodeId) <= 0
    ? [leftNodeId, rightNodeId]
    : [rightNodeId, leftNodeId];
}

export function edgeKey(leftNodeId: string, rightNodeId: string): string {
  const [sourceId, targetId] = canonicalizeNodePair(leftNodeId, rightNodeId);
  return `${sourceId}::${targetId}`;
}

function collectScopedNodes(
  state: CaseStateView,
  options: NormalizedTopologyOptions
): Map<string, NodeRecord> {
  const unresolvedNodes = [...state.nodes.values()].filter(isUnresolvedNode);
  const unresolvedById = new Map(unresolvedNodes.map((node) => [node.node_id, node]));
  const scopedNodeIds =
    options.projection === "hard_goal_scope"
      ? collectGoalScopedNodeIds(state, options.goal_node_id as string, unresolvedById)
      : [...unresolvedById.keys()].sort((left, right) => left.localeCompare(right));

  return new Map(
    scopedNodeIds
      .map((nodeId) => unresolvedById.get(nodeId))
      .filter((node): node is NodeRecord => Boolean(node))
      .map((node) => [node.node_id, node])
  );
}

function collectGoalScopedNodeIds(
  state: CaseStateView,
  goalNodeId: string,
  unresolvedById: Map<string, NodeRecord>
): string[] {
  const goalNode = state.nodes.get(goalNodeId);
  if (!goalNode) {
    throw new CaseGraphError("node_not_found", `Node ${goalNodeId} not found`, {
      exitCode: 3
    });
  }
  if (goalNode.kind !== "goal") {
    throw new CaseGraphError("node_not_goal", `Node ${goalNodeId} is not a goal`, {
      exitCode: 2
    });
  }

  const scoped = collectReachableNodeIds(
    [goalNodeId],
    buildStringAdjacency(
      state.edges,
      (edge) => edge.type === "contributes_to",
      "target_id",
      "source_id"
    )
  );
  const unresolvedScoped = new Set([...scoped].filter((nodeId) => unresolvedById.has(nodeId)));
  expandScopeWithHardPrerequisites(
    unresolvedScoped,
    buildStringAdjacency(
      state.edges,
      (edge) => HARD_DEPENDENCY_TYPES.has(edge.type),
      "source_id",
      "target_id"
    ),
    unresolvedById
  );

  return [...unresolvedScoped].sort((left, right) => left.localeCompare(right));
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
    const linkedNodeIds = adjacency.get(fromId) ?? [];
    linkedNodeIds.push(edge[toKey]);
    linkedNodeIds.sort((left, right) => left.localeCompare(right));
    adjacency.set(fromId, linkedNodeIds);
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
    for (const nextNodeId of adjacency.get(currentNodeId) ?? []) {
      if (visited.has(nextNodeId)) {
        continue;
      }
      visited.add(nextNodeId);
      queue.push(nextNodeId);
    }
  }

  return visited;
}

function expandScopeWithHardPrerequisites(
  scoped: Set<string>,
  adjacency: Map<string, string[]>,
  unresolvedById: Map<string, NodeRecord>
): void {
  const stack = [...scoped].sort((left, right) => left.localeCompare(right));

  while (stack.length > 0) {
    const currentNodeId = stack.pop() as string;
    for (const prerequisiteNodeId of adjacency.get(currentNodeId) ?? []) {
      if (!unresolvedById.has(prerequisiteNodeId) || scoped.has(prerequisiteNodeId)) {
        continue;
      }
      scoped.add(prerequisiteNodeId);
      stack.push(prerequisiteNodeId);
    }
  }
}

function isUnresolvedNode(node: NodeRecord): boolean {
  return UNRESOLVED_STATES.has(node.state);
}

function buildSimpleUndirectedGraph(
  state: CaseStateView,
  nodes: Map<string, NodeRecord>
): TopologyGraph {
  const adjacency = new Map<string, string[]>();
  const edgeByKey = new Map<string, SimpleUndirectedEdge>();
  const warnings = new Set<string>();

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
    if (edge.source_id === edge.target_id) {
      warnings.add("self_loop_ignored");
      continue;
    }

    const [sourceId, targetId] = canonicalizeNodePair(edge.source_id, edge.target_id);
    const key = edgeKey(sourceId, targetId);
    if (edgeByKey.has(key)) {
      continue;
    }

    edgeByKey.set(key, {
      key,
      source_id: sourceId,
      target_id: targetId
    });
  }

  const edges = [...edgeByKey.values()].sort((left, right) => left.key.localeCompare(right.key));

  for (const edge of edges) {
    adjacency.get(edge.source_id)?.push(edge.target_id);
    adjacency.get(edge.target_id)?.push(edge.source_id);
  }

  for (const [nodeId, neighborIds] of adjacency.entries()) {
    adjacency.set(
      nodeId,
      [...neighborIds].sort((left, right) => left.localeCompare(right))
    );
  }

  return {
    nodes,
    adjacency,
    edges,
    warnings
  };
}

function collectActiveNodeIds(
  graph: TopologyGraph,
  options: TopologyComponentTraversalOptions
): string[] {
  const allowedNodeIds = options.allowedNodeIds ?? new Set(graph.nodes.keys());

  return [...graph.nodes.keys()]
    .filter((nodeId) => allowedNodeIds.has(nodeId) && !options.omitNodeIds?.has(nodeId))
    .sort((left, right) => left.localeCompare(right));
}

function collectComponentNodeIds(
  graph: TopologyGraph,
  startNodeId: string,
  visited: Set<string>,
  activeNodeIds: Set<string>,
  options: TopologyComponentTraversalOptions
): string[] {
  const queue = [startNodeId];
  const componentNodeIds: string[] = [];

  while (queue.length > 0) {
    const currentNodeId = queue.shift() as string;
    if (visited.has(currentNodeId)) {
      continue;
    }
    visited.add(currentNodeId);
    componentNodeIds.push(currentNodeId);

    for (const neighborNodeId of graph.adjacency.get(currentNodeId) ?? []) {
      if (!activeNodeIds.has(neighborNodeId)) {
        continue;
      }
      if (options.omitEdgeKeys?.has(edgeKey(currentNodeId, neighborNodeId))) {
        continue;
      }
      if (!visited.has(neighborNodeId)) {
        queue.push(neighborNodeId);
      }
    }
  }

  return componentNodeIds;
}

function isActiveEdge(
  edge: SimpleUndirectedEdge,
  activeNodeIds: Set<string>,
  omitEdgeKeys?: Set<string>
): boolean {
  if (omitEdgeKeys?.has(edge.key)) {
    return false;
  }
  return activeNodeIds.has(edge.source_id) && activeNodeIds.has(edge.target_id);
}

function buildSpanningTree(
  graph: TopologyGraph,
  nodeIds: string[]
): {
  depthByNode: Map<string, number>;
  parentByNode: Map<string, string | null>;
  treeEdgeKeys: Set<string>;
} {
  const parentByNode = new Map<string, string | null>();
  const depthByNode = new Map<string, number>();
  const treeEdgeKeys = new Set<string>();
  const rootNodeId = nodeIds[0];

  if (!rootNodeId) {
    throw new CaseGraphError(
      "analysis_component_empty",
      "Topology component is unexpectedly empty",
      {
        exitCode: 2
      }
    );
  }

  const stack = [rootNodeId];
  parentByNode.set(rootNodeId, null);
  depthByNode.set(rootNodeId, 0);

  while (stack.length > 0) {
    const currentNodeId = stack.pop() as string;
    const nextDepth = (depthByNode.get(currentNodeId) ?? 0) + 1;
    const neighbors = [...(graph.adjacency.get(currentNodeId) ?? [])].reverse();

    for (const neighborNodeId of neighbors) {
      if (parentByNode.has(neighborNodeId)) {
        continue;
      }

      parentByNode.set(neighborNodeId, currentNodeId);
      depthByNode.set(neighborNodeId, nextDepth);
      treeEdgeKeys.add(edgeKey(currentNodeId, neighborNodeId));
      stack.push(neighborNodeId);
    }
  }

  return {
    depthByNode,
    parentByNode,
    treeEdgeKeys
  };
}

function collectTreePath(
  leftNodeId: string,
  rightNodeId: string,
  parentByNode: Map<string, string | null>,
  depthByNode: Map<string, number>
): string[] {
  const leftPath: string[] = [];
  const rightPath: string[] = [];
  let leftCursor = leftNodeId;
  let rightCursor = rightNodeId;

  while ((depthByNode.get(leftCursor) ?? 0) > (depthByNode.get(rightCursor) ?? 0)) {
    leftPath.push(leftCursor);
    leftCursor = parentOrThrow(parentByNode, leftCursor);
  }

  while ((depthByNode.get(rightCursor) ?? 0) > (depthByNode.get(leftCursor) ?? 0)) {
    rightPath.push(rightCursor);
    rightCursor = parentOrThrow(parentByNode, rightCursor);
  }

  while (leftCursor !== rightCursor) {
    leftPath.push(leftCursor);
    rightPath.push(rightCursor);
    leftCursor = parentOrThrow(parentByNode, leftCursor);
    rightCursor = parentOrThrow(parentByNode, rightCursor);
  }

  return [...leftPath, leftCursor, ...rightPath.reverse()];
}

function buildWitnessEdgePairs(
  pathNodeIds: string[],
  closingEdge: SimpleUndirectedEdge
): TopologyCycleWitnessEdge[] {
  const edgePairs: TopologyCycleWitnessEdge[] = [];

  for (let index = 0; index < pathNodeIds.length - 1; index += 1) {
    const [sourceId, targetId] = canonicalizeNodePair(
      pathNodeIds[index] as string,
      pathNodeIds[index + 1] as string
    );
    edgePairs.push({
      source_id: sourceId,
      target_id: targetId
    });
  }

  edgePairs.push({
    source_id: closingEdge.source_id,
    target_id: closingEdge.target_id
  });

  return edgePairs.sort(compareEdgePairs);
}

function parentOrThrow(parentByNode: Map<string, string | null>, nodeId: string): string {
  const parentNodeId = parentByNode.get(nodeId);
  if (!parentNodeId) {
    throw new CaseGraphError("analysis_tree_path_missing", `Missing tree parent for ${nodeId}`, {
      exitCode: 2
    });
  }

  return parentNodeId;
}

function compareCycleWitnesses(left: TopologyCycleWitness, right: TopologyCycleWitness): number {
  const leftKey = left.edge_pairs
    .map((edgePair) => edgeKey(edgePair.source_id, edgePair.target_id))
    .join("|");
  const rightKey = right.edge_pairs
    .map((edgePair) => edgeKey(edgePair.source_id, edgePair.target_id))
    .join("|");

  return leftKey.localeCompare(rightKey);
}

function compareEdgePairs(left: TopologyCycleWitnessEdge, right: TopologyCycleWitnessEdge): number {
  const sourceDelta = left.source_id.localeCompare(right.source_id);
  if (sourceDelta !== 0) {
    return sourceDelta;
  }

  return left.target_id.localeCompare(right.target_id);
}
