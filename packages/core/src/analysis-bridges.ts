import {
  collectTopologyComponents,
  projectTopologyGraph,
  type TopologyAnalysisOptions,
  type TopologyProjection
} from "./analysis-topology-shared.js";
import type { CaseStateView, RevisionSnapshot } from "./types.js";

export interface BridgeSummary {
  source_id: string;
  target_id: string;
  left_node_ids: string[];
  right_node_ids: string[];
}

export interface BridgeAnalysisResult {
  case_id: string;
  revision: RevisionSnapshot;
  projection: TopologyProjection;
  goal_node_id: string | null;
  bridge_count: number;
  bridges: BridgeSummary[];
  warnings: string[];
}

export function analyzeBridges(
  state: CaseStateView,
  options: TopologyAnalysisOptions = {}
): BridgeAnalysisResult {
  const projected = projectTopologyGraph(state, options);
  const baseComponents = collectTopologyComponents(projected.graph);
  const warnings = new Set(projected.graph.warnings);

  if (projected.graph.nodes.size === 0) {
    warnings.add("scope_has_no_unresolved_nodes");
  }

  const bridges: BridgeSummary[] = [];

  for (const component of baseComponents) {
    if (component.node_ids.length < 2) {
      continue;
    }

    const componentNodeIds = new Set(component.node_ids);
    const componentEdges = projected.graph.edges.filter(
      (edge) => componentNodeIds.has(edge.source_id) && componentNodeIds.has(edge.target_id)
    );

    for (const edge of componentEdges) {
      const splitComponents = collectTopologyComponents(projected.graph, {
        allowedNodeIds: componentNodeIds,
        omitEdgeKeys: new Set([edge.key])
      });

      if (splitComponents.length <= 1) {
        continue;
      }

      const sortedComponents = [...splitComponents].sort(compareNodeSets);
      const [leftComponent, rightComponent] = sortedComponents;
      if (!(leftComponent && rightComponent)) {
        continue;
      }

      bridges.push({
        source_id: edge.source_id,
        target_id: edge.target_id,
        left_node_ids: leftComponent.node_ids,
        right_node_ids: rightComponent.node_ids
      });
    }
  }

  bridges.sort(compareBridges);

  return {
    case_id: state.caseRecord.case_id,
    revision: state.caseRecord.case_revision,
    projection: projected.projection,
    goal_node_id: projected.goal_node_id,
    bridge_count: bridges.length,
    bridges,
    warnings: [...warnings].sort((left, right) => left.localeCompare(right))
  };
}

function compareNodeSets(left: { node_ids: string[] }, right: { node_ids: string[] }): number {
  return (left.node_ids[0] ?? "").localeCompare(right.node_ids[0] ?? "");
}

function compareBridges(left: BridgeSummary, right: BridgeSummary): number {
  const leftKey = `${left.source_id}::${left.target_id}`;
  const rightKey = `${right.source_id}::${right.target_id}`;
  return leftKey.localeCompare(rightKey);
}
