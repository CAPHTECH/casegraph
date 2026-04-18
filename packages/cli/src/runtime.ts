import type {
  AddEvidenceInput,
  BlockedItem,
  BottleneckAnalysisResult,
  BridgeAnalysisResult,
  ComponentAnalysisResult,
  CriticalPathAnalysisResult,
  CutpointAnalysisResult,
  CycleAnalysisResult,
  FragilityAnalysisResult,
  FrontierItem,
  ImpactAnalysisResult,
  MinimalUnblockSetResult,
  MutationContext,
  SlackAnalysisResult
} from "@caphtech/casegraph-kernel";

import {
  createDefaultMutationContext,
  generateId
} from "@caphtech/casegraph-kernel";

import {
  type MigrationCheckData,
  type MigrationRunData,
  normalizeUnknownError,
  resolveWorkspaceContext,
  type ShowCaseData
} from "@caphtech/casegraph-core";
import type { Command } from "commander";

import type { CommandResult, CommandSuccess } from "./result.js";

interface CliReportedError {
  cliReported?: boolean;
  exitCode?: number;
}

export interface CliIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

export interface CliRuntimeOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  io?: CliIo;
}

export interface CliRuntime {
  io: CliIo;
  cwd: string;
  env: NodeJS.ProcessEnv;
  format: "text" | "json";
}

export interface GlobalOptions {
  workspace?: string;
  format: "text" | "json";
  quiet?: boolean;
  verbose?: boolean;
}

export function createCliRuntime(
  argv: string[],
  runtimeOptions: CliRuntimeOptions = {}
): CliRuntime {
  return {
    io: runtimeOptions.io ?? {
      stdout: (text) => process.stdout.write(text),
      stderr: (text) => process.stderr.write(text)
    },
    cwd: runtimeOptions.cwd ?? process.cwd(),
    env: runtimeOptions.env ?? process.env,
    format: detectOutputFormat(argv)
  };
}

export async function runCliAction<TData>(
  runtime: CliRuntime,
  command: Command,
  action: (globals: GlobalOptions) => Promise<CommandResult<TData>>
): Promise<void> {
  const globals = getGlobalOptions(command);
  runtime.format = globals.format;

  try {
    const result = await action(globals);
    emitResult(runtime, result, false);
  } catch (error) {
    const normalized = markCliReported(normalizeUnknownError(error));
    emitResult(
      runtime,
      {
        ok: false,
        command: "cg",
        error: {
          code: normalized.code,
          message: normalized.message,
          details: normalized.details
        }
      },
      true
    );
    throw normalized;
  }
}

export async function runWorkspaceCommand<TData>(
  runtime: CliRuntime,
  command: Command,
  action: (workspaceRoot: string, globals: GlobalOptions) => Promise<CommandResult<TData>>
): Promise<void> {
  await runCliAction(runtime, command, async (globals) => {
    const workspace = await resolveWorkspaceContext({
      cwd: runtime.cwd,
      env: runtime.env,
      workspaceOverride: globals.workspace
    });
    return action(workspace.workspaceRoot, globals);
  });
}

export async function runMutationCommand<TData>(
  runtime: CliRuntime,
  command: Command,
  action: (
    workspaceRoot: string,
    globals: GlobalOptions,
    mutationContext: MutationContext
  ) => Promise<CommandResult<TData>>
): Promise<void> {
  await runWorkspaceCommand(runtime, command, async (workspaceRoot, globals) =>
    action(workspaceRoot, globals, createDefaultMutationContext())
  );
}

export function emitFatalCliError(runtime: CliRuntime, error: unknown): number {
  const normalized = normalizeUnknownError(error);

  if (!isCliReported(normalized)) {
    emitResult(
      runtime,
      {
        ok: false,
        command: "cg",
        error: {
          code: normalized.code,
          message: normalized.message,
          details: normalized.details
        }
      },
      true
    );
  }

  return normalized.exitCode;
}

export function parseCsv(value: string | undefined): string[] {
  if (!value) {
    return [];
  }

  return value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

export function parseJsonObject(value: string | undefined): Record<string, unknown> {
  if (!value) {
    return {};
  }

  return JSON.parse(value) as Record<string, unknown>;
}

export function createAttachmentOptions(
  options: Record<string, unknown>,
  nodeId: string
): AddEvidenceInput["attachment"] {
  if (typeof options.file === "string") {
    return {
      attachment_id: generateId(),
      evidence_node_id: nodeId,
      storage_mode: "workspace_copy",
      path_or_url: options.file,
      sha256: null,
      mime_type: null,
      size_bytes: null
    };
  }

  if (typeof options.url === "string") {
    return {
      attachment_id: generateId(),
      evidence_node_id: nodeId,
      storage_mode: "url",
      path_or_url: options.url,
      sha256: null,
      mime_type: null,
      size_bytes: null
    };
  }

  return undefined;
}

function detectOutputFormat(argv: string[]): "text" | "json" {
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--format") {
      const nextValue = argv[index + 1];
      return nextValue === "json" ? "json" : "text";
    }

    if (value === "--format=json") {
      return "json";
    }

    if (value === "--format=text") {
      return "text";
    }
  }

  return "text";
}

function emitResult(runtime: CliRuntime, result: CommandResult<unknown>, isError: boolean): void {
  const target = isError ? runtime.io.stderr : runtime.io.stdout;
  target(
    runtime.format === "json" ? `${JSON.stringify(result, null, 2)}\n` : `${renderText(result)}\n`
  );
}

function renderText(result: CommandResult<unknown>): string {
  if (!result.ok) {
    return `ERROR ${result.error.code}: ${result.error.message}`;
  }

  return renderSuccessText(result);
}

function renderSuccessText(result: CommandSuccess<unknown>): string {
  const renderer = textRenderers[result.command];
  return renderer ? renderer(result) : `${result.command} ok`;
}

const textRenderers: Record<string, (result: CommandSuccess<unknown>) => string> = {
  init: renderInitText,
  "case list": renderCaseListText,
  "case show": renderCaseShowText,
  "case view": renderCaseViewText,
  "case close": renderCaseCloseText,
  frontier: renderFrontierText,
  blockers: renderBlockersText,
  "analyze impact": renderAnalyzeImpactText,
  "analyze critical-path": renderAnalyzeCriticalPathText,
  "analyze slack": renderAnalyzeSlackText,
  "analyze bottlenecks": renderAnalyzeBottlenecksText,
  "analyze cycles": renderAnalyzeCyclesText,
  "analyze components": renderAnalyzeComponentsText,
  "analyze bridges": renderAnalyzeBridgesText,
  "analyze cutpoints": renderAnalyzeCutpointsText,
  "analyze fragility": renderAnalyzeFragilityText,
  "analyze unblock": renderAnalyzeUnblockText,
  validate: renderValidationText,
  "validate storage": renderValidationText,
  "migrate check": renderMigrateCheckText,
  "migrate run": renderMigrateRunText,
  "patch validate": renderPatchValidateText,
  "patch review": renderPatchReviewText,
  "patch apply": renderPatchApplyText,
  "cache rebuild": renderCacheRebuildText,
  "events verify": renderEventsVerifyText,
  "events export": renderEventsExportText,
  "import markdown": renderImportMarkdownText,
  "sync push": renderSyncPushText,
  "worker run": renderWorkerRunText,
  "sync pull": renderSyncPullText
};

function renderInitText(result: CommandSuccess<unknown>): string {
  return `Initialized workspace ${String((result.data as { workspace: { title: string } }).workspace.title)}`;
}

function renderCaseListText(result: CommandSuccess<unknown>): string {
  return renderCaseList(
    (
      result as CommandSuccess<{
        cases: Array<{ case_id: string; state: string; title: string }>;
      }>
    ).data.cases
  );
}

function renderCaseShowText(result: CommandSuccess<unknown>): string {
  const data = (result as CommandSuccess<ShowCaseData>).data;
  return [
    `${data.case.case_id}: ${data.case.title}`,
    `state=${data.case.state} revision=${data.revision.current}`,
    `ready=${data.frontier_summary.ready_count}`
  ].join("\n");
}

function renderCaseViewText(result: CommandSuccess<unknown>): string {
  return (result as CommandSuccess<{ tree_lines: string[] }>).data.tree_lines.join("\n");
}

function renderCaseCloseText(result: CommandSuccess<unknown>): string {
  const data = result as CommandSuccess<{
    case: { case_id: string; state: string };
    changed: boolean;
    forced: boolean;
    checks: {
      ready_node_ids: string[];
      non_terminal_goal_ids: string[];
      validation_warnings: unknown[];
    };
  }>;

  return [
    `${data.data.case.case_id}: state=${data.data.case.state} changed=${data.data.changed ? "yes" : "no"}`,
    `ready=${data.data.checks.ready_node_ids.length} goals=${data.data.checks.non_terminal_goal_ids.length} warnings=${data.data.checks.validation_warnings.length} forced=${data.data.forced ? "yes" : "no"}`
  ].join("\n");
}

function renderFrontierText(result: CommandSuccess<unknown>): string {
  return renderFrontier((result as CommandSuccess<{ nodes: FrontierItem[] }>).data.nodes);
}

function renderBlockersText(result: CommandSuccess<unknown>): string {
  return renderBlockers((result as CommandSuccess<{ items: BlockedItem[] }>).data.items);
}

function renderAnalyzeImpactText(result: CommandSuccess<unknown>): string {
  const data = (result as CommandSuccess<ImpactAnalysisResult>).data;
  return [
    `source=${data.source_node_id}`,
    `hard=${data.hard_impact.map((item) => item.node_id).join(",") || "-"}`,
    `context=${data.context_impact.map((item) => item.node_id).join(",") || "-"}`,
    `frontier_invalidations=${data.frontier_invalidations.map((item) => item.node_id).join(",") || "-"}`
  ].join("\n");
}

function renderAnalyzeCriticalPathText(result: CommandSuccess<unknown>): string {
  const data = (result as CommandSuccess<CriticalPathAnalysisResult>).data;
  return [
    `goal=${data.goal_node_id ?? "-"}`,
    `depth=${data.depth_path.node_ids.join(" -> ") || "-"}`,
    `duration=${data.duration_path?.node_ids.join(" -> ") || "-"}`
  ].join("\n");
}

function renderAnalyzeSlackText(result: CommandSuccess<unknown>): string {
  const data = (result as CommandSuccess<SlackAnalysisResult>).data;
  const criticalNodeIds = data.nodes.filter((node) => node.is_critical).map((node) => node.node_id);
  return [
    `goal=${data.goal_node_id ?? "-"}`,
    `duration=${data.projected_duration_minutes ?? "-"}`,
    `critical=${criticalNodeIds.join(",") || "-"}`
  ].join("\n");
}

function renderAnalyzeBottlenecksText(result: CommandSuccess<unknown>): string {
  const data = (result as CommandSuccess<BottleneckAnalysisResult>).data;
  if (data.nodes.length === 0) {
    return "bottlenecks=-";
  }

  return data.nodes
    .map(
      (node) =>
        `${node.node_id}:downstream=${node.downstream_count},frontier=${node.frontier_invalidation_count},goals=${node.goal_context_count}`
    )
    .join("\n");
}

function renderAnalyzeCyclesText(result: CommandSuccess<unknown>): string {
  const data = (result as CommandSuccess<CycleAnalysisResult>).data;
  if (data.cycles.length === 0) {
    return "cycles=-";
  }

  return data.cycles
    .map((cycle, index) => `cycle_${index + 1}=${cycle.node_ids.join(",")}`)
    .join("\n");
}

function renderAnalyzeComponentsText(result: CommandSuccess<unknown>): string {
  const data = (result as CommandSuccess<ComponentAnalysisResult>).data;
  if (data.components.length === 0) {
    return "components=-";
  }

  return data.components
    .map(
      (component, index) =>
        `component_${index + 1}:nodes=${component.node_ids.join(",")} edges=${component.edge_count}`
    )
    .join("\n");
}

function renderAnalyzeBridgesText(result: CommandSuccess<unknown>): string {
  const data = (result as CommandSuccess<BridgeAnalysisResult>).data;
  if (data.bridges.length === 0) {
    return "bridges=-";
  }

  return data.bridges
    .map(
      (bridge) =>
        `${bridge.source_id}::${bridge.target_id} split=${bridge.left_node_ids.join(",")} | ${bridge.right_node_ids.join(",")}`
    )
    .join("\n");
}

function renderAnalyzeCutpointsText(result: CommandSuccess<unknown>): string {
  const data = (result as CommandSuccess<CutpointAnalysisResult>).data;
  if (data.cutpoints.length === 0) {
    return "cutpoints=-";
  }

  return data.cutpoints
    .map(
      (cutpoint) =>
        `${cutpoint.node_id}:components=${cutpoint.separated_component_node_sets
          .map((nodeIds) => `[${nodeIds.join(",")}]`)
          .join(" ")}`
    )
    .join("\n");
}

function renderAnalyzeFragilityText(result: CommandSuccess<unknown>): string {
  const data = (result as CommandSuccess<FragilityAnalysisResult>).data;
  if (data.nodes.length === 0) {
    return "fragility=-";
  }

  return data.nodes
    .map(
      (node) =>
        `${node.node_id}:score=${node.fragility_score},tags=${node.reason_tags.join("+") || "-"}`
    )
    .join("\n");
}

function renderAnalyzeUnblockText(result: CommandSuccess<unknown>): string {
  const data = (result as CommandSuccess<MinimalUnblockSetResult>).data;
  return [
    `target=${data.target_node_id}`,
    `actionable=${data.actionable_leaf_node_ids.join(",") || "-"}`,
    `blockers=${data.blockers.map((blocker) => blocker.node_id).join(",") || "-"}`
  ].join("\n");
}

function renderValidationText(result: CommandSuccess<unknown>): string {
  const data = (result as CommandSuccess<{ valid: boolean; errors: unknown[] }>).data;
  return data.valid ? "VALID" : `INVALID (${data.errors.length} errors)`;
}

function renderMigrateCheckText(result: CommandSuccess<unknown>): string {
  const data = (result as CommandSuccess<MigrationCheckData>).data;
  const status = data.supported ? "SUPPORTED" : "UNSUPPORTED";
  return `${status} current=${data.current_spec_version} pending=${data.pending_steps.length} targets=${data.targets.length} issues=${data.issues.length}`;
}

function renderMigrateRunText(result: CommandSuccess<unknown>): string {
  const data = (result as CommandSuccess<MigrationRunData>).data;
  const mode = data.dry_run ? "DRY-RUN" : "MIGRATION";
  return `${mode} changed=${data.changed ? "yes" : "no"} applied=${data.applied_steps.length} cache_rebuilt=${data.cache_rebuilt ? "yes" : "no"}`;
}

function renderPatchValidateText(result: CommandSuccess<unknown>): string {
  const data = (result as CommandSuccess<{ valid: boolean; errors: unknown[] }>).data;
  return data.valid ? "VALID PATCH" : `INVALID PATCH (${data.errors.length} errors)`;
}

function renderPatchReviewText(result: CommandSuccess<unknown>): string {
  const data = (result as CommandSuccess<{ valid: boolean; stale: boolean; errors: unknown[] }>)
    .data;
  if (data.stale) {
    return `STALE PATCH (${data.errors.length} errors)`;
  }
  return data.valid ? "PATCH REVIEW OK" : `PATCH REVIEW FAILED (${data.errors.length} errors)`;
}

function renderPatchApplyText(result: CommandSuccess<unknown>): string {
  const data = (result as CommandSuccess<{ patch_id: string; case_id: string }>).data;
  return `Applied ${data.patch_id} to ${data.case_id}`;
}

function renderCacheRebuildText(result: CommandSuccess<unknown>): string {
  return `Rebuilt cache for ${(result as CommandSuccess<{ cases: number }>).data.cases} cases`;
}

function renderEventsVerifyText(result: CommandSuccess<unknown>): string {
  const data = (result as CommandSuccess<{ event_count: number; case_id: string }>).data;
  return `Verified ${data.event_count} events for ${data.case_id}`;
}

function renderEventsExportText(result: CommandSuccess<unknown>): string {
  return JSON.stringify((result as CommandSuccess<{ events: unknown[] }>).data.events, null, 2);
}

function renderImportMarkdownText(result: CommandSuccess<unknown>): string {
  const data = (result as CommandSuccess<{ patch: unknown; output_file?: string }>).data;
  return data.output_file
    ? `Wrote patch to ${data.output_file}`
    : JSON.stringify(data.patch, null, 2);
}

function renderSyncPushText(result: CommandSuccess<unknown>): string {
  const data = (
    result as CommandSuccess<{
      sink_name: string;
      applied: boolean;
      plan_summary: Record<string, number>;
      plan_warnings: string[];
      apply_warnings: string[];
    }>
  ).data;
  const summary = Object.entries(data.plan_summary)
    .filter(([, count]) => count > 0)
    .map(([op, count]) => `${op}=${count}`)
    .join(" ");
  const verb = data.applied ? "Applied" : "Planned";
  return `${verb} projection to ${data.sink_name} (${summary || "no-op"})`;
}

function renderWorkerRunText(result: CommandSuccess<unknown>): string {
  const data = (
    result as CommandSuccess<{
      worker_name: string;
      status: string;
      node_id: string;
      summary: string;
      exit_code: number | null;
      output_file: string | null;
    }>
  ).data;
  const exitPart = data.exit_code !== null ? ` exit=${data.exit_code}` : "";
  const patchPart = data.output_file ? ` patch=${data.output_file}` : "";
  return `Worker ${data.worker_name} ${data.status} for ${data.node_id}${exitPart}${patchPart}`;
}

function renderSyncPullText(result: CommandSuccess<unknown>): string {
  const data = (
    result as CommandSuccess<{
      sink_name: string;
      patch: unknown;
      item_count: number;
      warnings: string[];
      output_file: string | null;
    }>
  ).data;
  if (!data.patch) {
    return `Pulled ${data.item_count} items from ${data.sink_name}; no state changes`;
  }
  return `Wrote patch to ${data.output_file} (pulled ${data.item_count} items)`;
}

function renderCaseList(cases: Array<{ case_id: string; state: string; title: string }>): string {
  if (cases.length === 0) {
    return "No cases";
  }

  return cases
    .map((caseRecord) => `${caseRecord.case_id}\t${caseRecord.state}\t${caseRecord.title}`)
    .join("\n");
}

function renderFrontier(nodes: FrontierItem[]): string {
  if (nodes.length === 0) {
    return "No frontier nodes";
  }

  return nodes.map((node) => `${node.node_id}\t${node.kind}\t${node.title}`).join("\n");
}

function renderBlockers(items: BlockedItem[]): string {
  if (items.length === 0) {
    return "No blockers";
  }

  return items
    .map(
      (item) => `${item.node.node_id}\t${item.reasons.map((reason) => reason.message).join("; ")}`
    )
    .join("\n");
}

function getGlobalOptions(command: Command): GlobalOptions {
  const options: Record<string, unknown> = {};
  let current: Command | undefined = command;

  while (current) {
    Object.assign(options, current.opts());
    current = current.parent ?? undefined;
  }

  return {
    workspace: options.workspace as string | undefined,
    format: (options.format as "text" | "json" | undefined) ?? "text",
    quiet: options.quiet as boolean | undefined,
    verbose: options.verbose as boolean | undefined
  };
}

function markCliReported<T extends CliReportedError>(error: T): T {
  error.cliReported = true;
  return error;
}

function isCliReported(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "cliReported" in error &&
    (error as CliReportedError).cliReported === true
  );
}
