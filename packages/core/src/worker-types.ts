import type { GraphPatch, NodeRecord } from "./types.js";

export type WorkerStatus = "succeeded" | "failed" | "partial" | "needs_approval";

export interface WorkerCapabilities {
  effectful: boolean;
  needs_approval?: boolean;
  read_files?: boolean;
  write_files?: boolean;
  network_access?: boolean;
  shell_access?: boolean;
}

export type ApprovalDecision = "auto" | "require" | "deny";

export interface WorkerArtifact {
  kind: string;
  path?: string;
  description?: string;
  metadata?: Record<string, unknown>;
}

export interface WorkerTaskSnapshot {
  node_id: string;
  kind: NodeRecord["kind"];
  title: string;
  description: string;
  state: NodeRecord["state"];
  acceptance: string[];
  labels: string[];
  metadata: Record<string, unknown>;
}

export interface WorkerRelatedNode {
  node_id: string;
  kind: NodeRecord["kind"];
  state: NodeRecord["state"];
  title: string;
  relation: "depends_on" | "waits_for" | "verifies";
}

export interface WorkerAttachmentRef {
  attachment_id: string;
  evidence_node_id: string;
  path_or_url: string;
  mime_type: string | null;
}

export interface WorkerTaskContext {
  related_nodes: WorkerRelatedNode[];
  attachments: WorkerAttachmentRef[];
  metadata: Record<string, unknown>;
}

export interface WorkerExecutionPolicy {
  effectful: boolean;
  approval: "not_required" | "auto" | "required";
  timeout_seconds: number;
  command_id: string;
}

export interface WorkerCaseHeader {
  case_id: string;
  title: string;
  base_revision: number;
}

export interface WorkerExecuteParams {
  case: WorkerCaseHeader;
  task: WorkerTaskSnapshot;
  context: WorkerTaskContext;
  execution_policy: WorkerExecutionPolicy;
}

export interface WorkerExecuteResult {
  status: WorkerStatus;
  summary?: string;
  artifacts?: WorkerArtifact[];
  observations?: string[];
  patch?: GraphPatch;
  exit_code?: number;
  warnings?: string[];
}

export interface WorkerDispatchedPayload {
  worker_name: string;
  node_id: string;
  command_id: string;
  capabilities: WorkerCapabilities;
  approval: ApprovalDecision;
}

export interface WorkerFinishedPayload {
  worker_name: string;
  node_id: string;
  command_id: string;
  status: WorkerStatus;
  summary: string;
  artifacts: WorkerArtifact[];
  observations: string[];
  patch_id: string | null;
  patch_path: string | null;
  exit_code: number | null;
}

const VALID_DECISIONS: ReadonlySet<string> = new Set<ApprovalDecision>(["auto", "require", "deny"]);

export function resolveApprovalDecision(
  policy: Record<string, string> | undefined,
  workerName: string,
  effectful: boolean
): ApprovalDecision {
  const raw = policy?.[workerName];
  if (raw && VALID_DECISIONS.has(raw)) {
    return raw as ApprovalDecision;
  }
  return effectful ? "require" : "auto";
}
