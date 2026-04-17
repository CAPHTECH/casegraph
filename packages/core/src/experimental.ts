import {
  analyzeTopology,
  type TopologyAnalysisOptions,
  type TopologyAnalysisResult,
  type TopologyComponentSummary,
  type TopologyCycleWitness,
  type TopologyCycleWitnessEdge,
  type TopologyProjection
} from "./analysis-topology.js";
import { loadCaseState } from "./workspace.js";

export {
  analyzeTopology,
  type TopologyAnalysisOptions,
  type TopologyAnalysisResult,
  type TopologyComponentSummary,
  type TopologyCycleWitness,
  type TopologyCycleWitnessEdge,
  type TopologyProjection
};

export async function analyzeTopologyForCase(
  workspaceRoot: string,
  caseId: string,
  options: TopologyAnalysisOptions = {}
): Promise<TopologyAnalysisResult> {
  const state = await loadCaseState(workspaceRoot, caseId);
  return analyzeTopology(state, options);
}
