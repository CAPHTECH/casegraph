import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { SPEC_VERSION } from "./constants.js";
import { CaseGraphError } from "./errors.js";
import { getCasePaths, getWorkspacePaths } from "./paths.js";
import type { EventEnvelope, WorkspaceRecord } from "./types.js";
import { readYamlFile } from "./yaml.js";

export interface MigrationStep {
  step_id: string;
  description: string;
  target: "workspace" | "case" | "event_log" | "cache";
}

export interface MigrationIssue {
  severity: "error";
  scope: "workspace" | "case" | "event";
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
}

export interface MigrationRunData extends MigrationCheckData {
  dry_run: boolean;
  changed: boolean;
  applied_steps: MigrationStep[];
}

export async function checkWorkspaceMigrations(workspaceRoot: string): Promise<MigrationCheckData> {
  const workspacePaths = getWorkspacePaths(workspaceRoot);
  const issues: MigrationIssue[] = [];
  let casesChecked = 0;
  let eventsChecked = 0;

  const workspaceRecord = await readYamlFile<WorkspaceRecord>(workspacePaths.workspaceFile);
  collectVersionIssue({
    issues,
    scope: "workspace",
    ref: relativeRef(workspaceRoot, workspacePaths.workspaceFile),
    detectedSpecVersion: workspaceRecord.spec_version
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

    const caseSpecVersion =
      typeof caseFile.spec_version === "string" ? caseFile.spec_version : null;
    collectVersionIssue({
      issues,
      scope: "case",
      ref: relativeRef(workspaceRoot, casePaths.caseFile),
      detectedSpecVersion: caseSpecVersion,
      caseId
    });

    const events = await readJsonLines<EventEnvelope>(casePaths.eventsFile);
    eventsChecked += events.length;
    for (const event of events) {
      collectVersionIssue({
        issues,
        scope: "event",
        ref: `${relativeRef(workspaceRoot, casePaths.eventsFile)}#${event.event_id}`,
        detectedSpecVersion: event.spec_version,
        caseId,
        eventId: event.event_id
      });
    }
  }

  return {
    workspace: workspaceRoot,
    current_spec_version: SPEC_VERSION,
    supported: issues.length === 0,
    pending_steps: [],
    issues,
    cases_checked: casesChecked,
    events_checked: eventsChecked
  };
}

export async function runWorkspaceMigrations(
  workspaceRoot: string,
  options: { dryRun?: boolean } = {}
): Promise<MigrationRunData> {
  const check = await checkWorkspaceMigrations(workspaceRoot);
  ensureSupportedMigrationCheck(check);

  return {
    ...check,
    dry_run: options.dryRun === true,
    changed: false,
    applied_steps: []
  };
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

function collectVersionIssue(input: {
  issues: MigrationIssue[];
  scope: MigrationIssue["scope"];
  ref: string;
  detectedSpecVersion: string | null;
  caseId?: string;
  eventId?: string;
}): void {
  if (input.detectedSpecVersion === null) {
    return;
  }
  if (input.detectedSpecVersion === SPEC_VERSION) {
    return;
  }

  input.issues.push({
    severity: "error",
    scope: input.scope,
    code: "unsupported_spec_version",
    message: `Unsupported spec_version ${input.detectedSpecVersion}; only ${SPEC_VERSION} is supported`,
    ref: input.ref,
    detected_spec_version: input.detectedSpecVersion,
    case_id: input.caseId,
    event_id: input.eventId
  });
}

function relativeRef(workspaceRoot: string, filePath: string): string {
  return path.relative(workspaceRoot, filePath).split(path.sep).join(path.posix.sep);
}
