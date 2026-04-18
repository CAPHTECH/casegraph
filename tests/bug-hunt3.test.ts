/**
 * PBT-style bug hunt — exercises algorithm invariants across random graphs.
 */
import {
  analyzeBottlenecks,
  analyzeCriticalPath,
  analyzeImpact,
  createEvent,
  defaultActor,
  type EdgeRecord,
  type EventEnvelope,
  type GraphPatch,
  type NodeRecord,
  replayCaseEvents,
  reviewGraphPatch,
  SPEC_VERSION
} from "@caphtech/casegraph-core";
import fc from "fast-check";
import { describe, expect, it } from "vitest";

interface DagBlueprint {
  nodes: string[];
  edges: Array<{ edge_id: string; source: string; target: string }>;
}

const dagArb: fc.Arbitrary<DagBlueprint> = fc
  .integer({ min: 2, max: 8 })
  .chain((count) =>
    fc.uniqueArray(fc.stringMatching(/^n[0-9]{1,3}$/), {
      minLength: count,
      maxLength: count
    })
  )
  .chain((ids) =>
    fc
      .array(
        fc
          .tuple(
            fc.integer({ min: 0, max: ids.length - 2 }),
            fc.integer({ min: 1, max: ids.length - 1 })
          )
          .map(([a, b]) => [Math.min(a, b), Math.max(a, b)] as [number, number])
          .filter(([left, right]) => left < right),
        { minLength: 0, maxLength: ids.length * 2 }
      )
      .map((pairs) => {
        const uniq = new Set(pairs.map(([a, b]) => `${a}:${b}`));
        const edges = [...uniq].map((pair, idx) => {
          const [source, target] = pair.split(":").map(Number);
          return {
            edge_id: `e${idx}`,
            source: ids[source as number] as string,
            target: ids[target as number] as string
          };
        });
        return { nodes: ids, edges };
      })
  );

function buildEvents(blueprint: DagBlueprint): EventEnvelope[] {
  const timestamp = "2026-01-01T00:00:00.000Z";
  const actor = defaultActor();
  const events: EventEnvelope[] = [];
  events.push(
    createEvent({
      case_id: "c",
      timestamp,
      actor,
      type: "case.created",
      payload: {
        case: {
          case_id: "c",
          title: "c",
          description: "",
          state: "open",
          labels: [],
          metadata: {},
          extensions: {},
          created_at: timestamp,
          updated_at: timestamp
        }
      }
    })
  );
  for (const id of blueprint.nodes) {
    const node: NodeRecord = {
      node_id: id,
      kind: "task",
      title: id,
      description: "",
      state: "todo",
      labels: [],
      acceptance: [],
      metadata: {},
      extensions: {},
      created_at: timestamp,
      updated_at: timestamp
    };
    events.push(
      createEvent({
        case_id: "c",
        timestamp,
        actor,
        type: "node.added",
        payload: { node }
      })
    );
  }
  for (const e of blueprint.edges) {
    const edge: EdgeRecord = {
      edge_id: e.edge_id,
      type: "depends_on",
      source_id: e.source,
      target_id: e.target,
      metadata: {},
      extensions: {},
      created_at: timestamp
    };
    events.push(
      createEvent({
        case_id: "c",
        timestamp,
        actor,
        type: "edge.added",
        payload: { edge }
      })
    );
  }
  return events;
}

describe("PBT: analyzeImpact hard_impact monotonicity", () => {
  it("for every node, hard_impact does NOT include the source node", () => {
    fc.assert(
      fc.property(dagArb, (blueprint) => {
        if (blueprint.nodes.length === 0) return;
        const state = replayCaseEvents(buildEvents(blueprint));
        for (const id of blueprint.nodes) {
          const result = analyzeImpact(state, id);
          const includesSelf = result.hard_impact.some((h) => h.node_id === id);
          expect(includesSelf).toBe(false);
        }
      }),
      { numRuns: 40 }
    );
  });
});

describe("PBT: bottleneck summary downstream_count equals its downstream_node_ids length", () => {
  it("summary counts are consistent", () => {
    fc.assert(
      fc.property(dagArb, (blueprint) => {
        const state = replayCaseEvents(buildEvents(blueprint));
        const result = analyzeBottlenecks(state);
        for (const summary of result.nodes) {
          expect(summary.downstream_count).toBe(summary.downstream_node_ids.length);
          expect(summary.frontier_invalidation_count).toBe(
            summary.frontier_invalidation_node_ids.length
          );
          expect(summary.goal_context_count).toBe(summary.goal_context_node_ids.length);
        }
      }),
      { numRuns: 30 }
    );
  });
});

describe("PBT: critical path hop_count == node_ids.length - 1 when non-empty", () => {
  it("summary is internally consistent", () => {
    fc.assert(
      fc.property(dagArb, (blueprint) => {
        const state = replayCaseEvents(buildEvents(blueprint));
        const result = analyzeCriticalPath(state);
        if (result.depth_path.node_ids.length > 0) {
          expect(result.depth_path.hop_count).toBe(result.depth_path.node_ids.length - 1);
        } else {
          expect(result.depth_path.hop_count).toBe(0);
        }
      }),
      { numRuns: 30 }
    );
  });
});

describe("PBT: reviewGraphPatch with matching base_revision and single add_node always succeeds", () => {
  it("when operation is valid", () => {
    fc.assert(
      fc.property(dagArb, fc.integer({ min: 0, max: 9999 }), (blueprint, suffix) => {
        const newNodeId = `fresh_${suffix}`;
        if (blueprint.nodes.length === 0) return;
        if (blueprint.nodes.includes(newNodeId)) return;
        const state = replayCaseEvents(buildEvents(blueprint));
        const patch: GraphPatch = {
          patch_id: "p",
          spec_version: SPEC_VERSION,
          case_id: "c",
          base_revision: state.caseRecord.case_revision.current,
          summary: "add one node",
          operations: [
            {
              op: "add_node",
              node: {
                node_id: newNodeId,
                kind: "task",
                title: newNodeId,
                state: "todo"
              }
            }
          ]
        };
        const review = reviewGraphPatch(state, patch);
        expect(review.stale).toBe(false);
        expect(review.valid).toBe(true);
      }),
      { numRuns: 30 }
    );
  });
});

describe("PBT: add_node op with duplicate id is reported as conflict", () => {
  it("the dup detection is stable", () => {
    fc.assert(
      fc.property(dagArb, (blueprint) => {
        if (blueprint.nodes.length === 0) return;
        const state = replayCaseEvents(buildEvents(blueprint));
        const dupId = blueprint.nodes[0] as string;
        const patch: GraphPatch = {
          patch_id: "p",
          spec_version: SPEC_VERSION,
          case_id: "c",
          base_revision: state.caseRecord.case_revision.current,
          summary: "dup",
          operations: [
            {
              op: "add_node",
              node: { node_id: dupId, kind: "task", title: dupId, state: "todo" }
            }
          ]
        };
        const review = reviewGraphPatch(state, patch);
        expect(review.valid).toBe(false);
        expect(review.errors.some((e) => e.code === "patch_add_node_conflict")).toBe(true);
      }),
      { numRuns: 30 }
    );
  });
});

describe("PBT: every blocked task has at least one blocker reason", () => {
  it("is_blocked <=> blockers.length > 0", () => {
    fc.assert(
      fc.property(dagArb, (blueprint) => {
        const state = replayCaseEvents(buildEvents(blueprint));
        for (const [nodeId, derived] of state.derived.entries()) {
          if (derived.is_blocked) {
            expect(derived.blockers.length).toBeGreaterThan(0);
          } else {
            expect(derived.blockers.length).toBe(0);
          }
          expect(nodeId).toBe(derived.node_id);
        }
      }),
      { numRuns: 30 }
    );
  });
});
