import {
  analyzeBottlenecksForCase,
  analyzeBridges,
  analyzeComponents,
  analyzeComponentsForCase,
  analyzeCriticalPathForCase,
  analyzeCutpoints,
  analyzeCutpointsForCase,
  analyzeCycles,
  analyzeCyclesForCase,
  analyzeFragility,
  analyzeFragilityForCase,
  analyzeImpactForCase,
  analyzeMinimalUnblockSetForCase,
  analyzeSlackForCase
} from "@caphtech/casegraph-core";

import incidentAnalysisFixture from "../fixtures/incident-analysis.fixture.json";
import releaseAnalysisFixture from "../fixtures/release-analysis.fixture.json";
import structureAnalysisFixture from "../fixtures/structure-analysis.fixture.json";
import structureAnalysisEdgeCasesFixture from "../fixtures/structure-analysis-edge-cases.fixture.json";
import topologyAnalysisFixture from "../fixtures/topology-analysis.fixture.json";
import vendorSelectionAnalysisFixture from "../fixtures/vendor-selection-analysis.fixture.json";
import { buildReplayStateFromFixture, type ReplayFixture } from "./replay-fixture.js";
import {
  bridgeExplanationEvidenceMatches,
  componentExplanationEvidenceMatches,
  cutpointExplanationEvidenceMatches,
  cycleExplanationEvidenceMatches,
  fragilityExplanationEvidenceMatches
} from "./structural-explanation-evidence.js";
import {
  applyFixtureActions,
  createTempWorkspace,
  type FixtureAction,
  removeTempWorkspace,
  seedFixture
} from "./workspace.js";

export interface GoldenFixture extends ReplayFixture {
  scenarios: GoldenScenario[];
}

export type GoldenScenario =
  | {
      name: string;
      setup_actions?: FixtureAction[];
      impact: {
        source_node_id: string;
        hard_impact: string[];
        context_impact: string[];
        frontier_invalidations: string[];
        warnings: string[];
      };
      critical_path?: never;
      slack?: never;
      bottlenecks?: never;
      unblock?: never;
      cycles?: never;
      components?: never;
      bridges?: never;
      cutpoints?: never;
      fragility?: never;
    }
  | {
      name: string;
      setup_actions?: FixtureAction[];
      impact?: never;
      critical_path: {
        goal_node_id?: string | null;
        depth_path: string[];
        duration_path: string[] | null;
        missing_estimate_node_ids: string[];
        warnings: string[];
      };
      slack?: never;
      bottlenecks?: never;
      unblock?: never;
      cycles?: never;
      components?: never;
      bridges?: never;
      cutpoints?: never;
      fragility?: never;
    }
  | {
      name: string;
      setup_actions?: FixtureAction[];
      impact?: never;
      critical_path?: never;
      slack: {
        goal_node_id?: string | null;
        projected_duration_minutes: number | null;
        node_ids: string[];
        critical_node_ids: string[];
        slack_minutes_by_node: Record<string, number>;
        missing_estimate_node_ids: string[];
        warnings: string[];
      };
      bottlenecks?: never;
      unblock?: never;
      cycles?: never;
      components?: never;
      bridges?: never;
      cutpoints?: never;
      fragility?: never;
    }
  | {
      name: string;
      setup_actions?: FixtureAction[];
      impact?: never;
      critical_path?: never;
      slack?: never;
      bottlenecks: {
        goal_node_id?: string | null;
        node_ids: string[];
        downstream_count_by_node: Record<string, number>;
        frontier_invalidation_count_by_node: Record<string, number>;
        goal_context_count_by_node: Record<string, number>;
        warnings: string[];
      };
      unblock?: never;
      cycles?: never;
      components?: never;
      bridges?: never;
      cutpoints?: never;
      fragility?: never;
    }
  | {
      name: string;
      setup_actions?: FixtureAction[];
      impact?: never;
      critical_path?: never;
      slack?: never;
      bottlenecks?: never;
      unblock: {
        target_node_id: string;
        actionable_leaf_node_ids: string[];
        blocker_node_ids: string[];
        blocker_kinds_by_node: Record<string, string>;
        blocker_actionable_by_node: Record<string, boolean>;
        warnings: string[];
      };
      cycles?: never;
      components?: never;
      bridges?: never;
      cutpoints?: never;
      fragility?: never;
    }
  | {
      name: string;
      setup_actions?: FixtureAction[];
      impact?: never;
      critical_path?: never;
      slack?: never;
      bottlenecks?: never;
      unblock?: never;
      cycles: {
        goal_node_id?: string | null;
        cycle_count: number;
        cycle_node_sets: string[][];
        warnings: string[];
      };
      components?: never;
      bridges?: never;
      cutpoints?: never;
      fragility?: never;
    }
  | {
      name: string;
      setup_actions?: FixtureAction[];
      impact?: never;
      critical_path?: never;
      slack?: never;
      bottlenecks?: never;
      unblock?: never;
      cycles?: never;
      components: {
        goal_node_id?: string | null;
        component_count: number;
        component_node_sets: string[][];
        warnings: string[];
      };
      bridges?: never;
      cutpoints?: never;
      fragility?: never;
    }
  | {
      name: string;
      setup_actions?: FixtureAction[];
      impact?: never;
      critical_path?: never;
      slack?: never;
      bottlenecks?: never;
      unblock?: never;
      cycles?: never;
      components?: never;
      bridges: {
        goal_node_id?: string | null;
        bridge_pairs: string[];
        warnings: string[];
      };
      cutpoints?: never;
      fragility?: never;
    }
  | {
      name: string;
      setup_actions?: FixtureAction[];
      impact?: never;
      critical_path?: never;
      slack?: never;
      bottlenecks?: never;
      unblock?: never;
      cycles?: never;
      components?: never;
      bridges?: never;
      cutpoints: {
        goal_node_id?: string | null;
        cutpoint_ids: string[];
        separated_component_node_sets_by_node: Record<string, string[][]>;
        warnings: string[];
      };
      fragility?: never;
    }
  | {
      name: string;
      setup_actions?: FixtureAction[];
      impact?: never;
      critical_path?: never;
      slack?: never;
      bottlenecks?: never;
      unblock?: never;
      cycles?: never;
      components?: never;
      bridges?: never;
      cutpoints?: never;
      fragility: {
        goal_node_id?: string | null;
        node_ids: string[];
        top_node_id: string | null;
        warnings: string[];
      };
    };

export interface ScenarioMetric {
  fixture_id: string;
  scenario_name: string;
  kind:
    | "impact"
    | "critical_path"
    | "slack"
    | "bottlenecks"
    | "unblock"
    | "cycles"
    | "components"
    | "bridges"
    | "cutpoints"
    | "fragility";
  passed: boolean;
  checks: Record<string, boolean>;
}

export interface HitRate {
  hits: number;
  total: number;
  hit_rate: number;
}

export interface AnalysisGoldenMetrics {
  scenario_count: number;
  check_count: number;
  overall: HitRate;
  by_check: Record<string, HitRate>;
  scenarios: ScenarioMetric[];
}

const fixtures: GoldenFixture[] = [
  releaseAnalysisFixture as GoldenFixture,
  incidentAnalysisFixture as GoldenFixture,
  structureAnalysisFixture as GoldenFixture,
  structureAnalysisEdgeCasesFixture as GoldenFixture,
  topologyAnalysisFixture as GoldenFixture,
  vendorSelectionAnalysisFixture as GoldenFixture
];

export async function collectAnalysisGoldenMetrics(): Promise<AnalysisGoldenMetrics> {
  const scenarioMetrics: ScenarioMetric[] = [];

  for (const fixture of fixtures) {
    if (fixture.seed_mode === "event_replay") {
      const replayState = buildReplayStateFromFixture(fixture);

      for (const scenario of fixture.scenarios) {
        if ((scenario.setup_actions ?? []).length > 0) {
          throw new Error(
            `Replay-only fixture ${fixture.case.case_id} does not support setup_actions`
          );
        }
        scenarioMetrics.push(evaluateReplayOnlyScenario(replayState, fixture, scenario));
      }

      continue;
    }

    for (const scenario of fixture.scenarios) {
      const workspaceRoot = await createTempWorkspace("casegraph-analysis-golden-");
      try {
        await seedFixture(workspaceRoot, fixture);
        await applyFixtureActions(
          workspaceRoot,
          fixture.case.case_id,
          scenario.setup_actions ?? []
        );
        scenarioMetrics.push(await evaluateScenario(workspaceRoot, fixture, scenario));
      } finally {
        await removeTempWorkspace(workspaceRoot);
      }
    }
  }

  return {
    scenario_count: scenarioMetrics.length,
    check_count: scenarioMetrics.reduce(
      (total, scenario) => total + Object.keys(scenario.checks).length,
      0
    ),
    overall: summarizeOverall(scenarioMetrics),
    by_check: summarizeByCheck(scenarioMetrics),
    scenarios: scenarioMetrics
  };
}

function evaluateReplayOnlyScenario(
  state: ReturnType<typeof buildReplayStateFromFixture>,
  fixture: GoldenFixture,
  scenario: GoldenScenario
): ScenarioMetric {
  if ("cycles" in scenario) {
    const result = analyzeCycles(state, {
      goalNodeId: scenario.cycles.goal_node_id ?? undefined
    });
    return metric(fixture.case.case_id, scenario.name, "cycles", {
      cycle_count: result.cycle_count === scenario.cycles.cycle_count,
      cycle_node_sets: sameNodeSetArray(
        result.cycles.map((cycle) => cycle.node_ids),
        scenario.cycles.cycle_node_sets
      ),
      explanation_evidence: cycleExplanationEvidenceMatches(result),
      warnings: sameStringArray(result.warnings, scenario.cycles.warnings)
    });
  }

  if ("components" in scenario) {
    const result = analyzeComponents(state, {
      goalNodeId: scenario.components.goal_node_id ?? undefined
    });
    return metric(fixture.case.case_id, scenario.name, "components", {
      component_count: result.component_count === scenario.components.component_count,
      component_node_sets: sameNodeSetArray(
        result.components.map((component) => component.node_ids),
        scenario.components.component_node_sets
      ),
      explanation_evidence: componentExplanationEvidenceMatches(result),
      warnings: sameStringArray(result.warnings, scenario.components.warnings)
    });
  }

  if ("bridges" in scenario) {
    const result = analyzeBridges(state, {
      goalNodeId: scenario.bridges.goal_node_id ?? undefined
    });
    return metric(fixture.case.case_id, scenario.name, "bridges", {
      bridge_pairs: sameStringArray(
        result.bridges.map((bridge) => `${bridge.source_id}::${bridge.target_id}`),
        scenario.bridges.bridge_pairs
      ),
      explanation_evidence: bridgeExplanationEvidenceMatches(result),
      warnings: sameStringArray(result.warnings, scenario.bridges.warnings)
    });
  }

  if ("cutpoints" in scenario) {
    const result = analyzeCutpoints(state, {
      goalNodeId: scenario.cutpoints.goal_node_id ?? undefined
    });
    return metric(fixture.case.case_id, scenario.name, "cutpoints", {
      cutpoint_ids: sameStringArray(
        result.cutpoints.map((cutpoint) => cutpoint.node_id),
        scenario.cutpoints.cutpoint_ids
      ),
      separated_component_node_sets_by_node: sameSeparatedComponentRecord(
        Object.fromEntries(
          result.cutpoints.map((cutpoint) => [
            cutpoint.node_id,
            cutpoint.separated_component_node_sets
          ])
        ),
        scenario.cutpoints.separated_component_node_sets_by_node
      ),
      explanation_evidence: cutpointExplanationEvidenceMatches(result),
      warnings: sameStringArray(result.warnings, scenario.cutpoints.warnings)
    });
  }

  if ("fragility" in scenario) {
    const result = analyzeFragility(state, {
      goalNodeId: scenario.fragility.goal_node_id ?? undefined
    });
    return metric(fixture.case.case_id, scenario.name, "fragility", {
      node_ids: sameStringArray(
        result.nodes.map((node) => node.node_id),
        scenario.fragility.node_ids
      ),
      top_node_id: (result.nodes[0]?.node_id ?? null) === scenario.fragility.top_node_id,
      explanation_evidence: fragilityExplanationEvidenceMatches(result),
      warnings: sameStringArray(result.warnings, scenario.fragility.warnings)
    });
  }

  throw new Error(
    `Replay-only fixture ${fixture.case.case_id} only supports structural analysis scenarios`
  );
}

async function evaluateScenario(
  workspaceRoot: string,
  fixture: GoldenFixture,
  scenario: GoldenScenario
): Promise<ScenarioMetric> {
  if ("impact" in scenario) {
    const result = await analyzeImpactForCase(
      workspaceRoot,
      fixture.case.case_id,
      scenario.impact.source_node_id
    );
    const checks = {
      hard_impact: sameStringArray(nodeIds(result.hard_impact), scenario.impact.hard_impact),
      context_impact: sameStringArray(
        nodeIds(result.context_impact),
        scenario.impact.context_impact
      ),
      frontier_invalidations: sameStringArray(
        nodeIds(result.frontier_invalidations),
        scenario.impact.frontier_invalidations
      ),
      warnings: sameStringArray(result.warnings, scenario.impact.warnings)
    };
    return metric(fixture.case.case_id, scenario.name, "impact", checks);
  }

  if ("slack" in scenario) {
    const result = await analyzeSlackForCase(
      workspaceRoot,
      fixture.case.case_id,
      scenario.slack.goal_node_id ?? undefined
    );
    const checks = {
      projected_duration_minutes:
        result.projected_duration_minutes === scenario.slack.projected_duration_minutes,
      slack_node_ids: sameStringArray(nodeIds(result.nodes), scenario.slack.node_ids),
      critical_node_ids: sameStringArray(
        nodeIds(result.nodes.filter((node) => node.is_critical)),
        scenario.slack.critical_node_ids
      ),
      slack_minutes_by_node: sameNumberRecord(
        numberRecordByNode(result.nodes, "slack_minutes"),
        scenario.slack.slack_minutes_by_node
      ),
      missing_estimate_node_ids: sameStringArray(
        result.missing_estimate_node_ids,
        scenario.slack.missing_estimate_node_ids
      ),
      warnings: sameStringArray(result.warnings, scenario.slack.warnings)
    };
    return metric(fixture.case.case_id, scenario.name, "slack", checks);
  }

  if ("bottlenecks" in scenario) {
    const result = await analyzeBottlenecksForCase(
      workspaceRoot,
      fixture.case.case_id,
      scenario.bottlenecks.goal_node_id ?? undefined
    );
    const checks = {
      bottleneck_node_ids: sameStringArray(nodeIds(result.nodes), scenario.bottlenecks.node_ids),
      downstream_count_by_node: sameNumberRecord(
        numberRecordByNode(result.nodes, "downstream_count"),
        scenario.bottlenecks.downstream_count_by_node
      ),
      frontier_invalidation_count_by_node: sameNumberRecord(
        numberRecordByNode(result.nodes, "frontier_invalidation_count"),
        scenario.bottlenecks.frontier_invalidation_count_by_node
      ),
      goal_context_count_by_node: sameNumberRecord(
        numberRecordByNode(result.nodes, "goal_context_count"),
        scenario.bottlenecks.goal_context_count_by_node
      ),
      warnings: sameStringArray(result.warnings, scenario.bottlenecks.warnings)
    };
    return metric(fixture.case.case_id, scenario.name, "bottlenecks", checks);
  }

  if ("unblock" in scenario) {
    const result = await analyzeMinimalUnblockSetForCase(
      workspaceRoot,
      fixture.case.case_id,
      scenario.unblock.target_node_id
    );
    const checks = {
      actionable_leaf_node_ids: sameStringArray(
        result.actionable_leaf_node_ids,
        scenario.unblock.actionable_leaf_node_ids
      ),
      blocker_node_ids: sameStringArray(
        nodeIds(result.blockers),
        scenario.unblock.blocker_node_ids
      ),
      blocker_kinds_by_node: sameStringRecord(
        stringRecordByNode(result.blockers, "kind"),
        scenario.unblock.blocker_kinds_by_node
      ),
      blocker_actionable_by_node: sameBooleanRecord(
        booleanRecordByNode(result.blockers, "actionable"),
        scenario.unblock.blocker_actionable_by_node
      ),
      warnings: sameStringArray(result.warnings, scenario.unblock.warnings)
    };
    return metric(fixture.case.case_id, scenario.name, "unblock", checks);
  }

  const structureMetric = await evaluateWorkspaceStructureScenario(
    workspaceRoot,
    fixture.case.case_id,
    scenario
  );
  if (structureMetric) {
    return metric(
      fixture.case.case_id,
      scenario.name,
      structureMetric.kind,
      structureMetric.checks
    );
  }

  const result = await analyzeCriticalPathForCase(
    workspaceRoot,
    fixture.case.case_id,
    scenario.critical_path.goal_node_id ?? undefined
  );
  const checks = {
    depth_path: sameStringArray(result.depth_path.node_ids, scenario.critical_path.depth_path),
    duration_path: sameNullableStringArray(
      result.duration_path?.node_ids ?? null,
      scenario.critical_path.duration_path
    ),
    missing_estimate_node_ids: sameStringArray(
      result.missing_estimate_node_ids,
      scenario.critical_path.missing_estimate_node_ids
    ),
    warnings: sameStringArray(result.warnings, scenario.critical_path.warnings)
  };
  return metric(fixture.case.case_id, scenario.name, "critical_path", checks);
}

async function evaluateWorkspaceStructureScenario(
  workspaceRoot: string,
  caseId: string,
  scenario: GoldenScenario
): Promise<Pick<ScenarioMetric, "kind" | "checks"> | null> {
  if ("cycles" in scenario) {
    const result = await analyzeCyclesForCase(workspaceRoot, caseId, {
      goalNodeId: scenario.cycles.goal_node_id ?? undefined
    });
    return {
      kind: "cycles",
      checks: {
        cycle_count: result.cycle_count === scenario.cycles.cycle_count,
        cycle_node_sets: sameNodeSetArray(
          result.cycles.map((cycle) => cycle.node_ids),
          scenario.cycles.cycle_node_sets
        ),
        explanation_evidence: cycleExplanationEvidenceMatches(result),
        warnings: sameStringArray(result.warnings, scenario.cycles.warnings)
      }
    };
  }

  if ("components" in scenario) {
    const result = await analyzeComponentsForCase(workspaceRoot, caseId, {
      goalNodeId: scenario.components.goal_node_id ?? undefined
    });
    return {
      kind: "components",
      checks: {
        component_count: result.component_count === scenario.components.component_count,
        component_node_sets: sameNodeSetArray(
          result.components.map((component) => component.node_ids),
          scenario.components.component_node_sets
        ),
        explanation_evidence: componentExplanationEvidenceMatches(result),
        warnings: sameStringArray(result.warnings, scenario.components.warnings)
      }
    };
  }

  if ("bridges" in scenario) {
    const result = await analyzeBridgesForCase(workspaceRoot, caseId, {
      goalNodeId: scenario.bridges.goal_node_id ?? undefined
    });
    return {
      kind: "bridges",
      checks: {
        bridge_pairs: sameStringArray(
          result.bridges.map((bridge) => `${bridge.source_id}::${bridge.target_id}`),
          scenario.bridges.bridge_pairs
        ),
        explanation_evidence: bridgeExplanationEvidenceMatches(result),
        warnings: sameStringArray(result.warnings, scenario.bridges.warnings)
      }
    };
  }

  if ("cutpoints" in scenario) {
    const result = await analyzeCutpointsForCase(workspaceRoot, caseId, {
      goalNodeId: scenario.cutpoints.goal_node_id ?? undefined
    });
    return {
      kind: "cutpoints",
      checks: {
        cutpoint_ids: sameStringArray(
          result.cutpoints.map((cutpoint) => cutpoint.node_id),
          scenario.cutpoints.cutpoint_ids
        ),
        separated_component_node_sets_by_node: sameSeparatedComponentRecord(
          Object.fromEntries(
            result.cutpoints.map((cutpoint) => [
              cutpoint.node_id,
              cutpoint.separated_component_node_sets
            ])
          ),
          scenario.cutpoints.separated_component_node_sets_by_node
        ),
        explanation_evidence: cutpointExplanationEvidenceMatches(result),
        warnings: sameStringArray(result.warnings, scenario.cutpoints.warnings)
      }
    };
  }

  if ("fragility" in scenario) {
    const result = await analyzeFragilityForCase(workspaceRoot, caseId, {
      goalNodeId: scenario.fragility.goal_node_id ?? undefined
    });
    return {
      kind: "fragility",
      checks: {
        node_ids: sameStringArray(
          result.nodes.map((node) => node.node_id),
          scenario.fragility.node_ids
        ),
        top_node_id: (result.nodes[0]?.node_id ?? null) === scenario.fragility.top_node_id,
        explanation_evidence: fragilityExplanationEvidenceMatches(result),
        warnings: sameStringArray(result.warnings, scenario.fragility.warnings)
      }
    };
  }

  return null;
}

function metric(
  fixtureId: string,
  scenarioName: string,
  kind: ScenarioMetric["kind"],
  checks: Record<string, boolean>
): ScenarioMetric {
  return {
    fixture_id: fixtureId,
    scenario_name: scenarioName,
    kind,
    passed: Object.values(checks).every(Boolean),
    checks
  };
}

function summarizeOverall(scenarios: ScenarioMetric[]): HitRate {
  const hits = scenarios.reduce(
    (total, scenario) => total + Object.values(scenario.checks).filter(Boolean).length,
    0
  );
  const total = scenarios.reduce((sum, scenario) => sum + Object.keys(scenario.checks).length, 0);
  return {
    hits,
    total,
    hit_rate: total === 0 ? 1 : hits / total
  };
}

function summarizeByCheck(scenarios: ScenarioMetric[]): Record<string, HitRate> {
  const aggregate = new Map<string, { hits: number; total: number }>();
  for (const scenario of scenarios) {
    for (const [checkName, passed] of Object.entries(scenario.checks)) {
      const current = aggregate.get(checkName) ?? { hits: 0, total: 0 };
      aggregate.set(checkName, {
        hits: current.hits + (passed ? 1 : 0),
        total: current.total + 1
      });
    }
  }

  return Object.fromEntries(
    [...aggregate.entries()]
      .sort((left, right) => left[0].localeCompare(right[0]))
      .map(([checkName, value]) => [
        checkName,
        {
          hits: value.hits,
          total: value.total,
          hit_rate: value.total === 0 ? 1 : value.hits / value.total
        }
      ])
  );
}

function nodeIds(nodes: Array<{ node_id: string }>): string[] {
  return nodes.map((node) => node.node_id);
}

function sameStringArray(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameNullableStringArray(left: string[] | null, right: string[] | null): boolean {
  if (left === null || right === null) {
    return left === right;
  }
  return sameStringArray(left, right);
}

function sameNumberRecord(left: Record<string, number>, right: Record<string, number>): boolean {
  return (
    sameStringArray(Object.keys(left).sort(), Object.keys(right).sort()) &&
    Object.entries(left).every(([key, value]) => right[key] === value)
  );
}

function sameStringRecord(left: Record<string, string>, right: Record<string, string>): boolean {
  return (
    sameStringArray(Object.keys(left).sort(), Object.keys(right).sort()) &&
    Object.entries(left).every(([key, value]) => right[key] === value)
  );
}

function sameBooleanRecord(left: Record<string, boolean>, right: Record<string, boolean>): boolean {
  return (
    sameStringArray(Object.keys(left).sort(), Object.keys(right).sort()) &&
    Object.entries(left).every(([key, value]) => right[key] === value)
  );
}

function sameNodeSetArray(left: string[][], right: string[][]): boolean {
  return (
    JSON.stringify(normalizeNodeSetArray(left)) === JSON.stringify(normalizeNodeSetArray(right))
  );
}

function sameSeparatedComponentRecord(
  left: Record<string, string[][]>,
  right: Record<string, string[][]>
): boolean {
  return (
    JSON.stringify(normalizeSeparatedComponentRecord(left)) ===
    JSON.stringify(normalizeSeparatedComponentRecord(right))
  );
}

function numberRecordByNode<T extends { node_id: string }>(
  nodes: T[],
  field: keyof T
): Record<string, number> {
  return Object.fromEntries(nodes.map((node) => [node.node_id, Number(node[field])]));
}

function stringRecordByNode<T extends { node_id: string }>(
  nodes: T[],
  field: keyof T
): Record<string, string> {
  return Object.fromEntries(nodes.map((node) => [node.node_id, String(node[field])]));
}

function booleanRecordByNode<T extends { node_id: string }>(
  nodes: T[],
  field: keyof T
): Record<string, boolean> {
  return Object.fromEntries(nodes.map((node) => [node.node_id, Boolean(node[field])]));
}

function normalizeNodeSetArray(nodeSets: string[][]): string[][] {
  return [...nodeSets]
    .map((nodeIds) => [...nodeIds].sort((left, right) => left.localeCompare(right)))
    .sort((left, right) => (left[0] ?? "").localeCompare(right[0] ?? ""));
}

function normalizeSeparatedComponentRecord(
  record: Record<string, string[][]>
): Record<string, string[][]> {
  return Object.fromEntries(
    Object.entries(record)
      .sort((left, right) => left[0].localeCompare(right[0]))
      .map(([nodeId, nodeSets]) => [nodeId, normalizeNodeSetArray(nodeSets)])
  );
}
