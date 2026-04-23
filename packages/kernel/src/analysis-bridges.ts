import { collectStructuralBridges } from "./analysis-structural.js";
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

  if (projected.projection === "hard_goal_scope" && projected.graph.nodes.size === 0) {
    warnings.add("scope_has_no_unresolved_nodes");
  }

  const bridges = collectStructuralBridges(projected.graph, baseComponents).map((bridge) => ({
    source_id: bridge.edge.source_id,
    target_id: bridge.edge.target_id,
    left_node_ids: bridge.left_node_ids,
    right_node_ids: bridge.right_node_ids
  }));

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

function compareBridges(left: BridgeSummary, right: BridgeSummary): number {
  const leftKey = `${left.source_id}::${left.target_id}`;
  const rightKey = `${right.source_id}::${right.target_id}`;
  return leftKey.localeCompare(rightKey);
}
