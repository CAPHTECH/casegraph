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
        const goalNodeId = requireGoalNodeId(blueprint.goalNodeId);
        const result = analyzeTopology(buildTopologyState(blueprint), {
          projection: "hard_goal_scope",
          goalNodeId
        });
        const expected = buildReferenceTopology(blueprint, {
          projection: "hard_goal_scope"
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
        expect(canonicalizeCycleWitnesses(noisyResult.cycle_witnesses)).toEqual(
          canonicalizeCycleWitnesses(baseResult.cycle_witnesses)
        );
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
          goalNodeId: requireGoalNodeId(blueprint.goalNodeId)
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
    ...summarizeBase(result),
    warnings: result.warnings
  };
}

function summarizeReference(reference: TopologyReferenceSummary) {
  return {
    ...summarizeBase(reference),
    warnings: reference.warnings
  };
}

function summarizeResultWithoutWarnings(result: ReturnType<typeof analyzeTopology>) {
  return summarizeBase(result);
}

function summarizeBase<TComponents>(value: {
  node_count: number;
  edge_count: number;
  beta_0: number;
  beta_1: number;
  components: TComponents;
}) {
  return {
    node_count: value.node_count,
    edge_count: value.edge_count,
    beta_0: value.beta_0,
    beta_1: value.beta_1,
    components: value.components
  };
}

function canonicalizeCycleWitnesses(
  cycleWitnesses: ReturnType<typeof analyzeTopology>["cycle_witnesses"]
): string[] {
  return cycleWitnesses
    .map((witness) =>
      JSON.stringify({
        node_ids: [...witness.node_ids].sort((left, right) => left.localeCompare(right)),
        edge_pairs: witness.edge_pairs
          .map((edgePair) => [edgePair.source_id, edgePair.target_id].sort().join("::"))
          .sort((left, right) => left.localeCompare(right))
      })
    )
    .sort((left, right) => left.localeCompare(right));
}

function requireGoalNodeId(goalNodeId: string | undefined): string {
  if (typeof goalNodeId !== "string") {
    throw new Error("Invariant violation: goalNodeId must be defined");
  }
  return goalNodeId;
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
