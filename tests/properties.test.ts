import {
  analyzeCriticalPath,
  analyzeImpact,
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

const analysisDagArb: fc.Arbitrary<GraphBlueprint> = fc
  .integer({ min: 2, max: 6 })
  .chain((count) =>
    fc
      .uniqueArray(fc.integer({ min: 1, max: 999 }), { minLength: count, maxLength: count })
      .map((values) => values.sort((left, right) => left - right).map((value) => `d${value}`))
  )
  .chain((ids) =>
    fc
      .array(
        fc
          .tuple(
            fc.integer({ min: 0, max: ids.length - 1 }),
            fc.integer({ min: 0, max: ids.length - 1 })
          )
          .filter(([targetIndex, sourceIndex]) => targetIndex < sourceIndex),
        { minLength: 0, maxLength: ids.length * 2 }
      )
      .map((pairs) => {
        const uniquePairs = [
          ...new Set(pairs.map(([targetIndex, sourceIndex]) => `${targetIndex}:${sourceIndex}`))
        ];
        return {
          caseId: "prop-analysis",
          nodes: ids.map((id) => ({
            node_id: id,
            kind: "task" as NodeKind,
            state: "todo" as NodeState
          })),
          edges: uniquePairs.map((pair, index) => {
            const [targetIndex, sourceIndex] = pair.split(":").map((value) => Number(value));
            return {
              edge_id: `ae${index}`,
              type: "depends_on" as EdgeType,
              source_id: ids[sourceIndex] as string,
              target_id: ids[targetIndex] as string
            };
          })
        };
      })
  );

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

  it("P6 impact hard_impact matches reverse hard reachability", () => {
    fc.assert(
      fc.property(blueprintArb, fc.integer({ min: 0, max: 20 }), (blueprint, pick) => {
        const state = replayCaseEvents(eventsFromBlueprint(blueprint));
        const sourceNode = blueprint.nodes[pick % blueprint.nodes.length];
        if (!sourceNode) {
          return;
        }
        const sourceNodeId = sourceNode.node_id;
        const result = analyzeImpact(state, sourceNodeId);
        expect(result.hard_impact.map((node) => node.node_id)).toEqual(
          reverseReachableNodeIds(blueprint.edges, sourceNodeId)
        );
      }),
      { numRuns: 40 }
    );
  });

  it("P7 critical path hop count matches the longest path of an acyclic hard graph", () => {
    fc.assert(
      fc.property(analysisDagArb, (blueprint) => {
        const state = replayCaseEvents(eventsFromBlueprint(blueprint));
        const result = analyzeCriticalPath(state);
        expect(isValidNormalizedPath(blueprint.edges, result.depth_path.node_ids)).toBe(true);
        expect(result.depth_path.hop_count).toBe(longestHopCount(blueprint.edges, blueprint.nodes));
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

function reverseReachableNodeIds(edges: GraphBlueprint["edges"], sourceNodeId: string): string[] {
  const adjacency = buildReverseAdjacency(edges);
  const visited = collectReachableNodeIds(adjacency, sourceNodeId);
  const distances = collectReachableDistances(adjacency, sourceNodeId);

  return [...visited]
    .filter((nodeId) => nodeId !== sourceNodeId)
    .sort((left, right) => {
      const leftDistance = distances.get(left) ?? Number.MAX_SAFE_INTEGER;
      const rightDistance = distances.get(right) ?? Number.MAX_SAFE_INTEGER;
      if (leftDistance !== rightDistance) {
        return leftDistance - rightDistance;
      }
      return left.localeCompare(right);
    });
}

function buildReverseAdjacency(edges: GraphBlueprint["edges"]): Map<string, Set<string>> {
  const adjacency = new Map<string, Set<string>>();
  for (const edge of edges) {
    const targetSources = adjacency.get(edge.target_id) ?? new Set<string>();
    targetSources.add(edge.source_id);
    adjacency.set(edge.target_id, targetSources);
  }
  return adjacency;
}

function collectReachableNodeIds(
  adjacency: Map<string, Set<string>>,
  sourceNodeId: string
): Set<string> {
  const visited = new Set<string>([sourceNodeId]);
  const queue = [sourceNodeId];

  while (queue.length > 0) {
    const currentNodeId = queue.shift() as string;
    for (const nextNodeId of sortedAdjacentNodeIds(adjacency, currentNodeId)) {
      if (visited.has(nextNodeId)) {
        continue;
      }
      visited.add(nextNodeId);
      queue.push(nextNodeId);
    }
  }

  return visited;
}

function collectReachableDistances(
  adjacency: Map<string, Set<string>>,
  sourceNodeId: string
): Map<string, number> {
  const distances = new Map<string, number>([[sourceNodeId, 0]]);
  const queue = [sourceNodeId];

  while (queue.length > 0) {
    const currentNodeId = queue.shift() as string;
    for (const nextNodeId of sortedAdjacentNodeIds(adjacency, currentNodeId)) {
      if (distances.has(nextNodeId)) {
        continue;
      }
      distances.set(nextNodeId, (distances.get(currentNodeId) ?? 0) + 1);
      queue.push(nextNodeId);
    }
  }

  return distances;
}

function sortedAdjacentNodeIds(adjacency: Map<string, Set<string>>, nodeId: string): string[] {
  return [...(adjacency.get(nodeId) ?? new Set())].sort((left, right) => left.localeCompare(right));
}

function isValidNormalizedPath(edges: GraphBlueprint["edges"], nodeIds: string[]): boolean {
  if (nodeIds.length <= 1) {
    return true;
  }

  const normalizedEdges = new Set(edges.map((edge) => `${edge.target_id}->${edge.source_id}`));
  for (let index = 0; index < nodeIds.length - 1; index += 1) {
    const key = `${nodeIds[index]}->${nodeIds[index + 1]}`;
    if (!normalizedEdges.has(key)) {
      return false;
    }
  }

  return true;
}

function longestHopCount(edges: GraphBlueprint["edges"], nodes: GraphBlueprint["nodes"]): number {
  const adjacency = new Map<string, string[]>(nodes.map((node) => [node.node_id, [] as string[]]));
  const indegree = new Map<string, number>(nodes.map((node) => [node.node_id, 0]));

  for (const edge of edges) {
    adjacency.get(edge.target_id)?.push(edge.source_id);
    indegree.set(edge.source_id, (indegree.get(edge.source_id) ?? 0) + 1);
  }

  for (const [nodeId, nextIds] of adjacency.entries()) {
    nextIds.sort((left, right) => left.localeCompare(right));
    adjacency.set(nodeId, nextIds);
  }

  const available = [...nodes.map((node) => node.node_id)]
    .filter((nodeId) => (indegree.get(nodeId) ?? 0) === 0)
    .sort((left, right) => left.localeCompare(right));
  const best = new Map<string, number>(nodes.map((node) => [node.node_id, 0]));

  while (available.length > 0) {
    const nodeId = available.shift() as string;
    for (const nextNodeId of adjacency.get(nodeId) ?? []) {
      best.set(nextNodeId, Math.max(best.get(nextNodeId) ?? 0, (best.get(nodeId) ?? 0) + 1));
      indegree.set(nextNodeId, (indegree.get(nextNodeId) ?? 0) - 1);
      if ((indegree.get(nextNodeId) ?? 0) === 0) {
        available.push(nextNodeId);
        available.sort((left, right) => left.localeCompare(right));
      }
    }
  }

  return Math.max(0, ...best.values());
}
