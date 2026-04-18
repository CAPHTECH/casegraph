import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  CaseGraphError,
  parseYaml,
  SPEC_VERSION,
  stringifyYaml,
  type EventEnvelope,
  type WorkspaceRecord
} from "@caphtech/casegraph-kernel";
import { withWorkspaceLock } from "./lock.js";
import { getCasePaths, getWorkspacePaths } from "./paths.js";
import { rebuildCache } from "./workspace.js";
import { readYamlFile, writeYamlFile } from "./yaml.js";

export type MigrationTarget = "workspace" | "case" | "event_log" | "patch_file" | "cache";
export type MigrationAction = "none" | "rewrite_spec_version" | "reader_compatible";
export type MigrationStatus = "pending" | "dry_run" | "applied" | "unsupported";

export interface MigrationStep {
  step_id: string;
  description: string;
  target: MigrationTarget;
  from_version: string;
  to_version: string;
  action: Exclude<MigrationAction, "none">;
}

export interface MigrationTargetResult {
  target: MigrationTarget;
  path: string;
  from_version: string | null;
  to_version: string;
  action: MigrationAction;
  status: MigrationStatus;
  changed: boolean;
  case_id?: string;
  event_id?: string;
  step_id?: string;
}

export interface MigrationIssue {
  severity: "error";
  scope: "workspace" | "case" | "event" | "patch";
  code: string;
  message: string;
  ref: string;
  detected_spec_version: string | null;
  case_id?: string;
  event_id?: string;
}

export interface MigrationCheckData {
  workspace: string;
  current_spec_version: string;
  supported: boolean;
  pending_steps: MigrationStep[];
  issues: MigrationIssue[];
  cases_checked: number;
  events_checked: number;
  targets: MigrationTargetResult[];
}

export interface MigrationRunData extends MigrationCheckData {
  dry_run: boolean;
  changed: boolean;
  applied_steps: MigrationStep[];
  cache_rebuilt: boolean;
}

export interface MigrationOptions {
  dryRun?: boolean;
  patchFiles?: string[];
}

interface PlannedMigrationTarget extends MigrationTargetResult {
  absolute_path: string;
}

const MIGRATION_STEP_REGISTRY: MigrationStep[] = [
  {
    step_id: "workspace-spec-0.0.9-to-0.1-draft",
    description: "Normalize workspace.yaml spec_version to 0.1-draft",
    target: "workspace",
    from_version: "0.0.9",
    to_version: SPEC_VERSION,
    action: "rewrite_spec_version"
  },
  {
    step_id: "case-spec-0.0.9-to-0.1-draft",
    description: "Normalize case.yaml spec_version marker to the current optional shape",
    target: "case",
    from_version: "0.0.9",
    to_version: SPEC_VERSION,
    action: "rewrite_spec_version"
  },
  {
    step_id: "event-log-spec-0.0.9-to-0.1-draft",
    description: "Accept legacy event log spec_version through replay compatibility",
    target: "event_log",
    from_version: "0.0.9",
    to_version: SPEC_VERSION,
    action: "reader_compatible"
  },
  {
    step_id: "patch-spec-0.0.9-to-0.1-draft",
    description: "Normalize patch file spec_version to 0.1-draft",
    target: "patch_file",
    from_version: "0.0.9",
    to_version: SPEC_VERSION,
    action: "rewrite_spec_version"
  }
];

export async function checkWorkspaceMigrations(
  workspaceRoot: string,
  options: MigrationOptions = {}
): Promise<MigrationCheckData> {
  const plan = await buildMigrationPlan(workspaceRoot, options);
  return toCheckData(plan);
}

export async function runWorkspaceMigrations(
  workspaceRoot: string,
  options: MigrationOptions = {}
): Promise<MigrationRunData> {
  const workspacePaths = getWorkspacePaths(workspaceRoot);

  return withWorkspaceLock(workspacePaths.lockFile, async () => {
    const plan = await buildMigrationPlan(workspaceRoot, options);
    const check = toCheckData(plan);
    ensureSupportedMigrationCheck(check);

    if (options.dryRun === true) {
      return {
        ...check,
        dry_run: true,
        changed: false,
        applied_steps: [],
        cache_rebuilt: false,
        targets: check.targets.map((target) => ({
          ...target,
          status: target.status === "pending" ? "dry_run" : target.status
        }))
      };
    }

    const appliedStepIds = new Set<string>();
    const nextTargets: MigrationTargetResult[] = [];
    let changed = false;
    let cacheRebuildRequired = false;

    for (const target of plan.targets) {
      if (target.status !== "pending") {
        nextTargets.push(stripAbsolutePath(target));
        continue;
      }

      const applied = await applyMigrationTarget(target);
      if (target.step_id) {
        appliedStepIds.add(target.step_id);
      }
      changed = changed || applied.changed;
      cacheRebuildRequired = cacheRebuildRequired || applied.cache_rebuild_required;
      nextTargets.push({
        ...stripAbsolutePath(target),
        status: "applied",
        changed: applied.changed
      });
    }

    let cacheRebuilt = false;
    if (cacheRebuildRequired) {
      await rebuildCache(workspaceRoot);
      cacheRebuilt = true;
    }

    return {
      ...check,
      dry_run: false,
      pending_steps: [],
      changed,
      applied_steps: MIGRATION_STEP_REGISTRY.filter((step) => appliedStepIds.has(step.step_id)),
      cache_rebuilt: cacheRebuilt,
      targets: nextTargets
    };
  });
}

export function ensureSupportedMigrationCheck(check: MigrationCheckData): void {
  if (check.supported) {
    return;
  }

  throw new CaseGraphError(
    "migration_unsupported_version",
    "Unsupported spec_version detected; no migration path is implemented for this workspace",
    {
      exitCode: 2,
      details: {
        current_spec_version: check.current_spec_version,
        issues: check.issues
      }
    }
  );
}

async function buildMigrationPlan(
  workspaceRoot: string,
  options: MigrationOptions
): Promise<{
  workspace: string;
  current_spec_version: string;
  issues: MigrationIssue[];
  cases_checked: number;
  events_checked: number;
  targets: PlannedMigrationTarget[];
}> {
  const workspacePaths = getWorkspacePaths(workspaceRoot);
  const issues: MigrationIssue[] = [];
  const targets: PlannedMigrationTarget[] = [];
  let casesChecked = 0;
  let eventsChecked = 0;

  const workspaceRecord = await readYamlFile<WorkspaceRecord>(workspacePaths.workspaceFile);
  collectVersionTarget({
    workspaceRoot,
    issues,
    targets,
    target: "workspace",
    scope: "workspace",
    filePath: workspacePaths.workspaceFile,
    detectedSpecVersion: workspaceRecord.spec_version,
    missingIsCurrent: false
  });

  const caseEntries = await readdir(workspacePaths.casesDir, { withFileTypes: true }).catch(
    () => []
  );
  const caseDirs = caseEntries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));

  for (const caseId of caseDirs) {
    const casePaths = getCasePaths(workspaceRoot, caseId);
    const caseFile = await readYamlFile<Record<string, unknown>>(casePaths.caseFile);
    casesChecked += 1;

    collectVersionTarget({
      workspaceRoot,
      issues,
      targets,
      target: "case",
      scope: "case",
      filePath: casePaths.caseFile,
      detectedSpecVersion: typeof caseFile.spec_version === "string" ? caseFile.spec_version : null,
      caseId,
      missingIsCurrent: true
    });

    const events = await readJsonLines<EventEnvelope>(casePaths.eventsFile);
    eventsChecked += events.length;
    for (const event of events) {
      collectVersionTarget({
        workspaceRoot,
        issues,
        targets,
        target: "event_log",
        scope: "event",
        filePath: casePaths.eventsFile,
        detectedSpecVersion: event.spec_version,
        caseId,
        eventId: event.event_id,
        missingIsCurrent: false
      });
    }
  }

  const patchFiles = [
    ...new Set((options.patchFiles ?? []).map((filePath) => path.resolve(filePath)))
  ];
  patchFiles.sort((left, right) => left.localeCompare(right));
  for (const patchFile of patchFiles) {
    const patchDocument = await readStructuredFile(patchFile);
    const patchSpecVersion = getStringRecordValue(patchDocument, "spec_version");

    collectVersionTarget({
      workspaceRoot,
      issues,
      targets,
      target: "patch_file",
      scope: "patch",
      filePath: patchFile,
      detectedSpecVersion: patchSpecVersion,
      missingIsCurrent: false
    });
  }

  return {
    workspace: workspaceRoot,
    current_spec_version: SPEC_VERSION,
    issues,
    cases_checked: casesChecked,
    events_checked: eventsChecked,
    targets
  };
}

function toCheckData(plan: {
  workspace: string;
  current_spec_version: string;
  issues: MigrationIssue[];
  cases_checked: number;
  events_checked: number;
  targets: PlannedMigrationTarget[];
}): MigrationCheckData {
  const pendingSteps = collectUniqueSteps(plan.targets);

  return {
    workspace: plan.workspace,
    current_spec_version: plan.current_spec_version,
    supported: plan.issues.length === 0,
    pending_steps: pendingSteps,
    issues: plan.issues,
    cases_checked: plan.cases_checked,
    events_checked: plan.events_checked,
    targets: plan.targets.map(stripAbsolutePath)
  };
}

function collectVersionTarget(input: {
  workspaceRoot: string;
  issues: MigrationIssue[];
  targets: PlannedMigrationTarget[];
  target: PlannedMigrationTarget["target"];
  scope: MigrationIssue["scope"];
  filePath: string;
  detectedSpecVersion: string | null;
  caseId?: string;
  eventId?: string;
  missingIsCurrent: boolean;
}): void {
  const displayPath = formatDisplayPath(input.workspaceRoot, input.filePath);
  const ref =
    input.scope === "event" && input.eventId ? `${displayPath}#${input.eventId}` : displayPath;

  if (input.detectedSpecVersion === null && input.missingIsCurrent) {
    return;
  }

  if (input.detectedSpecVersion === SPEC_VERSION) {
    return;
  }

  const step =
    input.detectedSpecVersion === null
      ? undefined
      : MIGRATION_STEP_REGISTRY.find(
          (candidate) =>
            candidate.target === input.target &&
            candidate.from_version === input.detectedSpecVersion
        );

  if (!step) {
    input.targets.push({
      target: input.target,
      absolute_path: input.filePath,
      path: displayPath,
      from_version: input.detectedSpecVersion,
      to_version: SPEC_VERSION,
      action: "none",
      status: "unsupported",
      changed: false,
      case_id: input.caseId,
      event_id: input.eventId
    });
    input.issues.push({
      severity: "error",
      scope: input.scope,
      code:
        input.detectedSpecVersion === null ? "missing_spec_version" : "unsupported_spec_version",
      message:
        input.detectedSpecVersion === null
          ? `Missing spec_version; no migration path is implemented for ${displayPath}`
          : `Unsupported spec_version ${input.detectedSpecVersion}; only ${SPEC_VERSION} and known migration paths are supported`,
      ref,
      detected_spec_version: input.detectedSpecVersion,
      case_id: input.caseId,
      event_id: input.eventId
    });
    return;
  }

  input.targets.push({
    target: input.target,
    absolute_path: input.filePath,
    path: displayPath,
    from_version: input.detectedSpecVersion,
    to_version: step.to_version,
    action: step.action,
    status: "pending",
    changed: false,
    case_id: input.caseId,
    event_id: input.eventId,
    step_id: step.step_id
  });
}

function collectUniqueSteps(targets: PlannedMigrationTarget[]): MigrationStep[] {
  const stepIds = new Set(targets.map((target) => target.step_id).filter(isPresent));
  return MIGRATION_STEP_REGISTRY.filter((step) => stepIds.has(step.step_id));
}

async function applyMigrationTarget(target: PlannedMigrationTarget): Promise<{
  changed: boolean;
  cache_rebuild_required: boolean;
}> {
  switch (target.target) {
    case "workspace": {
      const workspaceRecord = await readYamlFile<WorkspaceRecord>(target.absolute_path);
      await writeYamlFile(target.absolute_path, {
        ...workspaceRecord,
        spec_version: SPEC_VERSION
      });
      return { changed: true, cache_rebuild_required: false };
    }

    case "case": {
      const caseRecord = await readYamlFile<Record<string, unknown>>(target.absolute_path);
      delete caseRecord.spec_version;
      await writeYamlFile(target.absolute_path, caseRecord);
      return { changed: true, cache_rebuild_required: true };
    }

    case "event_log":
      return { changed: false, cache_rebuild_required: false };

    case "patch_file": {
      const patchDocument = await readStructuredFile(target.absolute_path);
      if (!isRecord(patchDocument)) {
        throw new CaseGraphError(
          "migration_patch_invalid",
          `Patch file ${target.absolute_path} must be an object`,
          { exitCode: 2 }
        );
      }
      await writeStructuredFile(target.absolute_path, {
        ...patchDocument,
        spec_version: SPEC_VERSION
      });
      return { changed: true, cache_rebuild_required: false };
    }

    case "cache":
      return { changed: false, cache_rebuild_required: false };
  }
}

async function readJsonLines<TRecord>(filePath: string): Promise<TRecord[]> {
  try {
    const contents = await readFile(filePath, "utf8");
    const trimmed = contents.trim();
    if (trimmed.length === 0) {
      return [];
    }

    return trimmed
      .split(/\r?\n/)
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as TRecord);
  } catch (error) {
    throw new CaseGraphError("migration_scan_failed", `Could not scan ${filePath}`, {
      exitCode: 3,
      details: error
    });
  }
}

async function readStructuredFile(filePath: string): Promise<unknown> {
  const extension = path.extname(filePath).toLowerCase();

  try {
    const contents = await readFile(filePath, "utf8");
    if (extension === ".json") {
      return JSON.parse(contents) as unknown;
    }
    if (extension === ".yaml" || extension === ".yml") {
      return parseYaml(contents);
    }
  } catch (error) {
    throw new CaseGraphError("migration_scan_failed", `Could not scan ${filePath}`, {
      exitCode: 3,
      details: error
    });
  }

  throw new CaseGraphError(
    "migration_patch_format_unsupported",
    `Unsupported patch file format for ${filePath}`,
    { exitCode: 2 }
  );
}

async function writeStructuredFile(filePath: string, value: unknown): Promise<void> {
  const extension = path.extname(filePath).toLowerCase();

  if (extension === ".json") {
    await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    return;
  }
  if (extension === ".yaml" || extension === ".yml") {
    await writeFile(filePath, stringifyYaml(value), "utf8");
    return;
  }

  throw new CaseGraphError(
    "migration_patch_format_unsupported",
    `Unsupported patch file format for ${filePath}`,
    { exitCode: 2 }
  );
}

function stripAbsolutePath(target: PlannedMigrationTarget): MigrationTargetResult {
  return {
    target: target.target,
    path: target.path,
    from_version: target.from_version,
    to_version: target.to_version,
    action: target.action,
    status: target.status,
    changed: target.changed,
    case_id: target.case_id,
    event_id: target.event_id,
    step_id: target.step_id
  };
}

function formatDisplayPath(workspaceRoot: string, filePath: string): string {
  const relativePath = path.relative(workspaceRoot, filePath);
  if (relativePath.length > 0 && !relativePath.startsWith("..")) {
    return relativePath.split(path.sep).join(path.posix.sep);
  }
  return path.resolve(filePath);
}

function getStringRecordValue(record: unknown, key: string): string | null {
  if (!isRecord(record)) {
    return null;
  }
  return typeof record[key] === "string" ? (record[key] as string) : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPresent<TValue>(value: TValue | null | undefined): value is TValue {
  return value !== null && value !== undefined;
}
