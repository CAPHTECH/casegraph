export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export interface JsonObject {
  [key: string]: JsonValue;
}

export type CaseState = "open" | "closed" | "archived";
export type NodeKind = "goal" | "task" | "decision" | "event" | "evidence";
export type NodeState =
  | "proposed"
  | "todo"
  | "doing"
  | "waiting"
  | "done"
  | "cancelled"
  | "failed";
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

export interface ConfigRecord {
  default_format: "text" | "json";
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
  | "evidence.attached";

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

export interface CommandSuccess<TData> {
  ok: true;
  command: string;
  data: TData;
  revision?: RevisionSnapshot;
}

export interface CommandFailure {
  ok: false;
  command: string;
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

export type CommandResult<TData> = CommandSuccess<TData> | CommandFailure;

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
    Pick<
      NodeRecord,
      "title" | "description" | "labels" | "acceptance" | "metadata" | "extensions"
    >
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

