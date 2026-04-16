import { access, appendFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  CASE_FILENAME,
  DEFAULT_WORKSPACE_TITLE,
  SPEC_VERSION
} from "./constants.js";
import { CaseGraphError } from "./errors.js";
import {
  cloneRecord,
  copyAttachmentIntoWorkspace,
  createEvent,
  defaultActor,
  ensureArray,
  ensureObject,
  generateId,
  nowUtc,
  sanitizeAttachmentRecord,
  sanitizeCaseRecord,
  sanitizeEdgeRecord,
  sanitizeNodeRecord
} from "./helpers.js";
import { withWorkspaceLock } from "./lock.js";
import { getCasePaths, getWorkspacePaths, resolveWorkspaceRoot } from "./paths.js";
import {
  computeCaseCounts,
  getBlockedItems as getReducerBlockedItems,
  getFrontier,
  replayCaseEvents
} from "./reducer.js";
import { openCacheDatabase, rebuildCaseCache } from "./sqlite.js";
import type {
  ActorRef,
  AddEdgeInput,
  AddEvidenceInput,
  AddNodeInput,
  BlockedItem,
  CaseRecord,
  CaseStateView,
  ChangeNodeStateInput,
  CommandResult,
  ConfigRecord,
  EventEnvelope,
  FrontierItem,
  MutationContext,
  NodeRecord,
  RevisionSnapshot,
  UpdateNodeInput,
  ValidationIssue,
  WorkspaceContextOptions,
  WorkspaceRecord
} from "./types.js";
import { ensureDirectory, readYamlFile, writeYamlFile } from "./yaml.js";

export interface ResolvedWorkspaceContext {
  workspaceRoot: string;
  workspacePaths: ReturnType<typeof getWorkspacePaths>;
}

export interface ShowCaseData {
  case: CaseRecord;
  counts: ReturnType<typeof computeCaseCounts>;
  frontier_summary: {
    ready_count: number;
    node_ids: string[];
  };
  revision: RevisionSnapshot;
}

export interface ValidateCaseData {
  case_id: string;
  valid: boolean;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
}

export interface ValidateStorageData {
  workspace: string;
  valid: boolean;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
  cases_checked: number;
}

export async function resolveWorkspaceContext(
  options: WorkspaceContextOptions = {}
): Promise<ResolvedWorkspaceContext> {
  const cwd = options.cwd ?? process.cwd();
  const workspaceRoot = await resolveWorkspaceRoot(
    cwd,
    options.workspaceOverride,
    options.env
  );
  return {
    workspaceRoot,
    workspacePaths: getWorkspacePaths(workspaceRoot)
  };
}

export async function initWorkspace(input: {
  workspaceRoot: string;
  title?: string;
}): Promise<WorkspaceRecord> {
  const workspacePaths = getWorkspacePaths(input.workspaceRoot);
  if (await fileExists(workspacePaths.workspaceFile)) {
    throw new CaseGraphError("workspace_exists", "Workspace already initialized", {
      exitCode: 4
    });
  }
  await ensureDirectory(workspacePaths.workspaceDir);
  await ensureDirectory(workspacePaths.casesDir);
  await ensureDirectory(workspacePaths.cacheDir);

  const timestamp = nowUtc();
  const workspaceRecord: WorkspaceRecord = {
    workspace_id: generateId(),
    title: input.title ?? DEFAULT_WORKSPACE_TITLE,
    spec_version: SPEC_VERSION,
    created_at: timestamp,
    updated_at: timestamp
  };
  const configRecord: ConfigRecord = {
    default_format: "text"
  };

  await writeYamlFile(workspacePaths.workspaceFile, workspaceRecord);
  await writeYamlFile(workspacePaths.configFile, configRecord);

  const database = openCacheDatabase(workspacePaths.cacheFile);
  database.close();

  return workspaceRecord;
}

export async function loadWorkspaceRecord(workspaceRoot: string): Promise<WorkspaceRecord> {
  const workspacePaths = getWorkspacePaths(workspaceRoot);
  return readYamlFile<WorkspaceRecord>(workspacePaths.workspaceFile);
}

export async function loadConfigRecord(workspaceRoot: string): Promise<ConfigRecord> {
  const workspacePaths = getWorkspacePaths(workspaceRoot);

  try {
    await access(workspacePaths.configFile);
  } catch {
    return { default_format: "text" };
  }

  return readYamlFile<ConfigRecord>(workspacePaths.configFile);
}

export async function createCase(
  workspaceRoot: string,
  input: Pick<CaseRecord, "case_id" | "title" | "description"> & {
    state?: CaseRecord["state"];
    labels?: string[];
    metadata?: Record<string, unknown>;
    extensions?: Record<string, unknown>;
  },
  context: MutationContext = {}
): Promise<CaseStateView> {
  const workspacePaths = getWorkspacePaths(workspaceRoot);
  const casePaths = getCasePaths(workspaceRoot, input.case_id);

  return withWorkspaceLock(workspacePaths.lockFile, async () => {
    try {
      await access(casePaths.caseFile);
      throw new CaseGraphError("case_exists", `Case ${input.case_id} already exists`, {
        exitCode: 4
      });
    } catch (error) {
      if (error instanceof CaseGraphError) {
        throw error;
      }
    }

    await ensureDirectory(casePaths.caseDir);
    await ensureDirectory(casePaths.attachmentsDir);
    await ensureDirectory(casePaths.projectionsDir);

    const timestamp = context.now ?? nowUtc();
    const caseRecord = sanitizeCaseRecord({
      case_id: input.case_id,
      title: input.title,
      description: input.description,
      state: input.state ?? "open",
      labels: ensureArray(input.labels),
      metadata: ensureObject(input.metadata),
      extensions: ensureObject(input.extensions),
      created_at: timestamp,
      updated_at: timestamp,
      case_revision: { current: 0, last_event_id: null }
    });

    const event = createEvent({
      case_id: caseRecord.case_id,
      timestamp,
      type: "case.created",
      source: "cli",
      command_id: context.commandId,
      actor: context.actor,
      revision_hint: 1,
      payload: {
        case: cloneRecord(caseRecord)
      }
    });

    await appendEvents(casePaths.eventsFile, [event]);
    const state = replayCaseEvents([event]);
    await writeYamlFile(casePaths.caseFile, state.caseRecord);
    await rebuildCaseCacheForState(workspaceRoot, state);
    return state;
  });
}

export async function listCases(workspaceRoot: string): Promise<CaseRecord[]> {
  const workspacePaths = getWorkspacePaths(workspaceRoot);
  const entries = await readdir(workspacePaths.casesDir, { withFileTypes: true }).catch(
    () => []
  );
  const cases: CaseRecord[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const casePaths = getCasePaths(workspaceRoot, entry.name);
    try {
      const caseRecord = await readYamlFile<CaseRecord>(casePaths.caseFile);
      cases.push(caseRecord);
    } catch {
      continue;
    }
  }

  cases.sort((left, right) => left.case_id.localeCompare(right.case_id));
  return cases;
}

export async function loadCaseState(
  workspaceRoot: string,
  caseId: string
): Promise<CaseStateView> {
  const casePaths = getCasePaths(workspaceRoot, caseId);
  const events = await loadCaseEvents(casePaths.eventsFile);
  return replayCaseEvents(events);
}

export async function showCase(
  workspaceRoot: string,
  caseId: string
): Promise<ShowCaseData> {
  const state = await loadCaseState(workspaceRoot, caseId);
  const frontier = getFrontier(state);

  return {
    case: state.caseRecord,
    counts: computeCaseCounts(state),
    frontier_summary: {
      ready_count: frontier.length,
      node_ids: frontier.map((item) => item.node_id)
    },
    revision: state.caseRecord.case_revision
  };
}

export async function addNode(
  workspaceRoot: string,
  input: AddNodeInput,
  context: MutationContext = {}
): Promise<CaseStateView> {
  const timestamp = context.now ?? nowUtc();
  const node = sanitizeNodeRecord({
    ...input.node,
    created_at: input.node.created_at ?? timestamp,
    updated_at: input.node.updated_at ?? timestamp
  });

  return appendCaseEvents(
    workspaceRoot,
    input.caseId,
    [
      createEvent({
        case_id: input.caseId,
        timestamp,
        type: "node.added",
        source: "cli",
        command_id: context.commandId,
        actor: context.actor,
        payload: { node }
      })
    ]
  );
}

export async function updateNode(
  workspaceRoot: string,
  input: UpdateNodeInput,
  context: MutationContext = {}
): Promise<CaseStateView> {
  const timestamp = context.now ?? nowUtc();
  return appendCaseEvents(
    workspaceRoot,
    input.caseId,
    [
      createEvent({
        case_id: input.caseId,
        timestamp,
        type: "node.updated",
        source: "cli",
        command_id: context.commandId,
        actor: context.actor,
        payload: {
          node_id: input.nodeId,
          changes: {
            ...input.changes,
            metadata: input.changes.metadata
              ? ensureObject(input.changes.metadata)
              : undefined,
            extensions: input.changes.extensions
              ? ensureObject(input.changes.extensions)
              : undefined
          }
        }
      })
    ]
  );
}

export async function addEdge(
  workspaceRoot: string,
  input: AddEdgeInput,
  context: MutationContext = {}
): Promise<CaseStateView> {
  const timestamp = context.now ?? nowUtc();
  const edge = sanitizeEdgeRecord({
    ...input.edge,
    created_at: input.edge.created_at ?? timestamp
  });

  return appendCaseEvents(
    workspaceRoot,
    input.caseId,
    [
      createEvent({
        case_id: input.caseId,
        timestamp,
        type: "edge.added",
        source: "cli",
        command_id: context.commandId,
        actor: context.actor,
        payload: { edge }
      })
    ]
  );
}

export async function removeEdge(
  workspaceRoot: string,
  caseId: string,
  edgeId: string,
  context: MutationContext = {}
): Promise<CaseStateView> {
  const timestamp = context.now ?? nowUtc();
  return appendCaseEvents(
    workspaceRoot,
    caseId,
    [
      createEvent({
        case_id: caseId,
        timestamp,
        type: "edge.removed",
        source: "cli",
        command_id: context.commandId,
        actor: context.actor,
        payload: { edge_id: edgeId }
      })
    ]
  );
}

export async function changeNodeState(
  workspaceRoot: string,
  input: ChangeNodeStateInput,
  context: MutationContext = {}
): Promise<CaseStateView> {
  const timestamp = context.now ?? nowUtc();
  return appendCaseEvents(
    workspaceRoot,
    input.caseId,
    [
      createEvent({
        case_id: input.caseId,
        timestamp,
        type: "node.state_changed",
        source: "cli",
        command_id: context.commandId,
        actor: context.actor,
        payload: {
          node_id: input.nodeId,
          state: input.state,
          metadata: input.metadata
        }
      })
    ]
  );
}

export async function waitTask(
  workspaceRoot: string,
  input: {
    caseId: string;
    nodeId: string;
    reason?: string;
    eventId?: string;
  },
  context: MutationContext = {}
): Promise<CaseStateView> {
  const workspacePaths = getWorkspacePaths(workspaceRoot);
  return withWorkspaceLock(workspacePaths.lockFile, async () => {
    const existingState = await loadCaseState(workspaceRoot, input.caseId);
    const timestamp = context.now ?? nowUtc();
    const events: EventEnvelope[] = [];

    if (input.eventId) {
      const hasWaitsForEdge = Array.from(existingState.edges.values()).some(
        (edge) =>
          edge.type === "waits_for" &&
          edge.source_id === input.nodeId &&
          edge.target_id === input.eventId
      );

      if (!hasWaitsForEdge) {
        events.push(
          createEvent({
            case_id: input.caseId,
            timestamp,
            type: "edge.added",
            source: "cli",
            command_id: context.commandId,
            actor: context.actor,
            payload: {
              edge: {
                edge_id: generateId(),
                type: "waits_for",
                source_id: input.nodeId,
                target_id: input.eventId,
                metadata: {},
                extensions: {},
                created_at: timestamp
              }
            }
          })
        );
      }
    }

    events.push(
      createEvent({
        case_id: input.caseId,
        timestamp,
        type: "node.state_changed",
        source: "cli",
        command_id: context.commandId,
        actor: context.actor,
        payload: {
          node_id: input.nodeId,
          state: "waiting",
          metadata: input.reason ? { last_wait_reason: input.reason } : undefined
        }
      })
    );

    return appendPreparedCaseEvents(workspaceRoot, input.caseId, events);
  });
}

export async function decideNode(
  workspaceRoot: string,
  input: { caseId: string; nodeId: string; result?: string },
  context: MutationContext = {}
): Promise<CaseStateView> {
  return changeNodeState(
    workspaceRoot,
    {
      caseId: input.caseId,
      nodeId: input.nodeId,
      state: "done",
      metadata: input.result ? { decision_result: input.result } : undefined
    },
    context
  );
}

export async function recordEventNode(
  workspaceRoot: string,
  input: { caseId: string; nodeId: string },
  context: MutationContext = {}
): Promise<CaseStateView> {
  const timestamp = context.now ?? nowUtc();
  return appendCaseEvents(
    workspaceRoot,
    input.caseId,
    [
      createEvent({
        case_id: input.caseId,
        timestamp,
        type: "event.recorded",
        source: "cli",
        command_id: context.commandId,
        actor: context.actor,
        payload: {
          node_id: input.nodeId
        }
      })
    ]
  );
}

export async function addEvidence(
  workspaceRoot: string,
  input: AddEvidenceInput,
  context: MutationContext = {}
): Promise<CaseStateView> {
  const workspacePaths = getWorkspacePaths(workspaceRoot);
  const casePaths = getCasePaths(workspaceRoot, input.caseId);

  return withWorkspaceLock(workspacePaths.lockFile, async () => {
    const timestamp = context.now ?? nowUtc();
    let attachment = input.attachment;

    if (attachment?.storage_mode === "workspace_copy") {
      const copied = await copyAttachmentIntoWorkspace(
        attachment.path_or_url,
        casePaths.attachmentsDir,
        attachment.attachment_id
      );
      attachment = {
        ...attachment,
        ...copied
      };
    }

    const evidenceNode = sanitizeNodeRecord({
      ...input.evidence,
      kind: "evidence",
      state: "done",
      created_at: input.evidence.created_at ?? timestamp,
      updated_at: input.evidence.updated_at ?? timestamp
    });
    const verifiesEdge = input.verifiesTargetId
      ? {
          edge_id: generateId(),
          type: "verifies" as const,
          source_id: evidenceNode.node_id,
          target_id: input.verifiesTargetId,
          metadata: {},
          extensions: {},
          created_at: timestamp
        }
      : undefined;

    const preparedAttachment = attachment
      ? sanitizeAttachmentRecord({
          ...attachment,
          created_at: attachment.created_at ?? timestamp
        })
      : undefined;

    const event = createEvent({
      case_id: input.caseId,
      timestamp,
      type: "evidence.attached",
      source: "cli",
      command_id: context.commandId,
      actor: context.actor,
      payload: {
        node: evidenceNode,
        verifies_edge: verifiesEdge,
        attachment: preparedAttachment
      }
    });

    return appendPreparedCaseEvents(workspaceRoot, input.caseId, [event]);
  });
}

export async function validateCase(
  workspaceRoot: string,
  caseId: string
): Promise<ValidateCaseData> {
  const state = await loadCaseState(workspaceRoot, caseId);
  const errors = state.validation.filter((issue) => issue.severity === "error");
  const warnings = state.validation.filter((issue) => issue.severity === "warning");

  return {
    case_id: caseId,
    valid: errors.length === 0,
    errors,
    warnings
  };
}

export async function validateStorage(
  workspaceRoot: string
): Promise<ValidateStorageData> {
  const workspacePaths = getWorkspacePaths(workspaceRoot);
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];

  for (const requiredPath of [
    workspacePaths.workspaceFile,
    workspacePaths.configFile,
    workspacePaths.casesDir
  ]) {
    try {
      await access(requiredPath);
    } catch {
      errors.push({
        severity: "error",
        code: "missing_path",
        message: `Missing required workspace path ${requiredPath}`,
        ref: requiredPath
      });
    }
  }

  const cases = await listCases(workspaceRoot);
  for (const caseRecord of cases) {
    const casePaths = getCasePaths(workspaceRoot, caseRecord.case_id);
    try {
      await access(casePaths.eventsFile);
    } catch {
      errors.push({
        severity: "error",
        code: "missing_events_file",
        message: `Case ${caseRecord.case_id} is missing events.jsonl`,
        ref: caseRecord.case_id
      });
      continue;
    }

    const state = await loadCaseState(workspaceRoot, caseRecord.case_id);
    const replayErrors = state.validation.filter((issue) => issue.severity === "error");
    const replayWarnings = state.validation.filter(
      (issue) => issue.severity === "warning"
    );
    errors.push(...replayErrors);
    warnings.push(...replayWarnings);

    if (
      caseRecord.case_revision.current !== state.caseRecord.case_revision.current ||
      caseRecord.case_revision.last_event_id !== state.caseRecord.case_revision.last_event_id
    ) {
      errors.push({
        severity: "error",
        code: "case_revision_mismatch",
        message: `Case snapshot revision mismatch for ${caseRecord.case_id}`,
        ref: caseRecord.case_id
      });
    }
  }

  const cacheExists = await fileExists(workspacePaths.cacheFile);
  if (!cacheExists) {
    errors.push({
      severity: "error",
      code: "missing_cache",
      message: "Cache database is missing",
      ref: workspacePaths.cacheFile
    });
  }

  return {
    workspace: workspaceRoot,
    valid: errors.length === 0,
    errors,
    warnings,
    cases_checked: cases.length
  };
}

export async function rebuildCache(workspaceRoot: string): Promise<{ cases: number }> {
  const workspacePaths = getWorkspacePaths(workspaceRoot);
  await ensureDirectory(workspacePaths.cacheDir);
  const cases = await listCases(workspaceRoot);
  const database = openCacheDatabase(workspacePaths.cacheFile);
  database.exec(
    [
      "DELETE FROM cases;",
      "DELETE FROM nodes;",
      "DELETE FROM edges;",
      "DELETE FROM events;",
      "DELETE FROM node_derived;",
      "DELETE FROM attachments;",
      "DELETE FROM projection_mappings;"
    ].join("\n")
  );

  try {
    for (const caseRecord of cases) {
      const state = await loadCaseState(workspaceRoot, caseRecord.case_id);
      rebuildCaseCache(database, state);
    }
  } finally {
    database.close();
  }

  return { cases: cases.length };
}

export async function verifyEvents(
  workspaceRoot: string,
  caseId: string
): Promise<{ case_id: string; event_count: number; revision: RevisionSnapshot }> {
  const state = await loadCaseState(workspaceRoot, caseId);
  return {
    case_id: caseId,
    event_count: state.events.length,
    revision: state.caseRecord.case_revision
  };
}

export async function exportEvents(
  workspaceRoot: string,
  caseId: string
): Promise<EventEnvelope[]> {
  const casePaths = getCasePaths(workspaceRoot, caseId);
  return loadCaseEvents(casePaths.eventsFile);
}

export async function getFrontierItems(
  workspaceRoot: string,
  caseId: string
): Promise<{ case_id: string; revision: RevisionSnapshot; nodes: FrontierItem[] }> {
  const state = await loadCaseState(workspaceRoot, caseId);
  return {
    case_id: caseId,
    revision: state.caseRecord.case_revision,
    nodes: getFrontier(state)
  };
}

export async function listBlockedItems(
  workspaceRoot: string,
  caseId: string
): Promise<{ case_id: string; revision: RevisionSnapshot; items: BlockedItem[] }> {
  const state = await loadCaseState(workspaceRoot, caseId);
  return {
    case_id: caseId,
    revision: state.caseRecord.case_revision,
    items: getReducerBlockedItems(state)
  };
}

export function successResult<T>(
  command: string,
  data: T,
  revision?: RevisionSnapshot
): CommandResult<T> {
  const result: CommandResult<T> = {
    ok: true,
    command,
    data
  };
  if (revision) {
    result.revision = revision;
  }
  return result;
}

async function appendCaseEvents(
  workspaceRoot: string,
  caseId: string,
  events: EventEnvelope[]
): Promise<CaseStateView> {
  const workspacePaths = getWorkspacePaths(workspaceRoot);
  return withWorkspaceLock(workspacePaths.lockFile, async () =>
    appendPreparedCaseEvents(workspaceRoot, caseId, events)
  );
}

async function appendPreparedCaseEvents(
  workspaceRoot: string,
  caseId: string,
  events: EventEnvelope[]
): Promise<CaseStateView> {
  const casePaths = getCasePaths(workspaceRoot, caseId);
  const currentEvents = await loadCaseEvents(casePaths.eventsFile);
  const preparedEvents = events.map((event, index) => ({
    ...event,
    case_id: caseId,
    revision_hint: currentEvents.length + index + 1
  }));

  const nextState = replayCaseEvents([...currentEvents, ...preparedEvents]);
  const errors = nextState.validation.filter((issue) => issue.severity === "error");
  if (errors.length > 0) {
    throw new CaseGraphError("validation_error", "Graph validation failed", {
      exitCode: 2,
      details: errors
    });
  }

  await appendEvents(casePaths.eventsFile, preparedEvents);
  await writeYamlFile(casePaths.caseFile, nextState.caseRecord);
  await rebuildCaseCacheForState(workspaceRoot, nextState);
  return nextState;
}

async function rebuildCaseCacheForState(
  workspaceRoot: string,
  state: CaseStateView
): Promise<void> {
  const workspacePaths = getWorkspacePaths(workspaceRoot);
  await ensureDirectory(workspacePaths.cacheDir);
  const database = openCacheDatabase(workspacePaths.cacheFile);
  try {
    rebuildCaseCache(database, state);
  } finally {
    database.close();
  }
}

async function loadCaseEvents(eventsFile: string): Promise<EventEnvelope[]> {
  try {
    const contents = await readFile(eventsFile, "utf8");
    if (contents.trim() === "") {
      return [];
    }

    return contents
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as EventEnvelope);
  } catch (error) {
    throw new CaseGraphError("events_read_failed", `Could not read ${eventsFile}`, {
      exitCode: 3,
      details: error
    });
  }
}

async function appendEvents(eventsFile: string, events: EventEnvelope[]): Promise<void> {
  await ensureDirectory(path.dirname(eventsFile));
  const lines = events.map((event) => JSON.stringify(event)).join("\n");
  const payload = `${lines}\n`;
  await appendFile(eventsFile, payload, "utf8");
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

export function createDefaultMutationContext(commandId?: string): MutationContext {
  return {
    actor: defaultActor(),
    now: nowUtc(),
    commandId: commandId ?? generateId()
  };
}
