import {
  collectCycleWitnesses,
  collectTopologyComponents,
  projectTopologyGraph,
  type TopologyAnalysisOptions,
  type TopologyComponentSummary,
  type TopologyCycleWitness,
  type TopologyProjection
} from "./analysis-topology-shared.js";
import type { CaseStateView, RevisionSnapshot } from "./types.js";

export type {
  TopologyAnalysisOptions,
  TopologyComponentSummary,
  TopologyCycleWitness,
  TopologyCycleWitnessEdge,
  TopologyProjection
} from "./analysis-topology-shared.js";

export interface TopologyAnalysisResult {
  case_id: string;
  revision: RevisionSnapshot;
  projection: TopologyProjection;
  goal_node_id: string | null;
  node_count: number;
  edge_count: number;
  beta_0: number;
  beta_1: number;
  components: TopologyComponentSummary[];
  cycle_witnesses: TopologyCycleWitness[];
  warnings: string[];
}

export function analyzeTopology(
  state: CaseStateView,
  options: TopologyAnalysisOptions = {}
): TopologyAnalysisResult {
  const projected = projectTopologyGraph(state, options);
  const components = collectTopologyComponents(projected.graph);
  const beta0 = components.length;
  const beta1 = projected.graph.edges.length - projected.graph.nodes.size + beta0;
  const cycleWitnesses = collectCycleWitnesses(projected.graph, components);
  const warnings = new Set(projected.graph.warnings);

  if (projected.graph.nodes.size === 0) {
    warnings.add("scope_has_no_unresolved_nodes");
  }
  if (cycleWitnesses.length < beta1) {
    warnings.add("cycle_witnesses_incomplete");
  }

  return {
    case_id: state.caseRecord.case_id,
    revision: state.caseRecord.case_revision,
    projection: projected.projection,
    goal_node_id: projected.goal_node_id,
    node_count: projected.graph.nodes.size,
    edge_count: projected.graph.edges.length,
    beta_0: beta0,
    beta_1: beta1,
    components,
    cycle_witnesses: cycleWitnesses,
    warnings: [...warnings].sort((left, right) => left.localeCompare(right))
  };
}
