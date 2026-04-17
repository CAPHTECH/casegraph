import type { AddEvidenceInput, BlockedItem, FrontierItem, MutationContext } from "@casegraph/core";

import {
  createDefaultMutationContext,
  generateId,
  normalizeUnknownError,
  resolveWorkspaceContext
} from "@casegraph/core";
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

  switch (result.command) {
    case "init":
      return `Initialized workspace ${String((result.data as { workspace: { title: string } }).workspace.title)}`;
    case "case list":
      return renderCaseList(
        (
          result as CommandSuccess<{
            cases: Array<{ case_id: string; state: string; title: string }>;
          }>
        ).data.cases
      );
    case "case show": {
      const data = (result as CommandSuccess<any>).data;
      return [
        `${data.case.case_id}: ${data.case.title}`,
        `state=${data.case.state} revision=${data.revision.current}`,
        `ready=${data.frontier_summary.ready_count}`
      ].join("\n");
    }
    case "frontier":
      return renderFrontier((result as CommandSuccess<{ nodes: FrontierItem[] }>).data.nodes);
    case "blockers":
      return renderBlockers((result as CommandSuccess<{ items: BlockedItem[] }>).data.items);
    case "validate":
    case "validate storage": {
      const data = (result as CommandSuccess<{ valid: boolean; errors: unknown[] }>).data;
      return data.valid ? "VALID" : `INVALID (${data.errors.length} errors)`;
    }
    case "patch validate": {
      const data = (result as CommandSuccess<{ valid: boolean; errors: unknown[] }>).data;
      return data.valid ? "VALID PATCH" : `INVALID PATCH (${data.errors.length} errors)`;
    }
    case "patch review": {
      const data = (result as CommandSuccess<{ valid: boolean; stale: boolean; errors: unknown[] }>)
        .data;
      if (data.stale) {
        return `STALE PATCH (${data.errors.length} errors)`;
      }
      return data.valid ? "PATCH REVIEW OK" : `PATCH REVIEW FAILED (${data.errors.length} errors)`;
    }
    case "patch apply": {
      const data = (result as CommandSuccess<{ patch_id: string; case_id: string }>).data;
      return `Applied ${data.patch_id} to ${data.case_id}`;
    }
    case "cache rebuild":
      return `Rebuilt cache for ${(result as CommandSuccess<{ cases: number }>).data.cases} cases`;
    case "events verify": {
      const data = (result as CommandSuccess<{ event_count: number; case_id: string }>).data;
      return `Verified ${data.event_count} events for ${data.case_id}`;
    }
    case "events export":
      return JSON.stringify((result as CommandSuccess<{ events: unknown[] }>).data.events, null, 2);
    case "import markdown": {
      const data = (result as CommandSuccess<{ patch: unknown; output_file?: string }>).data;
      return data.output_file
        ? `Wrote patch to ${data.output_file}`
        : JSON.stringify(data.patch, null, 2);
    }
    case "sync push": {
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
    case "worker run": {
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
    case "sync pull": {
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
    default:
      return `${result.command} ok`;
  }
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
