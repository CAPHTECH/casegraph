import type { GraphPatch, NodeRecord } from "./types.js";

export type SinkOperationKind =
  | "upsert_item"
  | "complete_item"
  | "archive_item"
  | "set_label"
  | "set_due";

export interface SinkUpsertItemOperation {
  op: "upsert_item";
  internal_node_id: string;
  external_item_id?: string;
  title: string;
  labels?: string[];
  due_date?: string;
  note?: string;
}

export interface SinkCompleteItemOperation {
  op: "complete_item";
  internal_node_id: string;
  external_item_id: string;
}

export interface SinkArchiveItemOperation {
  op: "archive_item";
  internal_node_id: string;
  external_item_id: string;
}

export interface SinkSetLabelOperation {
  op: "set_label";
  internal_node_id: string;
  external_item_id: string;
  labels: string[];
}

export interface SinkSetDueOperation {
  op: "set_due";
  internal_node_id: string;
  external_item_id: string;
  due_date: string | null;
}

export type SinkOperation =
  | SinkUpsertItemOperation
  | SinkCompleteItemOperation
  | SinkArchiveItemOperation
  | SinkSetLabelOperation
  | SinkSetDueOperation;

export interface SinkCapabilities {
  push: boolean;
  pull: boolean;
  dry_run: boolean;
  supports_due_date?: boolean;
  supports_labels?: boolean;
  supports_notes?: boolean;
  supports_idempotency_key?: boolean;
}

export interface ProjectionMapping {
  sink_name: string;
  internal_node_id: string;
  external_item_id: string;
  last_pushed_at: string | null;
  last_pulled_at: string | null;
  last_known_external_hash: string | null;
  sync_policy_json: string | null;
}

export interface SinkMappingDelta {
  internal_node_id: string;
  external_item_id: string;
  last_pushed_at?: string;
  last_pulled_at?: string;
  last_known_external_hash?: string | null;
}

export interface SinkPlanProjectionParams {
  case_id: string;
  base_revision: number;
  actionable: ProjectionNodeSnapshot[];
  waiting: ProjectionNodeSnapshot[];
  mapping: ProjectionMapping[];
}

export interface SinkPlanProjectionResult {
  plan: SinkOperation[];
  warnings: string[];
}

export interface SinkApplyProjectionParams {
  case_id: string;
  plan: SinkOperation[];
}

export interface SinkApplyProjectionResult {
  applied: SinkOperation[];
  mapping_deltas: SinkMappingDelta[];
  warnings: string[];
}

export interface SinkPullChangesParams {
  case_id: string;
  base_revision: number;
  mapping: ProjectionMapping[];
}

export interface SinkPullChangesResult {
  patch: GraphPatch;
  mapping_deltas: SinkMappingDelta[];
  warnings: string[];
  item_count: number;
}

export interface ProjectionNodeSnapshot {
  node_id: string;
  kind: NodeRecord["kind"];
  state: NodeRecord["state"];
  title: string;
  labels: string[];
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface ProjectionTargets {
  actionable: ProjectionNodeSnapshot[];
  waiting: ProjectionNodeSnapshot[];
}

export interface ProjectionPushedPayload {
  sink_name: string;
  plan_summary: { op_counts: Record<SinkOperationKind, number> };
  mapping_deltas: SinkMappingDelta[];
  capabilities: SinkCapabilities;
}

export interface ProjectionPulledPayload {
  sink_name: string;
  item_count: number;
  patch_id: string;
  mapping_deltas: SinkMappingDelta[];
}
