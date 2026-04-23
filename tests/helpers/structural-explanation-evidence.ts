import { isDeepStrictEqual } from "node:util";

import type {
  BridgeAnalysisResult,
  ComponentAnalysisResult,
  CutpointAnalysisResult,
  CycleAnalysisResult,
  FragilityAnalysisResult
} from "@caphtech/casegraph-core";

export function expectedCycleExplanationEvidence(
  result: CycleAnalysisResult,
  index: number
): CycleAnalysisResult["explanations"][number]["evidence"] {
  const cycle = result.cycles[index];
  if (!cycle) {
    throw new Error(`Missing cycle at index ${index}`);
  }

  return {
    projection: result.projection,
    goal_node_id: result.goal_node_id,
    warnings: result.warnings,
    cycle_index: index + 1,
    cycle_count: result.cycle_count,
    node_ids: cycle.node_ids,
    edge_pairs: cycle.edge_pairs
  };
}

export function expectedComponentExplanationEvidence(
  result: ComponentAnalysisResult,
  index: number
): ComponentAnalysisResult["explanations"][number]["evidence"] {
  const component = result.components[index];
  if (!component) {
    throw new Error(`Missing component at index ${index}`);
  }

  return {
    projection: result.projection,
    goal_node_id: result.goal_node_id,
    warnings: result.warnings,
    component_index: index + 1,
    component_count: result.component_count,
    node_ids: component.node_ids,
    node_count: component.node_count,
    edge_count: component.edge_count
  };
}

export function expectedBridgeExplanationEvidence(
  result: BridgeAnalysisResult,
  index: number
): BridgeAnalysisResult["explanations"][number]["evidence"] {
  const bridge = result.bridges[index];
  if (!bridge) {
    throw new Error(`Missing bridge at index ${index}`);
  }

  return {
    projection: result.projection,
    goal_node_id: result.goal_node_id,
    warnings: result.warnings,
    bridge_index: index + 1,
    bridge_count: result.bridge_count,
    source_id: bridge.source_id,
    target_id: bridge.target_id,
    left_node_ids: bridge.left_node_ids,
    right_node_ids: bridge.right_node_ids
  };
}

export function expectedCutpointExplanationEvidence(
  result: CutpointAnalysisResult,
  index: number
): CutpointAnalysisResult["explanations"][number]["evidence"] {
  const cutpoint = result.cutpoints[index];
  if (!cutpoint) {
    throw new Error(`Missing cutpoint at index ${index}`);
  }

  return {
    projection: result.projection,
    goal_node_id: result.goal_node_id,
    warnings: result.warnings,
    cutpoint_index: index + 1,
    cutpoint_count: result.cutpoint_count,
    node_id: cutpoint.node_id,
    separated_component_count: cutpoint.separated_component_count,
    separated_component_node_sets: cutpoint.separated_component_node_sets
  };
}

export function expectedFragilityExplanationEvidence(
  result: FragilityAnalysisResult,
  index: number
): FragilityAnalysisResult["explanations"][number]["evidence"] {
  const node = result.nodes[index];
  if (!node) {
    throw new Error(`Missing fragility node at index ${index}`);
  }

  return {
    projection: result.projection,
    goal_node_id: result.goal_node_id,
    warnings: result.warnings,
    rank: index + 1,
    node_id: node.node_id,
    kind: node.kind,
    state: node.state,
    title: node.title,
    fragility_score: node.fragility_score,
    incident_bridge_count: node.incident_bridge_count,
    cutpoint_component_count: node.cutpoint_component_count,
    downstream_count: node.downstream_count,
    goal_context_count: node.goal_context_count,
    max_distance: node.max_distance,
    reason_tags: node.reason_tags
  };
}

export function cycleExplanationEvidenceMatches(result: CycleAnalysisResult): boolean {
  return (
    result.explanations.length === result.cycles.length &&
    result.cycles.every((_, index) =>
      sameJson(
        result.explanations[index]?.evidence,
        expectedCycleExplanationEvidence(result, index)
      )
    )
  );
}

export function componentExplanationEvidenceMatches(result: ComponentAnalysisResult): boolean {
  return (
    result.explanations.length === result.components.length &&
    result.components.every((_, index) =>
      sameJson(
        result.explanations[index]?.evidence,
        expectedComponentExplanationEvidence(result, index)
      )
    )
  );
}

export function bridgeExplanationEvidenceMatches(result: BridgeAnalysisResult): boolean {
  return (
    result.explanations.length === result.bridges.length &&
    result.bridges.every((_, index) =>
      sameJson(
        result.explanations[index]?.evidence,
        expectedBridgeExplanationEvidence(result, index)
      )
    )
  );
}

export function cutpointExplanationEvidenceMatches(result: CutpointAnalysisResult): boolean {
  return (
    result.explanations.length === result.cutpoints.length &&
    result.cutpoints.every((_, index) =>
      sameJson(
        result.explanations[index]?.evidence,
        expectedCutpointExplanationEvidence(result, index)
      )
    )
  );
}

export function fragilityExplanationEvidenceMatches(result: FragilityAnalysisResult): boolean {
  return (
    result.explanations.length === result.nodes.length &&
    result.nodes.every((_, index) =>
      sameJson(
        result.explanations[index]?.evidence,
        expectedFragilityExplanationEvidence(result, index)
      )
    )
  );
}

function sameJson(left: unknown, right: unknown): boolean {
  return isDeepStrictEqual(left, right);
}
