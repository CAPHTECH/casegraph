import { SPEC_VERSION } from "./constants.js";
import {
  cloneRecord,
  ensureArray,
  ensureObject,
  generateId,
  sanitizeAttachmentRecord,
  sanitizeCaseRecord,
  sanitizeEdgeRecord,
  sanitizeNodeRecord
} from "./helpers.js";
import type {
  AttachmentRecord,
  CaseRecord,
  CaseStateView,
  EdgeRecord,
  GraphPatch,
  GraphPatchOperation,
  NodeRecord,
  PatchAttachmentInput,
  PatchNodeChanges,
  PatchReview,
  ValidationIssue
} from "./types.js";
import { deriveNodeStates, validateGraph } from "./validation.js";

const CASE_STATES = new Set(["open", "closed", "archived"]);
const EDGE_TYPES = new Set([
  "depends_on",
  "waits_for",
  "alternative_to",
  "verifies",
  "contributes_to"
]);
const NODE_KINDS = new Set(["goal", "task", "decision", "event", "evidence"]);
const NODE_STATES = new Set([
  "proposed",
  "todo",
  "doing",
  "waiting",
  "done",
  "cancelled",
  "failed"
]);
const STORAGE_MODES = new Set(["workspace_copy", "absolute_path", "url"]);

interface PatchDraftState {
  caseRecord: CaseRecord;
  nodes: Map<string, NodeRecord>;
  edges: Map<string, EdgeRecord>;
  attachments: Map<string, AttachmentRecord>;
}

export function validateGraphPatchDocument(input: unknown): {
  patch: GraphPatch | null;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
} {
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];

  if (!isRecord(input)) {
    return {
      patch: null,
      errors: [
        {
          severity: "error",
          code: "patch_not_object",
          message: "Patch document must be an object"
        }
      ],
      warnings
    };
  }

  const patchId = requireString(input.patch_id, "patch.patch_id", errors);
  const specVersion = requireString(input.spec_version, "patch.spec_version", errors);
  const caseId = requireString(input.case_id, "patch.case_id", errors);
  const baseRevision = requireNumber(input.base_revision, "patch.base_revision", errors);
  const summary = requireString(input.summary, "patch.summary", errors);
  const operations = parseOperations(input.operations, errors);

  const generator = parseGenerator(input.generator, errors);
  const notes = parseStringArray(input.notes, "patch.notes", errors);
  const risks = parseStringArray(input.risks, "patch.risks", errors);

  if (specVersion && specVersion !== SPEC_VERSION) {
    errors.push({
      severity: "error",
      code: "patch_spec_version_mismatch",
      message: `Unsupported patch spec_version ${specVersion}`,
      ref: "patch.spec_version"
    });
  }

  if (operations.length === 0) {
    errors.push({
      severity: "error",
      code: "patch_operations_empty",
      message: "Patch must contain at least one operation",
      ref: "patch.operations"
    });
  }

  const patch =
    errors.length === 0 && patchId && specVersion && caseId && baseRevision !== null && summary
      ? {
          patch_id: patchId,
          spec_version: specVersion,
          case_id: caseId,
          base_revision: baseRevision,
          summary,
          generator: generator ?? undefined,
          operations,
          notes,
          risks
        }
      : null;

  return { patch, errors, warnings };
}

export function reviewGraphPatch(state: CaseStateView, patch: GraphPatch): PatchReview {
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];
  const opCounts = countPatchOperations(patch.operations);
  const riskyOps = classifyPatchRisks(patch);
  const stale = patch.base_revision !== state.caseRecord.case_revision.current;

  if (patch.case_id !== state.caseRecord.case_id) {
    errors.push({
      severity: "error",
      code: "patch_case_mismatch",
      message: `Patch case_id ${patch.case_id} does not match ${state.caseRecord.case_id}`,
      ref: "patch.case_id"
    });
  }

  if (stale) {
    errors.push({
      severity: "error",
      code: "patch_base_revision_stale",
      message: `Patch base_revision ${patch.base_revision} does not match current revision ${state.caseRecord.case_revision.current}`,
      ref: "patch.base_revision"
    });
  }

  const draft = cloneDraftState(state);
  const applyErrors = applyPatchOperationsToDraft(draft, patch, state.caseRecord.updated_at);
  errors.push(...applyErrors);

  const graphIssues = validateGraph(draft.nodes, draft.edges, draft.attachments);
  for (const issue of graphIssues) {
    if (issue.severity === "error") {
      errors.push(issue);
    } else {
      warnings.push(issue);
    }
  }

  return {
    patch_id: patch.patch_id,
    case_id: patch.case_id,
    base_revision: patch.base_revision,
    current_revision: state.caseRecord.case_revision.current,
    stale,
    valid: errors.length === 0,
    errors,
    warnings,
    risky_ops: riskyOps,
    op_counts: opCounts
  };
}

export function applyPatchOperationsToDraft(
  draft: PatchDraftState,
  patch: GraphPatch,
  timestamp: string
): ValidationIssue[] {
  const errors: ValidationIssue[] = [];

  for (let index = 0; index < patch.operations.length; index += 1) {
    const operation = patch.operations[index] as GraphPatchOperation;
    const ref = `patch.operations[${index}]`;

    switch (operation.op) {
      case "add_node": {
        applyAddNodeOperation(draft, operation, timestamp, ref, errors);
        break;
      }

      case "update_node": {
        applyUpdateNodeOperation(draft, operation, timestamp, ref, errors);
        break;
      }

      case "remove_node": {
        applyRemoveNodeOperation(draft, operation, ref, errors);
        break;
      }

      case "add_edge": {
        applyAddEdgeOperation(draft, operation, timestamp, ref, errors);
        break;
      }

      case "remove_edge": {
        applyRemoveEdgeOperation(draft, operation, ref, errors);
        break;
      }

      case "change_state": {
        applyChangeStateOperation(draft, operation, timestamp, ref, errors);
        break;
      }

      case "attach_evidence": {
        applyAttachEvidenceOperation(draft, operation, timestamp, ref, errors);
        break;
      }

      case "set_case_field": {
        applySetCaseFieldOperation(draft, operation);
        break;
      }
    }
  }

  return errors;
}

function applyAddNodeOperation(
  draft: PatchDraftState,
  operation: Extract<GraphPatchOperation, { op: "add_node" }>,
  timestamp: string,
  ref: string,
  errors: ValidationIssue[]
): void {
  const node = operation.node;
  if (draft.nodes.has(node.node_id)) {
    errors.push({
      severity: "error",
      code: "patch_add_node_conflict",
      message: `Node ${node.node_id} already exists`,
      ref
    });
    return;
  }

  draft.nodes.set(
    node.node_id,
    sanitizeNodeRecord({
      node_id: node.node_id,
      kind: node.kind,
      title: node.title,
      description: node.description ?? "",
      state: node.state,
      labels: ensureArray(node.labels),
      acceptance: ensureArray(node.acceptance),
      metadata: ensureObject(node.metadata),
      extensions: ensureObject(node.extensions),
      created_at: timestamp,
      updated_at: timestamp
    })
  );
}

function applyUpdateNodeOperation(
  draft: PatchDraftState,
  operation: Extract<GraphPatchOperation, { op: "update_node" }>,
  timestamp: string,
  ref: string,
  errors: ValidationIssue[]
): void {
  const existing = draft.nodes.get(operation.node_id);
  if (!existing) {
    errors.push({
      severity: "error",
      code: "patch_update_node_missing",
      message: `Node ${operation.node_id} does not exist`,
      ref
    });
    return;
  }

  draft.nodes.set(
    operation.node_id,
    sanitizeNodeRecord({
      ...existing,
      ...cloneNodeChanges(operation.changes),
      updated_at: timestamp
    })
  );
}

function applyRemoveNodeOperation(
  draft: PatchDraftState,
  operation: Extract<GraphPatchOperation, { op: "remove_node" }>,
  ref: string,
  errors: ValidationIssue[]
): void {
  if (!draft.nodes.has(operation.node_id)) {
    errors.push({
      severity: "error",
      code: "patch_remove_node_missing",
      message: `Node ${operation.node_id} does not exist`,
      ref
    });
    return;
  }

  draft.nodes.delete(operation.node_id);
  removeAttachmentsForNode(draft.attachments, operation.node_id);
}

function removeAttachmentsForNode(
  attachments: Map<string, AttachmentRecord>,
  nodeId: string
): void {
  for (const [attachmentId, attachment] of attachments.entries()) {
    if (attachment.evidence_node_id === nodeId) {
      attachments.delete(attachmentId);
    }
  }
}

function applyAddEdgeOperation(
  draft: PatchDraftState,
  operation: Extract<GraphPatchOperation, { op: "add_edge" }>,
  timestamp: string,
  ref: string,
  errors: ValidationIssue[]
): void {
  if (!(draft.nodes.has(operation.edge.source_id) && draft.nodes.has(operation.edge.target_id))) {
    errors.push({
      severity: "error",
      code: "patch_add_edge_missing_node",
      message: `Edge ${operation.edge.edge_id} references missing node at apply time`,
      ref
    });
    return;
  }

  if (draft.edges.has(operation.edge.edge_id)) {
    errors.push({
      severity: "error",
      code: "patch_add_edge_conflict",
      message: `Edge ${operation.edge.edge_id} already exists`,
      ref
    });
    return;
  }

  draft.edges.set(
    operation.edge.edge_id,
    sanitizeEdgeRecord({
      edge_id: operation.edge.edge_id,
      type: operation.edge.type,
      source_id: operation.edge.source_id,
      target_id: operation.edge.target_id,
      metadata: ensureObject(operation.edge.metadata),
      extensions: ensureObject(operation.edge.extensions),
      created_at: timestamp
    })
  );
}

function applyRemoveEdgeOperation(
  draft: PatchDraftState,
  operation: Extract<GraphPatchOperation, { op: "remove_edge" }>,
  ref: string,
  errors: ValidationIssue[]
): void {
  if (!draft.edges.has(operation.edge_id)) {
    errors.push({
      severity: "error",
      code: "patch_remove_edge_missing",
      message: `Edge ${operation.edge_id} does not exist`,
      ref
    });
    return;
  }

  draft.edges.delete(operation.edge_id);
}

function applyChangeStateOperation(
  draft: PatchDraftState,
  operation: Extract<GraphPatchOperation, { op: "change_state" }>,
  timestamp: string,
  ref: string,
  errors: ValidationIssue[]
): void {
  const existing = draft.nodes.get(operation.node_id);
  if (!existing) {
    errors.push({
      severity: "error",
      code: "patch_change_state_missing",
      message: `Node ${operation.node_id} does not exist`,
      ref
    });
    return;
  }

  draft.nodes.set(
    operation.node_id,
    sanitizeNodeRecord({
      ...existing,
      state: operation.state,
      metadata: {
        ...existing.metadata,
        ...ensureObject(operation.metadata)
      },
      updated_at: timestamp
    })
  );
}

function applyAttachEvidenceOperation(
  draft: PatchDraftState,
  operation: Extract<GraphPatchOperation, { op: "attach_evidence" }>,
  timestamp: string,
  ref: string,
  errors: ValidationIssue[]
): void {
  const evidence = operation.evidence;
  if (draft.nodes.has(evidence.node_id)) {
    errors.push({
      severity: "error",
      code: "patch_attach_evidence_conflict",
      message: `Evidence node ${evidence.node_id} already exists`,
      ref
    });
    return;
  }

  draft.nodes.set(
    evidence.node_id,
    sanitizeNodeRecord({
      node_id: evidence.node_id,
      kind: "evidence",
      title: evidence.title,
      description: evidence.description ?? "",
      state: "done",
      labels: ensureArray(evidence.labels),
      acceptance: ensureArray(evidence.acceptance),
      metadata: ensureObject(evidence.metadata),
      extensions: ensureObject(evidence.extensions),
      created_at: timestamp,
      updated_at: timestamp
    })
  );

  if (!applyVerifiesEdgeForEvidence(draft, operation, evidence.node_id, timestamp, ref, errors)) {
    return;
  }

  applyAttachmentForEvidence(draft, operation, evidence.node_id, timestamp, ref, errors);
}

function applyVerifiesEdgeForEvidence(
  draft: PatchDraftState,
  operation: Extract<GraphPatchOperation, { op: "attach_evidence" }>,
  evidenceNodeId: string,
  timestamp: string,
  ref: string,
  errors: ValidationIssue[]
): boolean {
  if (!operation.verifies_target_id) {
    return true;
  }

  if (!draft.nodes.has(operation.verifies_target_id)) {
    errors.push({
      severity: "error",
      code: "patch_attach_evidence_target_missing",
      message: `Evidence target ${operation.verifies_target_id} does not exist`,
      ref
    });
    return false;
  }

  const edgeId = `edge_verify_${evidenceNodeId}_${operation.verifies_target_id}`;
  if (draft.edges.has(edgeId)) {
    errors.push({
      severity: "error",
      code: "patch_attach_evidence_edge_conflict",
      message: `Edge ${edgeId} already exists`,
      ref
    });
    return false;
  }

  draft.edges.set(
    edgeId,
    sanitizeEdgeRecord({
      edge_id: edgeId,
      type: "verifies",
      source_id: evidenceNodeId,
      target_id: operation.verifies_target_id,
      metadata: {},
      extensions: {},
      created_at: timestamp
    })
  );
  return true;
}

function applyAttachmentForEvidence(
  draft: PatchDraftState,
  operation: Extract<GraphPatchOperation, { op: "attach_evidence" }>,
  evidenceNodeId: string,
  timestamp: string,
  ref: string,
  errors: ValidationIssue[]
): void {
  if (!operation.attachment) {
    return;
  }

  const attachmentId = operation.attachment.attachment_id ?? generateId();
  if (draft.attachments.has(attachmentId)) {
    errors.push({
      severity: "error",
      code: "patch_attachment_conflict",
      message: `Attachment ${attachmentId} already exists`,
      ref
    });
    return;
  }

  draft.attachments.set(
    attachmentId,
    sanitizeAttachmentRecord({
      attachment_id: attachmentId,
      evidence_node_id: evidenceNodeId,
      storage_mode: operation.attachment.storage_mode,
      path_or_url: operation.attachment.path_or_url,
      sha256: operation.attachment.sha256 ?? null,
      mime_type: operation.attachment.mime_type ?? null,
      size_bytes: operation.attachment.size_bytes ?? null,
      created_at: timestamp
    })
  );
}

function applySetCaseFieldOperation(
  draft: PatchDraftState,
  operation: Extract<GraphPatchOperation, { op: "set_case_field" }>
): void {
  const changes = cloneCaseChanges(operation.changes);
  draft.caseRecord = sanitizeCaseRecord({
    ...draft.caseRecord,
    title: changes.title ?? draft.caseRecord.title,
    description: changes.description ?? draft.caseRecord.description,
    state: changes.state ?? draft.caseRecord.state,
    labels: changes.labels ?? draft.caseRecord.labels,
    metadata: changes.metadata ?? draft.caseRecord.metadata,
    extensions: changes.extensions ?? draft.caseRecord.extensions,
    case_revision: draft.caseRecord.case_revision
  });
}

export function finalizePatchDraftState(
  draft: PatchDraftState,
  patchEventId: string,
  eventTimestamp: string,
  nextRevision: number
): CaseStateView {
  draft.caseRecord.updated_at = eventTimestamp;
  draft.caseRecord.case_revision = {
    current: nextRevision,
    last_event_id: patchEventId
  };
  const validation = validateGraph(draft.nodes, draft.edges, draft.attachments);
  const derived = deriveNodeStates(draft.nodes, draft.edges, validation);

  return {
    caseRecord: draft.caseRecord,
    nodes: draft.nodes,
    edges: draft.edges,
    attachments: draft.attachments,
    events: [],
    derived,
    validation
  };
}

function countPatchOperations(
  operations: GraphPatchOperation[]
): Partial<Record<GraphPatchOperation["op"], number>> {
  const counts: Partial<Record<GraphPatchOperation["op"], number>> = {};
  for (const operation of operations) {
    counts[operation.op] = (counts[operation.op] ?? 0) + 1;
  }
  return counts;
}

function classifyPatchRisks(patch: GraphPatch) {
  const risks: PatchReview["risky_ops"] = [];

  for (let index = 0; index < patch.operations.length; index += 1) {
    const operation = patch.operations[index] as GraphPatchOperation;
    switch (operation.op) {
      case "remove_node":
        risks.push({
          op_index: index,
          op: operation.op,
          reason: "removes an existing node"
        });
        break;
      case "set_case_field":
        risks.push({
          op_index: index,
          op: operation.op,
          reason: "changes case-level metadata"
        });
        break;
      case "change_state":
        if (operation.state === "cancelled" || operation.state === "failed") {
          risks.push({
            op_index: index,
            op: operation.op,
            reason: `changes node state to ${operation.state}`
          });
        }
        break;
      case "attach_evidence":
        if (
          operation.attachment?.storage_mode === "absolute_path" ||
          operation.attachment?.storage_mode === "workspace_copy"
        ) {
          risks.push({
            op_index: index,
            op: operation.op,
            reason: `references attachment via ${operation.attachment.storage_mode}`
          });
        }
        break;
      default:
        break;
    }
  }

  return risks;
}

function parseOperations(input: unknown, errors: ValidationIssue[]): GraphPatchOperation[] {
  if (!Array.isArray(input)) {
    errors.push({
      severity: "error",
      code: "patch_operations_not_array",
      message: "patch.operations must be an array",
      ref: "patch.operations"
    });
    return [];
  }

  const operations: GraphPatchOperation[] = [];

  for (let index = 0; index < input.length; index += 1) {
    const value = input[index];
    const ref = `patch.operations[${index}]`;
    if (!isRecord(value) || typeof value.op !== "string") {
      errors.push({
        severity: "error",
        code: "patch_operation_invalid",
        message: `Operation at ${ref} must be an object with op`,
        ref
      });
      continue;
    }

    switch (value.op) {
      case "add_node":
        operations.push(...parseAddNodeOperation(value, ref, errors));
        break;
      case "update_node":
        operations.push(...parseUpdateNodeOperation(value, ref, errors));
        break;
      case "remove_node":
        operations.push(...parseRemoveNodeOperation(value, ref, errors));
        break;
      case "add_edge":
        operations.push(...parseAddEdgeOperation(value, ref, errors));
        break;
      case "remove_edge":
        operations.push(...parseRemoveEdgeOperation(value, ref, errors));
        break;
      case "change_state":
        operations.push(...parseChangeStateOperation(value, ref, errors));
        break;
      case "attach_evidence":
        operations.push(...parseAttachEvidenceOperation(value, ref, errors));
        break;
      case "set_case_field":
        operations.push(...parseSetCaseFieldOperation(value, ref, errors));
        break;
      default:
        errors.push({
          severity: "error",
          code: "patch_operation_unknown",
          message: `Unsupported patch operation ${value.op}`,
          ref
        });
        break;
    }
  }

  return operations;
}

function parseAddNodeOperation(
  input: Record<string, unknown>,
  ref: string,
  errors: ValidationIssue[]
) {
  if (!isRecord(input.node)) {
    errors.push({
      severity: "error",
      code: "patch_add_node_missing",
      message: "add_node requires node",
      ref
    });
    return [];
  }

  const node = input.node;
  const nodeId = requireString(node.node_id, `${ref}.node.node_id`, errors);
  const kind = requireString(node.kind, `${ref}.node.kind`, errors);
  const title = requireString(node.title, `${ref}.node.title`, errors);
  const state = requireString(node.state, `${ref}.node.state`, errors);

  if (!(nodeId && kind && title && state)) {
    return [];
  }

  if (!(NODE_KINDS.has(kind) && NODE_STATES.has(state))) {
    errors.push({
      severity: "error",
      code: "patch_node_value_invalid",
      message: `${ref}.node.kind or ${ref}.node.state has an unsupported value`,
      ref
    });
    return [];
  }

  return [
    {
      op: "add_node" as const,
      node: {
        node_id: nodeId,
        kind: kind as NodeRecord["kind"],
        title,
        state: state as NodeRecord["state"],
        description: optionalString(node.description, `${ref}.node.description`, errors),
        labels: parseStringArray(node.labels, `${ref}.node.labels`, errors),
        acceptance: parseStringArray(node.acceptance, `${ref}.node.acceptance`, errors),
        metadata: parseRecord(node.metadata, `${ref}.node.metadata`, errors),
        extensions: parseRecord(node.extensions, `${ref}.node.extensions`, errors)
      }
    }
  ];
}

function parseUpdateNodeOperation(
  input: Record<string, unknown>,
  ref: string,
  errors: ValidationIssue[]
) {
  const nodeId = requireString(input.node_id, `${ref}.node_id`, errors);
  if (!isRecord(input.changes)) {
    errors.push({
      severity: "error",
      code: "patch_update_node_changes_missing",
      message: "update_node requires changes",
      ref
    });
    return [];
  }

  if (!nodeId) {
    return [];
  }

  const changes = parseNodeChanges(input.changes, `${ref}.changes`, errors);
  if (Object.keys(changes).length === 0) {
    errors.push({
      severity: "error",
      code: "patch_update_node_changes_empty",
      message: "update_node changes must not be empty",
      ref
    });
    return [];
  }

  return [
    {
      op: "update_node" as const,
      node_id: nodeId,
      changes
    }
  ];
}

function parseRemoveNodeOperation(
  input: Record<string, unknown>,
  ref: string,
  errors: ValidationIssue[]
) {
  const nodeId = requireString(input.node_id, `${ref}.node_id`, errors);
  return nodeId ? [{ op: "remove_node" as const, node_id: nodeId }] : [];
}

function parseAddEdgeOperation(
  input: Record<string, unknown>,
  ref: string,
  errors: ValidationIssue[]
) {
  if (!isRecord(input.edge)) {
    errors.push({
      severity: "error",
      code: "patch_add_edge_missing",
      message: "add_edge requires edge",
      ref
    });
    return [];
  }

  const edge = input.edge;
  const edgeId = requireString(edge.edge_id, `${ref}.edge.edge_id`, errors);
  const type = requireString(edge.type, `${ref}.edge.type`, errors);
  const sourceId = requireString(edge.source_id, `${ref}.edge.source_id`, errors);
  const targetId = requireString(edge.target_id, `${ref}.edge.target_id`, errors);

  if (!(edgeId && type && sourceId && targetId)) {
    return [];
  }

  if (!EDGE_TYPES.has(type)) {
    errors.push({
      severity: "error",
      code: "patch_edge_type_invalid",
      message: `${ref}.edge.type has an unsupported value`,
      ref: `${ref}.edge.type`
    });
    return [];
  }

  return [
    {
      op: "add_edge" as const,
      edge: {
        edge_id: edgeId,
        type: type as EdgeRecord["type"],
        source_id: sourceId,
        target_id: targetId,
        metadata: parseRecord(edge.metadata, `${ref}.edge.metadata`, errors),
        extensions: parseRecord(edge.extensions, `${ref}.edge.extensions`, errors)
      }
    }
  ];
}

function parseRemoveEdgeOperation(
  input: Record<string, unknown>,
  ref: string,
  errors: ValidationIssue[]
) {
  const edgeId = requireString(input.edge_id, `${ref}.edge_id`, errors);
  return edgeId ? [{ op: "remove_edge" as const, edge_id: edgeId }] : [];
}

function parseChangeStateOperation(
  input: Record<string, unknown>,
  ref: string,
  errors: ValidationIssue[]
) {
  const nodeId = requireString(input.node_id, `${ref}.node_id`, errors);
  const state = requireString(input.state, `${ref}.state`, errors);
  if (!(nodeId && state)) {
    return [];
  }

  if (!NODE_STATES.has(state)) {
    errors.push({
      severity: "error",
      code: "patch_node_state_invalid",
      message: `${ref}.state has an unsupported value`,
      ref: `${ref}.state`
    });
    return [];
  }

  return [
    {
      op: "change_state" as const,
      node_id: nodeId,
      state: state as NodeRecord["state"],
      metadata: parseRecord(input.metadata, `${ref}.metadata`, errors)
    }
  ];
}

function parseAttachEvidenceOperation(
  input: Record<string, unknown>,
  ref: string,
  errors: ValidationIssue[]
) {
  if (!isRecord(input.evidence)) {
    errors.push({
      severity: "error",
      code: "patch_attach_evidence_missing",
      message: "attach_evidence requires evidence",
      ref
    });
    return [];
  }

  const evidence = input.evidence;
  const nodeId = requireString(evidence.node_id, `${ref}.evidence.node_id`, errors);
  const title = requireString(evidence.title, `${ref}.evidence.title`, errors);

  if (!(nodeId && title)) {
    return [];
  }

  if (evidence.kind !== undefined && evidence.kind !== "evidence") {
    errors.push({
      severity: "error",
      code: "patch_evidence_kind_invalid",
      message: `${ref}.evidence.kind must be evidence when present`,
      ref: `${ref}.evidence.kind`
    });
    return [];
  }

  return [
    {
      op: "attach_evidence" as const,
      evidence: {
        node_id: nodeId,
        title,
        description: optionalString(evidence.description, `${ref}.evidence.description`, errors),
        labels: parseStringArray(evidence.labels, `${ref}.evidence.labels`, errors),
        acceptance: parseStringArray(evidence.acceptance, `${ref}.evidence.acceptance`, errors),
        metadata: parseRecord(evidence.metadata, `${ref}.evidence.metadata`, errors),
        extensions: parseRecord(evidence.extensions, `${ref}.evidence.extensions`, errors)
      },
      verifies_target_id: optionalString(
        input.verifies_target_id,
        `${ref}.verifies_target_id`,
        errors
      ),
      attachment: parseAttachment(input.attachment, `${ref}.attachment`, errors)
    }
  ];
}

function parseSetCaseFieldOperation(
  input: Record<string, unknown>,
  ref: string,
  errors: ValidationIssue[]
) {
  if (!isRecord(input.changes)) {
    errors.push({
      severity: "error",
      code: "patch_set_case_field_missing",
      message: "set_case_field requires changes",
      ref
    });
    return [];
  }

  const changes = cloneCaseChanges(input.changes);
  if (Object.keys(changes).length === 0) {
    errors.push({
      severity: "error",
      code: "patch_set_case_field_empty",
      message: "set_case_field changes must not be empty",
      ref
    });
    return [];
  }

  if (changes.state !== undefined && !CASE_STATES.has(changes.state)) {
    errors.push({
      severity: "error",
      code: "patch_case_state_invalid",
      message: `${ref}.changes.state has an unsupported value`,
      ref: `${ref}.changes.state`
    });
    return [];
  }

  return [
    {
      op: "set_case_field" as const,
      changes
    }
  ];
}

function parseGenerator(input: unknown, errors: ValidationIssue[]): GraphPatch["generator"] | null {
  if (input === undefined) {
    return null;
  }

  if (!isRecord(input)) {
    errors.push({
      severity: "error",
      code: "patch_generator_invalid",
      message: "patch.generator must be an object",
      ref: "patch.generator"
    });
    return null;
  }

  const kind = requireString(input.kind, "patch.generator.kind", errors);
  const name = requireString(input.name, "patch.generator.name", errors);
  const version = optionalString(input.version, "patch.generator.version", errors);

  return kind && name ? { kind, name, version: version ?? undefined } : null;
}

function parseAttachment(
  input: unknown,
  ref: string,
  errors: ValidationIssue[]
): PatchAttachmentInput | undefined {
  if (input === undefined) {
    return undefined;
  }

  if (!isRecord(input)) {
    errors.push({
      severity: "error",
      code: "patch_attachment_invalid",
      message: "attachment must be an object",
      ref
    });
    return undefined;
  }

  const storageMode = requireString(input.storage_mode, `${ref}.storage_mode`, errors);
  const pathOrUrl = requireString(input.path_or_url, `${ref}.path_or_url`, errors);
  const attachmentId = optionalString(input.attachment_id, `${ref}.attachment_id`, errors);

  if (!(storageMode && pathOrUrl)) {
    return undefined;
  }

  if (!STORAGE_MODES.has(storageMode)) {
    errors.push({
      severity: "error",
      code: "patch_attachment_storage_mode_invalid",
      message: `${ref}.storage_mode has an unsupported value`,
      ref: `${ref}.storage_mode`
    });
    return undefined;
  }

  return {
    attachment_id: attachmentId ?? undefined,
    storage_mode: storageMode as AttachmentRecord["storage_mode"],
    path_or_url: pathOrUrl,
    sha256: optionalNullableString(input.sha256, `${ref}.sha256`, errors),
    mime_type: optionalNullableString(input.mime_type, `${ref}.mime_type`, errors),
    size_bytes: optionalNullableNumber(input.size_bytes, `${ref}.size_bytes`, errors)
  };
}

function cloneDraftState(state: CaseStateView): PatchDraftState {
  return {
    caseRecord: cloneRecord(state.caseRecord),
    nodes: new Map(
      Array.from(state.nodes.entries(), ([nodeId, node]) => [nodeId, cloneRecord(node)])
    ),
    edges: new Map(
      Array.from(state.edges.entries(), ([edgeId, edge]) => [edgeId, cloneRecord(edge)])
    ),
    attachments: new Map(
      Array.from(state.attachments.entries(), ([attachmentId, attachment]) => [
        attachmentId,
        cloneRecord(attachment)
      ])
    )
  };
}

function cloneNodeChanges(changes: PatchNodeChanges): PatchNodeChanges {
  const out: PatchNodeChanges = {};
  if (changes.title !== undefined) out.title = changes.title;
  if (changes.description !== undefined) out.description = changes.description;
  if (changes.labels !== undefined) out.labels = [...changes.labels];
  if (changes.acceptance !== undefined) out.acceptance = [...changes.acceptance];
  if (changes.metadata !== undefined) out.metadata = { ...changes.metadata };
  if (changes.extensions !== undefined) out.extensions = { ...changes.extensions };
  return out;
}

function cloneCaseChanges(
  changes: Partial<
    Pick<CaseRecord, "title" | "description" | "state" | "labels" | "metadata" | "extensions">
  >
) {
  return {
    ...changes,
    labels: changes.labels ? [...changes.labels] : undefined,
    metadata: changes.metadata ? { ...changes.metadata } : undefined,
    extensions: changes.extensions ? { ...changes.extensions } : undefined
  };
}

function parseNodeChanges(
  input: Record<string, unknown>,
  ref: string,
  errors: ValidationIssue[]
): PatchNodeChanges {
  return {
    title: optionalString(input.title, `${ref}.title`, errors),
    description: optionalString(input.description, `${ref}.description`, errors),
    labels: parseStringArray(input.labels, `${ref}.labels`, errors),
    acceptance: parseStringArray(input.acceptance, `${ref}.acceptance`, errors),
    metadata: parseRecord(input.metadata, `${ref}.metadata`, errors),
    extensions: parseRecord(input.extensions, `${ref}.extensions`, errors)
  };
}

function parseStringArray(
  input: unknown,
  ref: string,
  errors: ValidationIssue[]
): string[] | undefined {
  if (input === undefined) {
    return undefined;
  }

  if (!Array.isArray(input) || input.some((value) => typeof value !== "string")) {
    errors.push({
      severity: "error",
      code: "patch_string_array_invalid",
      message: `${ref} must be an array of strings`,
      ref
    });
    return undefined;
  }

  return [...input];
}

function parseRecord(
  input: unknown,
  ref: string,
  errors: ValidationIssue[]
): Record<string, unknown> | undefined {
  if (input === undefined) {
    return undefined;
  }

  if (!isRecord(input)) {
    errors.push({
      severity: "error",
      code: "patch_object_invalid",
      message: `${ref} must be an object`,
      ref
    });
    return undefined;
  }

  return { ...input };
}

function requireString(input: unknown, ref: string, errors: ValidationIssue[]): string | null {
  if (typeof input !== "string" || input.trim().length === 0) {
    errors.push({
      severity: "error",
      code: "patch_required_string",
      message: `${ref} must be a non-empty string`,
      ref
    });
    return null;
  }
  return input;
}

function requireNumber(input: unknown, ref: string, errors: ValidationIssue[]): number | null {
  if (typeof input !== "number" || !Number.isInteger(input) || input < 0) {
    errors.push({
      severity: "error",
      code: "patch_required_number",
      message: `${ref} must be a non-negative integer`,
      ref
    });
    return null;
  }
  return input;
}

function optionalString(
  input: unknown,
  ref: string,
  errors: ValidationIssue[]
): string | undefined {
  if (input === undefined) {
    return undefined;
  }

  if (typeof input !== "string") {
    errors.push({
      severity: "error",
      code: "patch_optional_string_invalid",
      message: `${ref} must be a string`,
      ref
    });
    return undefined;
  }

  return input;
}

function optionalNullableString(
  input: unknown,
  ref: string,
  errors: ValidationIssue[]
): string | null | undefined {
  if (input === undefined || input === null) {
    return input as null | undefined;
  }

  if (typeof input !== "string") {
    errors.push({
      severity: "error",
      code: "patch_optional_string_invalid",
      message: `${ref} must be a string or null`,
      ref
    });
    return undefined;
  }

  return input;
}

function optionalNullableNumber(
  input: unknown,
  ref: string,
  errors: ValidationIssue[]
): number | null | undefined {
  if (input === undefined || input === null) {
    return input as null | undefined;
  }

  if (typeof input !== "number" || Number.isNaN(input)) {
    errors.push({
      severity: "error",
      code: "patch_optional_number_invalid",
      message: `${ref} must be a number or null`,
      ref
    });
    return undefined;
  }

  return input;
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}
