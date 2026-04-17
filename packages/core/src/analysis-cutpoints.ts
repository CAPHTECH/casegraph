import {
  collectTopologyComponents,
  projectTopologyGraph,
  type TopologyAnalysisOptions,
  type TopologyProjection
} from "./analysis-topology-shared.js";
import type { CaseStateView, RevisionSnapshot } from "./types.js";

export interface CutpointSummary {
  node_id: string;
  separated_component_count: number;
  separated_component_node_sets: string[][];
}

export interface CutpointAnalysisResult {
  case_id: string;
  revision: RevisionSnapshot;
  projection: TopologyProjection;
  goal_node_id: string | null;
  cutpoint_count: number;
  cutpoints: CutpointSummary[];
  warnings: string[];
}

export function analyzeCutpoints(
  state: CaseStateView,
  options: TopologyAnalysisOptions = {}
): CutpointAnalysisResult {
  const projected = projectTopologyGraph(state, options);
  const baseComponents = collectTopologyComponents(projected.graph);
  const warnings = new Set(projected.graph.warnings);

  if (projected.graph.nodes.size === 0) {
    warnings.add("scope_has_no_unresolved_nodes");
  }

  const cutpoints: CutpointSummary[] = [];

  for (const component of baseComponents) {
    if (component.node_ids.length < 3) {
      continue;
    }

    const componentNodeIds = new Set(component.node_ids);
    for (const nodeId of component.node_ids) {
      const splitComponents = collectTopologyComponents(projected.graph, {
        allowedNodeIds: componentNodeIds,
        omitNodeIds: new Set([nodeId])
      });

      if (splitComponents.length <= 1) {
        continue;
      }

      cutpoints.push({
        node_id: nodeId,
        separated_component_count: splitComponents.length,
        separated_component_node_sets: splitComponents
          .map((splitComponent) => splitComponent.node_ids)
          .sort(compareNodeSetArrays)
      });
    }
  }

  cutpoints.sort((left, right) => left.node_id.localeCompare(right.node_id));

  return {
    case_id: state.caseRecord.case_id,
    revision: state.caseRecord.case_revision,
    projection: projected.projection,
    goal_node_id: projected.goal_node_id,
    cutpoint_count: cutpoints.length,
    cutpoints,
    warnings: [...warnings].sort((left, right) => left.localeCompare(right))
  };
}

function compareNodeSetArrays(left: string[], right: string[]): number {
  return (left[0] ?? "").localeCompare(right[0] ?? "");
}
