import type { TopologyCycleWitnessEdge, TopologyProjection } from "./analysis-topology-shared.js";
import type { NodeKind, NodeState } from "./types.js";

export type StructuralExplanationKind = "component" | "cycle" | "bridge" | "cutpoint" | "fragility";

export interface StructuralExplanationContext {
  projection: TopologyProjection;
  goal_node_id: string | null;
  warnings: string[];
}

export interface StructuralRiskExplanationBase<
  TKind extends StructuralExplanationKind,
  TEvidence extends object
> {
  kind: TKind;
  label: string;
  summary: string;
  evidence: StructuralExplanationContext & TEvidence;
}

export type ComponentRiskExplanation = StructuralRiskExplanationBase<
  "component",
  {
    component_index: number;
    component_count: number;
    node_ids: string[];
    node_count: number;
    edge_count: number;
  }
>;

export type CycleRiskExplanation = StructuralRiskExplanationBase<
  "cycle",
  {
    cycle_index: number;
    cycle_count: number;
    node_ids: string[];
    edge_pairs: TopologyCycleWitnessEdge[];
  }
>;

export type BridgeRiskExplanation = StructuralRiskExplanationBase<
  "bridge",
  {
    bridge_index: number;
    bridge_count: number;
    source_id: string;
    target_id: string;
    left_node_ids: string[];
    right_node_ids: string[];
  }
>;

export type CutpointRiskExplanation = StructuralRiskExplanationBase<
  "cutpoint",
  {
    cutpoint_index: number;
    cutpoint_count: number;
    node_id: string;
    separated_component_count: number;
    separated_component_node_sets: string[][];
  }
>;

export type FragilityRiskExplanation = StructuralRiskExplanationBase<
  "fragility",
  {
    rank: number;
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
>;

export type StructuralRiskExplanation =
  | ComponentRiskExplanation
  | CycleRiskExplanation
  | BridgeRiskExplanation
  | CutpointRiskExplanation
  | FragilityRiskExplanation;

interface ComponentExplanationInput {
  node_ids: string[];
  node_count: number;
  edge_count: number;
}

interface CycleExplanationInput {
  node_ids: string[];
  edge_pairs: TopologyCycleWitnessEdge[];
}

interface BridgeExplanationInput {
  source_id: string;
  target_id: string;
  left_node_ids: string[];
  right_node_ids: string[];
}

interface CutpointExplanationInput {
  node_id: string;
  separated_component_count: number;
  separated_component_node_sets: string[][];
}

interface FragilityExplanationInput {
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

export function buildComponentExplanations(
  context: StructuralExplanationContext,
  components: ComponentExplanationInput[]
): ComponentRiskExplanation[] {
  return components.map((component, index) => ({
    kind: "component",
    label: `work region ${index + 1}`,
    summary: `Contains ${count(component.node_count, "unresolved node")} and ${count(component.edge_count, "hard dependency", "hard dependencies")}: ${component.node_ids.join(",")}.`,
    evidence: withContext(context, {
      component_index: index + 1,
      component_count: components.length,
      node_ids: [...component.node_ids],
      node_count: component.node_count,
      edge_count: component.edge_count
    })
  }));
}

export function buildCycleExplanations(
  context: StructuralExplanationContext,
  cycles: CycleExplanationInput[]
): CycleRiskExplanation[] {
  return cycles.map((cycle, index) => ({
    kind: "cycle",
    label: `dependency loop ${index + 1}`,
    summary: `Involves ${count(cycle.node_ids.length, "unresolved node")}: ${cycle.node_ids.join(",")}.`,
    evidence: withContext(context, {
      cycle_index: index + 1,
      cycle_count: cycles.length,
      node_ids: [...cycle.node_ids],
      edge_pairs: cycle.edge_pairs.map((edgePair) => ({ ...edgePair }))
    })
  }));
}

export function buildBridgeExplanations(
  context: StructuralExplanationContext,
  bridges: BridgeExplanationInput[]
): BridgeRiskExplanation[] {
  return bridges.map((bridge, index) => ({
    kind: "bridge",
    label: `single dependency edge ${index + 1}`,
    summary: `Hard dependency between ${bridge.source_id} and ${bridge.target_id} separates ${count(bridge.left_node_ids.length, "node")} from ${count(bridge.right_node_ids.length, "node")}.`,
    evidence: withContext(context, {
      bridge_index: index + 1,
      bridge_count: bridges.length,
      source_id: bridge.source_id,
      target_id: bridge.target_id,
      left_node_ids: [...bridge.left_node_ids],
      right_node_ids: [...bridge.right_node_ids]
    })
  }));
}

export function buildCutpointExplanations(
  context: StructuralExplanationContext,
  cutpoints: CutpointExplanationInput[]
): CutpointRiskExplanation[] {
  return cutpoints.map((cutpoint, index) => ({
    kind: "cutpoint",
    label: `single separating node ${index + 1}`,
    summary: `Node ${cutpoint.node_id} separates unresolved work into ${count(cutpoint.separated_component_count, "region")} when removed.`,
    evidence: withContext(context, {
      cutpoint_index: index + 1,
      cutpoint_count: cutpoints.length,
      node_id: cutpoint.node_id,
      separated_component_count: cutpoint.separated_component_count,
      separated_component_node_sets: cutpoint.separated_component_node_sets.map((nodeIds) => [
        ...nodeIds
      ])
    })
  }));
}

export function buildFragilityExplanations(
  context: StructuralExplanationContext,
  nodes: FragilityExplanationInput[]
): FragilityRiskExplanation[] {
  return nodes.map((node, index) => ({
    kind: "fragility",
    label: `intervention candidate ${index + 1}`,
    summary: `${node.node_id} is a prioritized intervention candidate with score ${node.fragility_score}; evidence=${node.reason_tags.join("+") || "metric"}.`,
    evidence: withContext(context, {
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
      reason_tags: [...node.reason_tags]
    })
  }));
}

function withContext<TEvidence extends object>(
  context: StructuralExplanationContext,
  evidence: TEvidence
): StructuralExplanationContext & TEvidence {
  return {
    ...copyContext(context),
    ...evidence
  };
}

function copyContext(context: StructuralExplanationContext): StructuralExplanationContext {
  return {
    projection: context.projection,
    goal_node_id: context.goal_node_id,
    warnings: [...context.warnings]
  };
}

function count(value: number, singular: string, plural = `${singular}s`): string {
  return `${value} ${value === 1 ? singular : plural}`;
}
