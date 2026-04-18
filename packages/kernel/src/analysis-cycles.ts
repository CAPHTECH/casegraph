import {
  analyzeTopology,
  type TopologyAnalysisOptions,
  type TopologyCycleWitness,
  type TopologyProjection
} from "./analysis-topology.js";
import type { CaseStateView, RevisionSnapshot } from "./types.js";

export interface CycleAnalysisResult {
  case_id: string;
  revision: RevisionSnapshot;
  projection: TopologyProjection;
  goal_node_id: string | null;
  cycle_count: number;
  cycles: TopologyCycleWitness[];
  warnings: string[];
}

export function analyzeCycles(
  state: CaseStateView,
  options: TopologyAnalysisOptions = {}
): CycleAnalysisResult {
  const topology = analyzeTopology(state, options);

  return {
    case_id: topology.case_id,
    revision: topology.revision,
    projection: topology.projection,
    goal_node_id: topology.goal_node_id,
    cycle_count: topology.cycle_witnesses.length,
    cycles: topology.cycle_witnesses,
    warnings: topology.warnings
  };
}
