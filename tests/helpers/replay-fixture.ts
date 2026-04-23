import {
  createEvent,
  defaultActor,
  type NodeKind,
  type NodeState,
  replayCaseEvents
} from "@caphtech/casegraph-core";

export interface ReplayFixture {
  seed_mode?: "workspace" | "event_replay";
  case: { case_id: string; title: string; description: string };
  nodes: Array<{
    node_id: string;
    kind: NodeKind;
    title: string;
    state: NodeState;
    metadata?: Record<string, unknown>;
  }>;
  edges: Array<{
    edge_id: string;
    type: "depends_on" | "waits_for" | "alternative_to" | "verifies" | "contributes_to";
    source_id: string;
    target_id: string;
    metadata?: Record<string, unknown>;
  }>;
}

export function buildReplayStateFromFixture(fixture: ReplayFixture) {
  const baseTimestamp = new Date("2026-01-01T00:00:00.000Z").getTime();
  const actor = defaultActor();
  const caseId = fixture.case.case_id;
  const events = [
    createEvent({
      case_id: caseId,
      timestamp: new Date(baseTimestamp).toISOString(),
      actor,
      type: "case.created",
      payload: {
        case: {
          case_id: caseId,
          title: fixture.case.title,
          description: fixture.case.description,
          state: "open",
          labels: [],
          metadata: {},
          extensions: {},
          created_at: new Date(baseTimestamp).toISOString(),
          updated_at: new Date(baseTimestamp).toISOString()
        }
      }
    }),
    ...fixture.nodes.map((node, index) =>
      createEvent({
        case_id: caseId,
        timestamp: new Date(baseTimestamp + (index + 1) * 1_000).toISOString(),
        actor,
        type: "node.added",
        payload: {
          node: {
            node_id: node.node_id,
            kind: node.kind,
            title: node.title,
            description: "",
            state: node.state,
            labels: [],
            acceptance: [],
            metadata: node.metadata ?? {},
            extensions: {},
            created_at: new Date(baseTimestamp).toISOString(),
            updated_at: new Date(baseTimestamp).toISOString()
          }
        }
      })
    ),
    ...fixture.edges.map((edge, index) =>
      createEvent({
        case_id: caseId,
        timestamp: new Date(
          baseTimestamp + (fixture.nodes.length + index + 1) * 1_000
        ).toISOString(),
        actor,
        type: "edge.added",
        payload: {
          edge: {
            edge_id: edge.edge_id,
            type: edge.type,
            source_id: edge.source_id,
            target_id: edge.target_id,
            metadata: edge.metadata ?? {},
            extensions: {},
            created_at: new Date(baseTimestamp).toISOString()
          }
        }
      })
    )
  ];

  return replayCaseEvents(events);
}
