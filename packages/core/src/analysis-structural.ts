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

  const componentNodeSet = new Set(component.node_ids);
  const edgeByKey = new Map(graph.edges.map((edge) => [edge.key, edge]));
  const discoveryByNode = new Map<string, number>();
  const lowByNode = new Map<string, number>();
  const parentByNode = new Map<string, string | null>();
  const childIdsByNode = new Map<string, string[]>();
  const entryIndexByNode = new Map<string, number>();
  const subtreeSizeByNode = new Map<string, number>();
  const articulationChildIdsByNode = new Map<string, string[]>();
  const preorderNodeIds: string[] = [];
  const bridges: StructuralBridgeSummary[] = [];
  let discoveryCounter = 0;

  const rootNodeId = component.node_ids[0];
  if (!rootNodeId) {
    return { bridges: [], cutpoints: [] };
  }

  parentByNode.set(rootNodeId, null);
  depthFirstSearch(rootNodeId);

  const cutpoints = component.node_ids
    .map((nodeId) => summarizeCutpoint(nodeId))
    .filter((cutpoint): cutpoint is StructuralCutpointSummary => cutpoint !== null);

  return {
    bridges,
    cutpoints
  };

  function depthFirstSearch(nodeId: string): number {
    discoveryCounter += 1;
    discoveryByNode.set(nodeId, discoveryCounter);
    lowByNode.set(nodeId, discoveryCounter);
    entryIndexByNode.set(nodeId, preorderNodeIds.length);
    preorderNodeIds.push(nodeId);

    let subtreeSize = 1;
    const childIds: string[] = [];

    for (const neighborNodeId of graph.adjacency.get(nodeId) ?? []) {
      if (!componentNodeSet.has(neighborNodeId)) {
        continue;
      }

      const parentNodeId = parentByNode.get(nodeId) ?? null;
      if (!discoveryByNode.has(neighborNodeId)) {
        parentByNode.set(neighborNodeId, nodeId);
        childIds.push(neighborNodeId);

        const childSubtreeSize = depthFirstSearch(neighborNodeId);
        subtreeSize += childSubtreeSize;

        const nextLow = Math.min(
          lowByNode.get(nodeId) ?? Number.POSITIVE_INFINITY,
          lowByNode.get(neighborNodeId) ?? Number.POSITIVE_INFINITY
        );
        lowByNode.set(nodeId, nextLow);

        const nodeDiscovery = discoveryByNode.get(nodeId) ?? Number.POSITIVE_INFINITY;
        const childLow = lowByNode.get(neighborNodeId) ?? Number.POSITIVE_INFINITY;
        if (childLow > nodeDiscovery) {
          const edge = edgeByKey.get(canonicalEdgeKey(nodeId, neighborNodeId));
          if (edge) {
            bridges.push(summarizeBridge(edge, neighborNodeId));
          }
        }
        if (parentNodeId !== null && childLow >= nodeDiscovery) {
          const articulationChildIds = articulationChildIdsByNode.get(nodeId) ?? [];
          articulationChildIds.push(neighborNodeId);
          articulationChildIdsByNode.set(nodeId, articulationChildIds);
        }
        continue;
      }

      if (neighborNodeId === parentNodeId) {
        continue;
      }

      const nextLow = Math.min(
        lowByNode.get(nodeId) ?? Number.POSITIVE_INFINITY,
        discoveryByNode.get(neighborNodeId) ?? Number.POSITIVE_INFINITY
      );
      lowByNode.set(nodeId, nextLow);
    }

    childIdsByNode.set(nodeId, childIds);
    subtreeSizeByNode.set(nodeId, subtreeSize);

    if ((parentByNode.get(nodeId) ?? null) === null && childIds.length > 1) {
      articulationChildIdsByNode.set(nodeId, [...childIds]);
    }

    return subtreeSize;
  }

  function summarizeBridge(
    edge: SimpleUndirectedEdge,
    childNodeId: string
  ): StructuralBridgeSummary {
    const childNodeIds = subtreeNodeIds(childNodeId);
    const childNodeIdSet = new Set(childNodeIds);
    const remainderNodeIds = component.node_ids.filter((nodeId) => !childNodeIdSet.has(nodeId));
    const partitions = [childNodeIds, remainderNodeIds].sort(compareNodeIdSets);

    return {
      edge,
      left_node_ids: partitions[0] ?? [],
      right_node_ids: partitions[1] ?? []
    };
  }

  function summarizeCutpoint(nodeId: string): StructuralCutpointSummary | null {
    const articulationChildIds = articulationChildIdsByNode.get(nodeId) ?? [];
    if (articulationChildIds.length === 0) {
      return null;
    }

    const separatedComponentNodeSets = articulationChildIds.map((childNodeId) =>
      subtreeNodeIds(childNodeId)
    );
    const removedNodeIds = new Set<string>([nodeId]);
    for (const nodeIds of separatedComponentNodeSets) {
      for (const nodeId of nodeIds) {
        removedNodeIds.add(nodeId);
      }
    }

    const remainderNodeIds = component.node_ids.filter(
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

  function subtreeNodeIds(nodeId: string): string[] {
    const entryIndex = entryIndexByNode.get(nodeId) ?? 0;
    const subtreeSize = subtreeSizeByNode.get(nodeId) ?? 0;
    return preorderNodeIds
      .slice(entryIndex, entryIndex + subtreeSize)
      .sort((left, right) => left.localeCompare(right));
  }
}

function compareNodeIdSets(left: string[], right: string[]): number {
  return (left[0] ?? "").localeCompare(right[0] ?? "");
}

function canonicalEdgeKey(leftNodeId: string, rightNodeId: string): string {
  return leftNodeId.localeCompare(rightNodeId) <= 0
    ? `${leftNodeId}::${rightNodeId}`
    : `${rightNodeId}::${leftNodeId}`;
}
