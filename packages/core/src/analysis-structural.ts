import {
  collectTopologyComponents,
  type SimpleUndirectedEdge,
  type TopologyComponentSummary,
  type TopologyGraph
} from "./analysis-topology-shared.js";

export interface StructuralBridgeSummary {
  edge: SimpleUndirectedEdge;
  left_node_ids: string[];
  right_node_ids: string[];
}

export interface StructuralCutpointSummary {
  node_id: string;
  separated_component_node_sets: string[][];
}

interface StructuralComponentResult {
  bridges: StructuralBridgeSummary[];
  cutpoints: StructuralCutpointSummary[];
}

interface StructuralAnalysisState {
  graph: TopologyGraph;
  componentNodeIds: string[];
  componentNodeSet: Set<string>;
  edgeByKey: Map<string, SimpleUndirectedEdge>;
  discoveryByNode: Map<string, number>;
  lowByNode: Map<string, number>;
  parentByNode: Map<string, string | null>;
  childIdsByNode: Map<string, string[]>;
  entryIndexByNode: Map<string, number>;
  subtreeSizeByNode: Map<string, number>;
  articulationChildIdsByNode: Map<string, string[]>;
  preorderNodeIds: string[];
  bridges: StructuralBridgeSummary[];
  discoveryCounter: number;
}

export function collectStructuralBridges(
  graph: TopologyGraph,
  components: TopologyComponentSummary[] = collectTopologyComponents(graph)
): StructuralBridgeSummary[] {
  return components.flatMap((component) => analyzeStructuralComponent(graph, component).bridges);
}

export function collectStructuralCutpoints(
  graph: TopologyGraph,
  components: TopologyComponentSummary[] = collectTopologyComponents(graph)
): StructuralCutpointSummary[] {
  return components.flatMap((component) => analyzeStructuralComponent(graph, component).cutpoints);
}

function analyzeStructuralComponent(
  graph: TopologyGraph,
  component: TopologyComponentSummary
): StructuralComponentResult {
  if (component.node_ids.length < 2) {
    return { bridges: [], cutpoints: [] };
  }

  const rootNodeId = component.node_ids[0];
  if (!rootNodeId) {
    return { bridges: [], cutpoints: [] };
  }

  const state: StructuralAnalysisState = {
    graph,
    componentNodeIds: component.node_ids,
    componentNodeSet: new Set(component.node_ids),
    edgeByKey: new Map(graph.edges.map((edge) => [edge.key, edge])),
    discoveryByNode: new Map<string, number>(),
    lowByNode: new Map<string, number>(),
    parentByNode: new Map<string, string | null>(),
    childIdsByNode: new Map<string, string[]>(),
    entryIndexByNode: new Map<string, number>(),
    subtreeSizeByNode: new Map<string, number>(),
    articulationChildIdsByNode: new Map<string, string[]>(),
    preorderNodeIds: [],
    bridges: [],
    discoveryCounter: 0
  };

  state.parentByNode.set(rootNodeId, null);
  visitStructuralNode(state, rootNodeId);

  return {
    bridges: state.bridges,
    cutpoints: component.node_ids
      .map((nodeId) => summarizeCutpoint(state, nodeId))
      .filter((cutpoint): cutpoint is StructuralCutpointSummary => cutpoint !== null)
  };
}

function visitStructuralNode(state: StructuralAnalysisState, nodeId: string): number {
  markStructuralVisit(state, nodeId);

  let subtreeSize = 1;
  const childIds: string[] = [];

  for (const neighborNodeId of state.graph.adjacency.get(nodeId) ?? []) {
    if (!state.componentNodeSet.has(neighborNodeId)) {
      continue;
    }

    if (!state.discoveryByNode.has(neighborNodeId)) {
      childIds.push(neighborNodeId);
      subtreeSize += visitStructuralTreeEdge(state, nodeId, neighborNodeId);
      continue;
    }

    if (neighborNodeId !== getStructuralParentNodeId(state, nodeId)) {
      recordStructuralBackEdge(state, nodeId, neighborNodeId);
    }
  }

  finalizeStructuralNode(state, nodeId, childIds, subtreeSize);
  return subtreeSize;
}

function markStructuralVisit(state: StructuralAnalysisState, nodeId: string): void {
  state.discoveryCounter += 1;
  state.discoveryByNode.set(nodeId, state.discoveryCounter);
  state.lowByNode.set(nodeId, state.discoveryCounter);
  state.entryIndexByNode.set(nodeId, state.preorderNodeIds.length);
  state.preorderNodeIds.push(nodeId);
}

function visitStructuralTreeEdge(
  state: StructuralAnalysisState,
  nodeId: string,
  childNodeId: string
): number {
  state.parentByNode.set(childNodeId, nodeId);

  const childSubtreeSize = visitStructuralNode(state, childNodeId);
  const childLow = state.lowByNode.get(childNodeId) ?? Number.POSITIVE_INFINITY;
  const nodeDiscovery = state.discoveryByNode.get(nodeId) ?? Number.POSITIVE_INFINITY;

  updateStructuralLowLink(state, nodeId, childLow);

  if (childLow > nodeDiscovery) {
    const edge = state.edgeByKey.get(canonicalEdgeKey(nodeId, childNodeId));
    if (edge) {
      state.bridges.push(summarizeBridge(state, edge, childNodeId));
    }
  }

  if (getStructuralParentNodeId(state, nodeId) !== null && childLow >= nodeDiscovery) {
    const articulationChildIds = state.articulationChildIdsByNode.get(nodeId) ?? [];
    articulationChildIds.push(childNodeId);
    state.articulationChildIdsByNode.set(nodeId, articulationChildIds);
  }

  return childSubtreeSize;
}

function recordStructuralBackEdge(
  state: StructuralAnalysisState,
  nodeId: string,
  neighborNodeId: string
): void {
  const neighborDiscovery = state.discoveryByNode.get(neighborNodeId) ?? Number.POSITIVE_INFINITY;
  updateStructuralLowLink(state, nodeId, neighborDiscovery);
}

function updateStructuralLowLink(
  state: StructuralAnalysisState,
  nodeId: string,
  candidateLow: number
): void {
  const currentLow = state.lowByNode.get(nodeId) ?? Number.POSITIVE_INFINITY;
  state.lowByNode.set(nodeId, Math.min(currentLow, candidateLow));
}

function finalizeStructuralNode(
  state: StructuralAnalysisState,
  nodeId: string,
  childIds: string[],
  subtreeSize: number
): void {
  state.childIdsByNode.set(nodeId, childIds);
  state.subtreeSizeByNode.set(nodeId, subtreeSize);

  if (getStructuralParentNodeId(state, nodeId) === null && childIds.length > 1) {
    state.articulationChildIdsByNode.set(nodeId, [...childIds]);
  }
}

function getStructuralParentNodeId(state: StructuralAnalysisState, nodeId: string): string | null {
  return state.parentByNode.get(nodeId) ?? null;
}

function summarizeBridge(
  state: StructuralAnalysisState,
  edge: SimpleUndirectedEdge,
  childNodeId: string
): StructuralBridgeSummary {
  const childNodeIds = subtreeNodeIds(state, childNodeId);
  const childNodeIdSet = new Set(childNodeIds);
  const remainderNodeIds = state.componentNodeIds.filter((nodeId) => !childNodeIdSet.has(nodeId));
  const partitions = [childNodeIds, remainderNodeIds].sort(compareNodeIdSets);

  return {
    edge,
    left_node_ids: partitions[0] ?? [],
    right_node_ids: partitions[1] ?? []
  };
}

function summarizeCutpoint(
  state: StructuralAnalysisState,
  nodeId: string
): StructuralCutpointSummary | null {
  const articulationChildIds = state.articulationChildIdsByNode.get(nodeId) ?? [];
  if (articulationChildIds.length === 0) {
    return null;
  }

  const separatedComponentNodeSets = articulationChildIds.map((childNodeId) =>
    subtreeNodeIds(state, childNodeId)
  );
  const removedNodeIds = new Set<string>([nodeId]);
  for (const nodeIds of separatedComponentNodeSets) {
    for (const childNodeId of nodeIds) {
      removedNodeIds.add(childNodeId);
    }
  }

  const remainderNodeIds = state.componentNodeIds.filter(
    (candidateNodeId) => !removedNodeIds.has(candidateNodeId)
  );
  if (remainderNodeIds.length > 0) {
    separatedComponentNodeSets.push(remainderNodeIds);
  }

  separatedComponentNodeSets.sort(compareNodeIdSets);

  return {
    node_id: nodeId,
    separated_component_node_sets: separatedComponentNodeSets
  };
}

function subtreeNodeIds(state: StructuralAnalysisState, nodeId: string): string[] {
  const entryIndex = state.entryIndexByNode.get(nodeId) ?? 0;
  const subtreeSize = state.subtreeSizeByNode.get(nodeId) ?? 0;
  return state.preorderNodeIds
    .slice(entryIndex, entryIndex + subtreeSize)
    .sort((left, right) => left.localeCompare(right));
}

function compareNodeIdSets(left: string[], right: string[]): number {
  return (left[0] ?? "").localeCompare(right[0] ?? "");
}

function canonicalEdgeKey(leftNodeId: string, rightNodeId: string): string {
  return leftNodeId.localeCompare(rightNodeId) <= 0
    ? `${leftNodeId}::${rightNodeId}`
    : `${rightNodeId}::${leftNodeId}`;
}
