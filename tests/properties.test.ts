import {
  createEvent,
  defaultActor,
  type EdgeRecord,
  type EdgeType,
  type EventEnvelope,
  type GraphPatch,
  type NodeKind,
  type NodeRecord,
  type NodeState,
  replayCaseEvents,
  reviewGraphPatch,
  SPEC_VERSION
} from "@casegraph/core";
import fc from "fast-check";
import { describe, expect, it } from "vitest";

interface GraphBlueprint {
  caseId: string;
  nodes: Array<{ node_id: string; kind: NodeKind; state: NodeState }>;
  edges: Array<{ edge_id: string; type: EdgeType; source_id: string; target_id: string }>;
}

const nodeKindArb = fc.constantFrom<NodeKind>("goal", "task", "decision", "event", "evidence");
const nodeStateArb = fc.constantFrom<NodeState>("todo", "doing", "done", "waiting");

const blueprintArb: fc.Arbitrary<GraphBlueprint> = fc
  .tuple(
    fc.integer({ min: 2, max: 6 }).chain((count) =>
      fc.tuple(
        fc.uniqueArray(fc.stringMatching(/^n[0-9]{1,3}$/), {
          minLength: count,
          maxLength: count
        }),
        fc.array(fc.tuple(nodeKindArb, nodeStateArb), { minLength: count, maxLength: count })
      )
    ),
    fc.integer({ min: 0, max: 4 })
  )
  .map(([[ids, meta], edgeCount]) => {
    const nodes = ids.map((id, index) => {
      const pair = meta[index] as [NodeKind, NodeState];
      return { node_id: id, kind: pair[0], state: pair[1] };
    });

    const edges: GraphBlueprint["edges"] = [];
    for (let i = 0; i < edgeCount && nodes.length >= 2; i += 1) {
      const source = nodes[i % nodes.length] as GraphBlueprint["nodes"][number];
      const target = nodes[(i + 1) % nodes.length] as GraphBlueprint["nodes"][number];
      if (source.node_id === target.node_id) {
        continue;
      }
      edges.push({
        edge_id: `e${i}`,
        type: "depends_on",
        source_id: source.node_id,
        target_id: target.node_id
      });
    }

    return { caseId: "prop-case", nodes, edges };
  });

const acyclicBlueprintArb: fc.Arbitrary<GraphBlueprint> = blueprintArb.map((blueprint) => ({
  ...blueprint,
  edges: blueprint.edges.filter((edge) => edge.source_id < edge.target_id)
}));

describe("property: reducer & validation invariants", () => {
  it("P1 replay is deterministic across repeated calls", () => {
    fc.assert(
      fc.property(blueprintArb, (blueprint) => {
        const events = eventsFromBlueprint(blueprint);
        const a = replayCaseEvents(events);
        const b = replayCaseEvents(events);
        expect(snapshot(a)).toEqual(snapshot(b));
      }),
      { numRuns: 40 }
    );
  });

  it("P2 unique node_ids: replay map size equals distinct node_ids", () => {
    fc.assert(
      fc.property(blueprintArb, (blueprint) => {
        const events = eventsFromBlueprint(blueprint);
        const state = replayCaseEvents(events);
        expect(state.nodes.size).toBe(new Set(blueprint.nodes.map((n) => n.node_id)).size);
      }),
      { numRuns: 40 }
    );
  });

  it("P3 depends_on cycle is reported as hard_dependency_cycle", () => {
    fc.assert(
      fc.property(
        acyclicBlueprintArb.filter((blueprint) => blueprint.edges.length > 0),
        (blueprint) => {
          const firstEdge = blueprint.edges[0] as GraphBlueprint["edges"][number];
          const backEdge = {
            edge_id: "e_back",
            type: "depends_on" as EdgeType,
            source_id: firstEdge.target_id,
            target_id: firstEdge.source_id
          };
          const events = eventsFromBlueprint({
            ...blueprint,
            edges: [...blueprint.edges, backEdge]
          });
          const state = replayCaseEvents(events);
          const hasCycle = state.validation.some(
            (issue) => issue.code === "hard_dependency_cycle" && issue.severity === "error"
          );
          expect(hasCycle).toBe(true);
        }
      ),
      { numRuns: 40 }
    );
  });

  it("P4 frontier excludes blocked nodes", () => {
    fc.assert(
      fc.property(blueprintArb, (blueprint) => {
        const state = replayCaseEvents(eventsFromBlueprint(blueprint));
        for (const node of state.nodes.values()) {
          const derived = state.derived.get(node.node_id);
          if (!derived) {
            continue;
          }
          if (derived.is_ready) {
            expect(derived.is_blocked).toBe(false);
          }
        }
      }),
      { numRuns: 40 }
    );
  });

  it("P5 patches with a stale base_revision are rejected", () => {
    fc.assert(
      fc.property(acyclicBlueprintArb, fc.integer({ min: -5, max: 500 }), (blueprint, offset) => {
        const state = replayCaseEvents(eventsFromBlueprint(blueprint));
        const current = state.caseRecord.case_revision.current;
        const staleRevision = current + offset;
        if (staleRevision === current) {
          return;
        }
        const patch: GraphPatch = {
          patch_id: "patch_prop",
          spec_version: SPEC_VERSION,
          case_id: blueprint.caseId,
          base_revision: staleRevision,
          summary: "prop stale",
          operations: [
            {
              op: "add_node",
              node: {
                node_id: "n_new",
                kind: "task",
                state: "todo",
                title: "n_new"
              }
            }
          ]
        };
        const review = reviewGraphPatch(state, patch);
        expect(review.stale).toBe(true);
        expect(review.valid).toBe(false);
      }),
      { numRuns: 40 }
    );
  });
});

function eventsFromBlueprint(blueprint: GraphBlueprint): EventEnvelope[] {
  const timestamp = "2026-01-01T00:00:00.000Z";
  const actor = defaultActor();
  const events: EventEnvelope[] = [];

  events.push(
    createEvent({
      case_id: blueprint.caseId,
      timestamp,
      actor,
      type: "case.created",
      payload: {
        case: {
          case_id: blueprint.caseId,
          title: blueprint.caseId,
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

  for (const node of blueprint.nodes) {
    const nodeRecord: NodeRecord = {
      node_id: node.node_id,
      kind: node.kind,
      title: node.node_id,
      description: "",
      state: node.state,
      labels: [],
      acceptance: [],
      metadata: {},
      extensions: {},
      created_at: timestamp,
      updated_at: timestamp
    };
    events.push(
      createEvent({
        case_id: blueprint.caseId,
        timestamp,
        actor,
        type: "node.added",
        payload: { node: nodeRecord }
      })
    );
  }

  for (const edge of blueprint.edges) {
    const edgeRecord: EdgeRecord = {
      edge_id: edge.edge_id,
      type: edge.type,
      source_id: edge.source_id,
      target_id: edge.target_id,
      metadata: {},
      extensions: {},
      created_at: timestamp
    };
    events.push(
      createEvent({
        case_id: blueprint.caseId,
        timestamp,
        actor,
        type: "edge.added",
        payload: { edge: edgeRecord }
      })
    );
  }

  return events;
}

function snapshot(state: ReturnType<typeof replayCaseEvents>) {
  return {
    caseRecord: state.caseRecord,
    nodes: Array.from(state.nodes.entries()),
    edges: Array.from(state.edges.entries()),
    derived: Array.from(state.derived.entries()),
    validation: state.validation
  };
}
