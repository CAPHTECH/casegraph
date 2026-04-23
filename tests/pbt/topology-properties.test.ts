import { analyzeTopology } from "@caphtech/casegraph-core/experimental";
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  addNormalizationNoise,
  buildReferenceTopology,
  buildTopologyState,
  goalScopedTopologyBlueprintArb,
  resolvedContributorScopeBlueprintArb,
  simpleTopologyBlueprintArb,
  type TopologyReferenceSummary,
  topologyBlueprintArb
} from "./generators/topology.js";

describe("property: topology analysis invariants", () => {
  it("P1 hard_unresolved matches the reference normalization model", () => {
    fc.assert(
      fc.property(topologyBlueprintArb, (blueprint) => {
        const result = analyzeTopology(buildTopologyState(blueprint));
        const expected = buildReferenceTopology(blueprint);

        expect(summarizeResult(result)).toEqual(summarizeReference(expected));
        expectCycleWitnessesToReferenceEdges(result.cycle_witnesses, expected);
        expect(result.cycle_witnesses.length).toBeLessThanOrEqual(result.beta_1);
      }),
      { numRuns: 60 }
    );
  });

  it("P2 hard_goal_scope matches contributor and prerequisite closure", () => {
    fc.assert(
      fc.property(goalScopedTopologyBlueprintArb, (blueprint) => {
        const goalNodeId = blueprint.goalNodeId as string;
        const result = analyzeTopology(buildTopologyState(blueprint), {
          projection: "hard_goal_scope",
          goalNodeId
        });
        const expected = buildReferenceTopology(blueprint, {
          projection: "hard_goal_scope",
          goalNodeId
        });

        expect(summarizeResult(result)).toEqual(summarizeReference(expected));
        expect(result.goal_node_id).toBe(goalNodeId);
        expect(result.components.flatMap((component) => component.node_ids)).not.toContain(
          goalNodeId
        );
        expectCycleWitnessesToReferenceEdges(result.cycle_witnesses, expected);
      }),
      { numRuns: 60 }
    );
  });

  it("P3 duplicate hard edges and self-loops do not change normalized topology", () => {
    fc.assert(
      fc.property(simpleTopologyBlueprintArb, (blueprint) => {
        const baseResult = analyzeTopology(buildTopologyState(blueprint));
        const noisyBlueprint = addNormalizationNoise(blueprint);
        const noisyResult = analyzeTopology(buildTopologyState(noisyBlueprint));
        const noisyReference = buildReferenceTopology(noisyBlueprint);

        expect(summarizeResultWithoutWarnings(noisyResult)).toEqual(
          summarizeResultWithoutWarnings(baseResult)
        );
        expect(noisyResult.cycle_witnesses).toEqual(baseResult.cycle_witnesses);
        expect(noisyResult.warnings).toEqual(noisyReference.warnings);
      }),
      { numRuns: 40 }
    );
  });

  it("P4 resolved contributors do not seed prerequisite closure", () => {
    fc.assert(
      fc.property(resolvedContributorScopeBlueprintArb, (blueprint) => {
        const result = analyzeTopology(buildTopologyState(blueprint), {
          projection: "hard_goal_scope",
          goalNodeId: blueprint.goalNodeId as string
        });

        expect(result.node_count).toBe(0);
        expect(result.edge_count).toBe(0);
        expect(result.components).toEqual([]);
        expect(result.warnings).toEqual(["scope_has_no_unresolved_nodes"]);
      }),
      { numRuns: 40 }
    );
  });
});

function summarizeResult(result: ReturnType<typeof analyzeTopology>) {
  return {
    node_count: result.node_count,
    edge_count: result.edge_count,
    beta_0: result.beta_0,
    beta_1: result.beta_1,
    components: result.components,
    warnings: result.warnings
  };
}

function summarizeReference(reference: TopologyReferenceSummary) {
  return {
    node_count: reference.node_count,
    edge_count: reference.edge_count,
    beta_0: reference.beta_0,
    beta_1: reference.beta_1,
    components: reference.components,
    warnings: reference.warnings
  };
}

function summarizeResultWithoutWarnings(result: ReturnType<typeof analyzeTopology>) {
  return {
    node_count: result.node_count,
    edge_count: result.edge_count,
    beta_0: result.beta_0,
    beta_1: result.beta_1,
    components: result.components
  };
}

function expectCycleWitnessesToReferenceEdges(
  cycleWitnesses: ReturnType<typeof analyzeTopology>["cycle_witnesses"],
  reference: TopologyReferenceSummary
): void {
  const referenceNodeIds = new Set(reference.node_ids);
  const referenceEdgeKeys = new Set(reference.edge_keys);

  for (const witness of cycleWitnesses) {
    for (const nodeId of witness.node_ids) {
      expect(referenceNodeIds.has(nodeId)).toBe(true);
    }
    for (const edgePair of witness.edge_pairs) {
      const edgeKey = [edgePair.source_id, edgePair.target_id].sort().join("::");
      expect(referenceEdgeKeys.has(edgeKey)).toBe(true);
    }
  }
}
