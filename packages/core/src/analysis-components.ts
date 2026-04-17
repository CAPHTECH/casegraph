import {
  collectTopologyComponents,
  projectTopologyGraph,
  type TopologyAnalysisOptions,
  type TopologyComponentSummary,
  type TopologyProjection
} from "./analysis-topology-shared.js";
import type { CaseStateView, RevisionSnapshot } from "./types.js";

export interface ComponentSummary extends TopologyComponentSummary {
  node_count: number;
}

export interface ComponentAnalysisResult {
  case_id: string;
  revision: RevisionSnapshot;
  projection: TopologyProjection;
  goal_node_id: string | null;
  component_count: number;
  components: ComponentSummary[];
  warnings: string[];
}

export function analyzeComponents(
  state: CaseStateView,
  options: TopologyAnalysisOptions = {}
): ComponentAnalysisResult {
  const projected = projectTopologyGraph(state, options);
  const components = collectTopologyComponents(projected.graph).map((component) => ({
    ...component,
    node_count: component.node_ids.length
  }));
  const warnings = new Set(projected.graph.warnings);

  if (projected.graph.nodes.size === 0) {
    warnings.add("scope_has_no_unresolved_nodes");
  }

  return {
    case_id: state.caseRecord.case_id,
    revision: state.caseRecord.case_revision,
    projection: projected.projection,
    goal_node_id: projected.goal_node_id,
    component_count: components.length,
    components,
    warnings: [...warnings].sort((left, right) => left.localeCompare(right))
  };
}
