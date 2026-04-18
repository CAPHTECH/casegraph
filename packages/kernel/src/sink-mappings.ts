import type {
  ProjectionMapping,
  ProjectionPulledPayload,
  ProjectionPushedPayload,
  SinkMappingDelta
} from "./sink-types.js";
import type { EventEnvelope } from "./types.js";

export function deriveProjectionMappings(events: EventEnvelope[]): ProjectionMapping[] {
  const mappings = new Map<string, ProjectionMapping>();

  for (const event of events) {
    if (event.type === "projection.pushed") {
      const payload = event.payload as unknown as ProjectionPushedPayload;
      applyDeltas(mappings, payload.sink_name, payload.mapping_deltas);
    } else if (event.type === "projection.pulled") {
      const payload = event.payload as unknown as ProjectionPulledPayload;
      applyDeltas(mappings, payload.sink_name, payload.mapping_deltas);
    }
  }

  return Array.from(mappings.values()).sort((left, right) => {
    if (left.sink_name !== right.sink_name) {
      return left.sink_name.localeCompare(right.sink_name);
    }
    return left.internal_node_id.localeCompare(right.internal_node_id);
  });
}

function applyDeltas(
  mappings: Map<string, ProjectionMapping>,
  sinkName: string,
  deltas: SinkMappingDelta[]
): void {
  for (const delta of deltas) {
    const key = `${sinkName}::${delta.internal_node_id}`;
    const existing = mappings.get(key);
    const next: ProjectionMapping = {
      sink_name: sinkName,
      internal_node_id: delta.internal_node_id,
      external_item_id: delta.external_item_id,
      last_pushed_at:
        delta.last_pushed_at !== undefined
          ? delta.last_pushed_at
          : (existing?.last_pushed_at ?? null),
      last_pulled_at:
        delta.last_pulled_at !== undefined
          ? delta.last_pulled_at
          : (existing?.last_pulled_at ?? null),
      last_known_external_hash:
        delta.last_known_external_hash !== undefined
          ? delta.last_known_external_hash
          : (existing?.last_known_external_hash ?? null),
      sync_policy_json: existing?.sync_policy_json ?? null
    };
    mappings.set(key, next);
  }
}
