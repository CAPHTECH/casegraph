export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export interface JsonObject {
  [key: string]: JsonValue;
}

export type CaseState = "open" | "closed" | "archived";
export type NodeKind = "goal" | "task" | "decision" | "event" | "evidence";
export type NodeState = "proposed" | "todo" | "doing" | "waiting" | "done" | "cancelled" | "failed";
export type EdgeType =
  | "depends_on"
  | "waits_for"
  | "alternative_to"
  | "verifies"
  | "contributes_to";

export interface ActorRef {
  kind: "user";
  id: string;
  display_name: string;
}

export interface RevisionSnapshot {
  current: number;
  last_event_id: string | null;
}

export interface WorkspaceRecord {
  workspace_id: string;
  title: string;
  spec_version: string;
  created_at: string;
  updated_at: string;
}

export interface CommandPluginConfig {
  command: string[];
  env_allowlist?: string[];
}

export interface ConfigRecord {
  default_format: "text" | "json";
  approval_policy?: Record<string, string>;
  importers?: Record<string, CommandPluginConfig>;
  sinks?: Record<string, CommandPluginConfig>;
  workers?: Record<string, CommandPluginConfig>;
}

export interface CaseRecord {
  case_id: string;
  title: string;
  description: string;
  state: CaseState;
  labels: string[];
  metadata: Record<string, unknown>;
  extensions: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  case_revision: RevisionSnapshot;
}

export interface NodeRecord {
  node_id: string;
  kind: NodeKind;
  title: string;
  description: string;
  state: NodeState;
  labels: string[];
  acceptance: string[];
  metadata: Record<string, unknown>;
  extensions: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface EdgeRecord {
  edge_id: string;
  type: EdgeType;
  source_id: string;
  target_id: string;
  metadata: Record<string, unknown>;
  extensions: Record<string, unknown>;
  created_at: string;
}

export interface AttachmentRecord {
  attachment_id: string;
  evidence_node_id: string;
  storage_mode: "workspace_copy" | "absolute_path" | "url";
  path_or_url: string;
  sha256: string | null;
  mime_type: string | null;
  size_bytes: number | null;
  created_at: string;
}

export type EventType =
  | "case.created"
  | "case.updated"
  | "node.added"
  | "node.updated"
  | "node.state_changed"
  | "edge.added"
  | "edge.removed"
  | "event.recorded"
  | "evidence.attached"
  | "patch.applied"
  | "projection.pushed"
  | "projection.pulled"
  | "worker.dispatched"
  | "worker.finished";

export interface EventEnvelope<TPayload = Record<string, unknown>> {
  event_id: string;
  spec_version: string;
  case_id: string;
  timestamp: string;
  actor: ActorRef;
  type: EventType;
  payload: TPayload;
  source?: "cli" | "patch" | "worker" | "sync";
  command_id?: string;
  correlation_id?: string;
  causation_id?: string;
  revision_hint?: number;
}

export interface BlockerReason {
  kind: "depends_on" | "waits_for" | "state" | "cycle";
  ref?: string;
  message: string;
}

export interface DerivedNodeState {
  node_id: string;
  is_ready: boolean;
  is_blocked: boolean;
  blockers: BlockerReason[];
  waiting_for: string[];
  dependency_satisfied_ratio: number;
  has_unverified_completion: boolean;
}

export interface ValidationIssue {
  severity: "error" | "warning";
  code: string;
  message: string;
  ref?: string;
}

export interface PatchValidationData {
  valid: boolean;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
  patch: GraphPatch | null;
}

export interface CaseStateView {
  caseRecord: CaseRecord;
  nodes: Map<string, NodeRecord>;
  edges: Map<string, EdgeRecord>;
  attachments: Map<string, AttachmentRecord>;
  events: EventEnvelope[];
  derived: Map<string, DerivedNodeState>;
  validation: ValidationIssue[];
}

export interface CaseCounts {
  nodes_by_kind: Record<NodeKind, number>;
  nodes_by_state: Record<NodeState, number>;
  edge_count: number;
}

export interface FrontierItem extends NodeRecord {
  derived: DerivedNodeState;
}

export interface BlockedItem {
  node: NodeRecord;
  reasons: BlockerReason[];
}

export interface ImpactedNodeSummary {
  node_id: string;
  kind: NodeKind;
  state: NodeState;
  title: string;
  distance: number;
  via_node_ids: string[];
  via_edge_ids: string[];
}

export interface ImpactAnalysisResult {
  case_id: string;
  revision: RevisionSnapshot;
  source_node_id: string;
  hard_impact: ImpactedNodeSummary[];
  context_impact: ImpactedNodeSummary[];
  frontier_invalidations: ImpactedNodeSummary[];
  warnings: string[];
}

export interface AnalysisTraceNode {
  node_id: string;
  kind: NodeKind;
  state: NodeState;
  title: string;
  estimate_minutes: number | null;
}

export interface CriticalPathSummary {
  node_ids: string[];
  edge_ids: string[];
  hop_count: number;
  total_estimate_minutes: number | null;
  steps: AnalysisTraceNode[];
}

export interface CriticalPathAnalysisResult {
  case_id: string;
  revision: RevisionSnapshot;
  goal_node_id: string | null;
  depth_path: CriticalPathSummary;
  duration_path: CriticalPathSummary | null;
  missing_estimate_node_ids: string[];
  warnings: string[];
}

export interface WorkspaceContextOptions {
  workspaceOverride?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

export interface MutationContext {
  actor?: ActorRef;
  now?: string;
  commandId?: string;
}

export interface AddNodeInput {
  caseId: string;
  node: Omit<NodeRecord, "created_at" | "updated_at"> & {
    created_at?: string;
    updated_at?: string;
  };
}

export interface UpdateNodeInput {
  caseId: string;
  nodeId: string;
  changes: Partial<
    Pick<NodeRecord, "title" | "description" | "labels" | "acceptance" | "metadata" | "extensions">
  >;
}

export interface AddEdgeInput {
  caseId: string;
  edge: Omit<EdgeRecord, "created_at"> & { created_at?: string };
}

export interface ChangeNodeStateInput {
  caseId: string;
  nodeId: string;
  state: NodeState;
  metadata?: Record<string, unknown>;
}

export interface AddEvidenceInput {
  caseId: string;
  evidence: Omit<NodeRecord, "kind" | "created_at" | "updated_at"> & {
    node_id: string;
    kind?: "evidence";
    created_at?: string;
    updated_at?: string;
  };
  verifiesTargetId?: string;
  attachment?: Omit<AttachmentRecord, "created_at"> & { created_at?: string };
}

export interface PatchGenerator {
  kind: "user" | "planner" | "normalizer" | "worker" | "sync" | string;
  name: string;
  version?: string;
}

export interface PatchNodeInput {
  node_id: string;
  kind: NodeKind;
  title: string;
  state: NodeState;
  description?: string;
  labels?: string[];
  acceptance?: string[];
  metadata?: Record<string, unknown>;
  extensions?: Record<string, unknown>;
}

export interface PatchNodeChanges {
  title?: string;
  description?: string;
  labels?: string[];
  acceptance?: string[];
  metadata?: Record<string, unknown>;
  extensions?: Record<string, unknown>;
}

export interface PatchEdgeInput {
  edge_id: string;
  type: EdgeType;
  source_id: string;
  target_id: string;
  metadata?: Record<string, unknown>;
  extensions?: Record<string, unknown>;
}

export interface PatchAttachmentInput {
  attachment_id?: string;
  storage_mode: AttachmentRecord["storage_mode"];
  path_or_url: string;
  sha256?: string | null;
  mime_type?: string | null;
  size_bytes?: number | null;
}

export interface AddNodePatchOperation {
  op: "add_node";
  node: PatchNodeInput;
}

export interface UpdateNodePatchOperation {
  op: "update_node";
  node_id: string;
  changes: PatchNodeChanges;
}

export interface RemoveNodePatchOperation {
  op: "remove_node";
  node_id: string;
}

export interface AddEdgePatchOperation {
  op: "add_edge";
  edge: PatchEdgeInput;
}

export interface RemoveEdgePatchOperation {
  op: "remove_edge";
  edge_id: string;
}

export interface ChangeStatePatchOperation {
  op: "change_state";
  node_id: string;
  state: NodeState;
  metadata?: Record<string, unknown>;
}

export interface AttachEvidencePatchOperation {
  op: "attach_evidence";
  evidence: Omit<PatchNodeInput, "kind" | "state"> & {
    kind?: "evidence";
    state?: "done";
  };
  verifies_target_id?: string;
  attachment?: PatchAttachmentInput;
}

export interface SetCaseFieldPatchOperation {
  op: "set_case_field";
  changes: Partial<
    Pick<CaseRecord, "title" | "description" | "state" | "labels" | "metadata" | "extensions">
  >;
}

export type GraphPatchOperation =
  | AddNodePatchOperation
  | UpdateNodePatchOperation
  | RemoveNodePatchOperation
  | AddEdgePatchOperation
  | RemoveEdgePatchOperation
  | ChangeStatePatchOperation
  | AttachEvidencePatchOperation
  | SetCaseFieldPatchOperation;

export interface GraphPatch {
  patch_id: string;
  spec_version: string;
  case_id: string;
  base_revision: number;
  summary: string;
  generator?: PatchGenerator;
  operations: GraphPatchOperation[];
  notes?: string[];
  risks?: string[];
}

export interface PatchRisk {
  op_index: number;
  op: GraphPatchOperation["op"];
  reason: string;
}

export interface PatchReview {
  patch_id: string;
  case_id: string;
  base_revision: number;
  current_revision: number;
  stale: boolean;
  valid: boolean;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
  risky_ops: PatchRisk[];
  op_counts: Partial<Record<GraphPatchOperation["op"], number>>;
}

export interface ImporterInputFile {
  kind: "file";
  path: string;
}

export interface ImporterIngestParams {
  case_id: string;
  base_revision: number;
  input: ImporterInputFile;
  options?: {
    mode?: "append";
  };
}

export interface ImporterIngestResult {
  patch: GraphPatch;
  warnings: string[];
}

export interface JsonRpcRequest<TParams> {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params?: TParams;
}

export interface JsonRpcSuccess<TResult> {
  jsonrpc: "2.0";
  id: number | string;
  result: TResult;
}

export interface JsonRpcErrorResponse {
  jsonrpc: "2.0";
  id: number | string | null;
  error: {
    code: number;
    message: string;
    data?: unknown;
  };
}

export type JsonRpcResponse<TResult> = JsonRpcSuccess<TResult> | JsonRpcErrorResponse;
