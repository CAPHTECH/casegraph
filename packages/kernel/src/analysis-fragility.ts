import { analyzeBottlenecks } from "./analysis-bottleneck.js";
import { analyzeBridges } from "./analysis-bridges.js";
import { analyzeCutpoints } from "./analysis-cutpoints.js";
import {
  projectTopologyGraph,
  type TopologyAnalysisOptions,
  type TopologyProjection
} from "./analysis-topology-shared.js";
import type { CaseStateView, NodeKind, NodeState, RevisionSnapshot } from "./types.js";

export interface FragilityNodeSummary {
  node_id: string;
  kind: NodeKind;
  state: NodeState;
  title: string;
  fragility_score: number;
  incident_bridge_count: number;
  cutpoint_component_count: number;
  downstream_count: number;
  goal_context_count: number;
  max_distance: number;
  reason_tags: string[];
}

export interface FragilityAnalysisResult {
  case_id: string;
  revision: RevisionSnapshot;
  projection: TopologyProjection;
  goal_node_id: string | null;
  nodes: FragilityNodeSummary[];
  warnings: string[];
}

export function analyzeFragility(
  state: CaseStateView,
  options: TopologyAnalysisOptions = {}
): FragilityAnalysisResult {
  const projected = projectTopologyGraph(state, options);
  const bridgeResult = analyzeBridges(state, options);
  const cutpointResult = analyzeCutpoints(state, options);
  const warnings = new Set([
    ...projected.graph.warnings,
    ...bridgeResult.warnings,
    ...cutpointResult.warnings
  ]);

  if (projected.graph.nodes.size === 0) {
    warnings.add("scope_has_no_unresolved_nodes");
  }

  const bridgeCountByNode = new Map<string, number>();
  for (const bridge of bridgeResult.bridges) {
    bridgeCountByNode.set(bridge.source_id, (bridgeCountByNode.get(bridge.source_id) ?? 0) + 1);
    bridgeCountByNode.set(bridge.target_id, (bridgeCountByNode.get(bridge.target_id) ?? 0) + 1);
  }

  const cutpointByNode = new Map(
    cutpointResult.cutpoints.map((cutpoint) => [cutpoint.node_id, cutpoint])
  );

  const bottleneckByNode = new Map<
    string,
    { downstream_count: number; goal_context_count: number; max_distance: number }
  >();
  try {
    const bottlenecks = analyzeBottlenecks(
      state,
      projected.projection === "hard_goal_scope" ? (projected.goal_node_id ?? undefined) : undefined
    );
    for (const node of bottlenecks.nodes) {
      bottleneckByNode.set(node.node_id, {
        downstream_count: node.downstream_count,
        goal_context_count: node.goal_context_count,
        max_distance: node.max_distance
      });
    }
    for (const warning of bottlenecks.warnings) {
      warnings.add(warning);
    }
  } catch (error) {
    if (!(error instanceof Error && "code" in error) || error.code !== "analysis_cycle_present") {
      throw error;
    }
    warnings.add("bottleneck_signal_unavailable_due_to_cycles");
  }

  const nodes = [...projected.graph.nodes.values()]
    .map((node) => {
      const incidentBridgeCount = bridgeCountByNode.get(node.node_id) ?? 0;
      const cutpointComponentCount =
        cutpointByNode.get(node.node_id)?.separated_component_count ?? 0;
      const bottleneck = bottleneckByNode.get(node.node_id) ?? {
        downstream_count: 0,
        goal_context_count: 0,
        max_distance: 0
      };
      const fragilityScore =
        cutpointComponentCount * 5 +
        incidentBridgeCount * 3 +
        bottleneck.downstream_count +
        bottleneck.goal_context_count +
        bottleneck.max_distance;
      const reasonTags = [
        ...(cutpointComponentCount > 0 ? ["cutpoint"] : []),
        ...(incidentBridgeCount > 0 ? ["bridge"] : []),
        ...(bottleneckByNode.has(node.node_id) ? ["bottleneck"] : [])
      ];

      return {
        node_id: node.node_id,
        kind: node.kind,
        state: node.state,
        title: node.title,
        fragility_score: fragilityScore,
        incident_bridge_count: incidentBridgeCount,
        cutpoint_component_count: cutpointComponentCount,
        downstream_count: bottleneck.downstream_count,
        goal_context_count: bottleneck.goal_context_count,
        max_distance: bottleneck.max_distance,
        reason_tags: reasonTags
      } satisfies FragilityNodeSummary;
    })
    .filter((node) => node.fragility_score > 0)
    .sort(compareFragilityNodes);

  return {
    case_id: state.caseRecord.case_id,
    revision: state.caseRecord.case_revision,
    projection: projected.projection,
    goal_node_id: projected.goal_node_id,
    nodes,
    warnings: [...warnings].sort((left, right) => left.localeCompare(right))
  };
}

function compareFragilityNodes(left: FragilityNodeSummary, right: FragilityNodeSummary): number {
  if (left.fragility_score !== right.fragility_score) {
    return right.fragility_score - left.fragility_score;
  }
  if (left.cutpoint_component_count !== right.cutpoint_component_count) {
    return right.cutpoint_component_count - left.cutpoint_component_count;
  }
  if (left.incident_bridge_count !== right.incident_bridge_count) {
    return right.incident_bridge_count - left.incident_bridge_count;
  }
  if (left.downstream_count !== right.downstream_count) {
    return right.downstream_count - left.downstream_count;
  }
  if (left.goal_context_count !== right.goal_context_count) {
    return right.goal_context_count - left.goal_context_count;
  }
  if (left.max_distance !== right.max_distance) {
    return right.max_distance - left.max_distance;
  }
  return left.node_id.localeCompare(right.node_id);
}
