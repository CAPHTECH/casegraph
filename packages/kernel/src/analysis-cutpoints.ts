import {
  buildCutpointExplanations,
  type CutpointRiskExplanation
} from "./analysis-explanations.js";
import { collectStructuralCutpoints } from "./analysis-structural.js";
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
  explanations: CutpointRiskExplanation[];
  warnings: string[];
}

export function analyzeCutpoints(
  state: CaseStateView,
  options: TopologyAnalysisOptions = {}
): CutpointAnalysisResult {
  const projected = projectTopologyGraph(state, options);
  const baseComponents = collectTopologyComponents(projected.graph);
  const warnings = new Set(projected.graph.warnings);

  if (projected.projection === "hard_goal_scope" && projected.graph.nodes.size === 0) {
    warnings.add("scope_has_no_unresolved_nodes");
  }

  const cutpoints = collectStructuralCutpoints(projected.graph, baseComponents).map((cutpoint) => ({
    node_id: cutpoint.node_id,
    separated_component_count: cutpoint.separated_component_node_sets.length,
    separated_component_node_sets: cutpoint.separated_component_node_sets
  }));

  cutpoints.sort((left, right) => left.node_id.localeCompare(right.node_id));
  const warningList = [...warnings].sort((left, right) => left.localeCompare(right));

  return {
    case_id: state.caseRecord.case_id,
    revision: state.caseRecord.case_revision,
    projection: projected.projection,
    goal_node_id: projected.goal_node_id,
    cutpoint_count: cutpoints.length,
    cutpoints,
    explanations: buildCutpointExplanations(
      {
        projection: projected.projection,
        goal_node_id: projected.goal_node_id,
        warnings: warningList
      },
      cutpoints
    ),
    warnings: warningList
  };
}
