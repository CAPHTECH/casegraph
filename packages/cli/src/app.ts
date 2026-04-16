import path from "node:path";
import { Command } from "commander";

import {
  addEdge,
  addEvidence,
  addNode,
  changeNodeState,
  createCase,
  createDefaultMutationContext,
  exportEvents,
  generateId,
  getFrontierItems,
  initWorkspace,
  listBlockedItems,
  listCases,
  normalizeUnknownError,
  recordEventNode,
  rebuildCache,
  removeEdge,
  resolveWorkspaceContext,
  showCase,
  successResult,
  updateNode,
  validateCase,
  validateStorage,
  verifyEvents,
  waitTask,
  decideNode
} from "@casegraph/core";
import type {
  BlockedItem,
  EdgeType,
  NodeKind,
  NodeState,
  CommandResult,
  CommandSuccess,
  FrontierItem
} from "@casegraph/core";

interface CliIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

interface CliRuntimeOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  io?: CliIo;
}

interface GlobalOptions {
  workspace?: string;
  format: "text" | "json";
  quiet?: boolean;
  verbose?: boolean;
}

export async function runCli(
  argv: string[],
  runtimeOptions: CliRuntimeOptions = {}
): Promise<number> {
  const io: CliIo = runtimeOptions.io ?? {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text)
  };
  const cwd = runtimeOptions.cwd ?? process.cwd();
  const env = runtimeOptions.env ?? process.env;
  let outputFormat: "text" | "json" = "text";

  const program = new Command();
  program
    .name("cg")
    .description("CaseGraph CLI")
    .option("--workspace <path>")
    .option("--format <format>", "text or json", "text")
    .option("--quiet")
    .option("--verbose")
    .showHelpAfterError();

  program.exitOverride();

  program
    .command("init")
    .option("--title <title>")
    .action(async (_, command) => {
      const globals = getGlobalOptions(command);
      outputFormat = globals.format;
      await runCommand(
        io,
        globals.format,
        async () =>
          successResult(
            "init",
            {
              workspace: await initWorkspace({
                workspaceRoot: globals.workspace
                  ? path.resolve(cwd, globals.workspace)
                  : cwd,
                title: command.opts().title as string | undefined
              })
            }
          )
      );
    });

  const caseCommand = program.command("case");
  caseCommand
    .command("new")
    .requiredOption("--id <caseId>")
    .requiredOption("--title <title>")
    .option("--description <description>", "Case description", "")
    .action(async (_, command) => {
      const globals = getGlobalOptions(command);
      outputFormat = globals.format;
      await runCommand(io, globals.format, async () => {
        const workspace = await resolveWorkspaceContext({
          cwd,
          env,
          workspaceOverride: globals.workspace
        });
        const state = await createCase(
          workspace.workspaceRoot,
          {
            case_id: command.opts().id as string,
            title: command.opts().title as string,
            description: command.opts().description as string
          },
          createDefaultMutationContext()
        );
        return successResult(
          "case new",
          { case: state.caseRecord },
          state.caseRecord.case_revision
        );
      });
    });

  caseCommand.command("list").action(async (_, command) => {
    const globals = getGlobalOptions(command);
    outputFormat = globals.format;
    await runCommand(io, globals.format, async () => {
      const workspace = await resolveWorkspaceContext({
        cwd,
        env,
        workspaceOverride: globals.workspace
      });
      return successResult("case list", { cases: await listCases(workspace.workspaceRoot) });
    });
  });

  caseCommand
    .command("show")
    .requiredOption("--case <caseId>")
    .action(async (_, command) => {
      const globals = getGlobalOptions(command);
      outputFormat = globals.format;
      await runCommand(io, globals.format, async () => {
        const workspace = await resolveWorkspaceContext({
          cwd,
          env,
          workspaceOverride: globals.workspace
        });
        const data = await showCase(workspace.workspaceRoot, command.opts().case as string);
        return successResult("case show", data, data.revision);
      });
    });

  const nodeCommand = program.command("node");
  nodeCommand
    .command("add")
    .requiredOption("--case <caseId>")
    .requiredOption("--kind <kind>")
    .requiredOption("--title <title>")
    .option("--id <nodeId>")
    .option("--description <description>", "Node description", "")
    .option("--state <state>", "Node state", "todo")
    .option("--labels <labels>")
    .option("--acceptance <acceptance>")
    .option("--metadata <json>")
    .action(async (_, command) => {
      const globals = getGlobalOptions(command);
      outputFormat = globals.format;
      await runCommand(io, globals.format, async () => {
        const workspace = await resolveWorkspaceContext({
          cwd,
          env,
          workspaceOverride: globals.workspace
        });
        const nodeId = (command.opts().id as string | undefined) ?? generateId();
        const state = await addNode(
          workspace.workspaceRoot,
          {
            caseId: command.opts().case as string,
            node: {
              node_id: nodeId,
              kind: command.opts().kind as NodeKind,
              title: command.opts().title as string,
              description: command.opts().description as string,
              state: command.opts().state as NodeState,
              labels: parseCsv(command.opts().labels as string | undefined),
              acceptance: parseCsv(command.opts().acceptance as string | undefined),
              metadata: parseJsonObject(command.opts().metadata as string | undefined),
              extensions: {}
            }
          },
          createDefaultMutationContext()
        );
        return successResult(
          "node add",
          { node: state.nodes.get(nodeId) ?? null },
          state.caseRecord.case_revision
        );
      });
    });

  nodeCommand
    .command("update")
    .requiredOption("--case <caseId>")
    .requiredOption("--id <nodeId>")
    .option("--title <title>")
    .option("--description <description>")
    .option("--labels <labels>")
    .option("--acceptance <acceptance>")
    .option("--metadata <json>")
    .action(async (_, command) => {
      const globals = getGlobalOptions(command);
      outputFormat = globals.format;
      await runCommand(io, globals.format, async () => {
        const workspace = await resolveWorkspaceContext({
          cwd,
          env,
          workspaceOverride: globals.workspace
        });
        const state = await updateNode(
          workspace.workspaceRoot,
          {
            caseId: command.opts().case as string,
            nodeId: command.opts().id as string,
            changes: {
              title: command.opts().title as string | undefined,
              description: command.opts().description as string | undefined,
              labels: command.opts().labels
                ? parseCsv(command.opts().labels as string)
                : undefined,
              acceptance: command.opts().acceptance
                ? parseCsv(command.opts().acceptance as string)
                : undefined,
              metadata: command.opts().metadata
                ? parseJsonObject(command.opts().metadata as string)
                : undefined
            }
          },
          createDefaultMutationContext()
        );
        return successResult(
          "node update",
          { node: state.nodes.get(command.opts().id as string) ?? null },
          state.caseRecord.case_revision
        );
      });
    });

  const edgeCommand = program.command("edge");
  edgeCommand
    .command("add")
    .requiredOption("--case <caseId>")
    .requiredOption("--type <type>")
    .requiredOption("--from <sourceId>")
    .requiredOption("--to <targetId>")
    .option("--id <edgeId>")
    .action(async (_, command) => {
      const globals = getGlobalOptions(command);
      outputFormat = globals.format;
      await runCommand(io, globals.format, async () => {
        const workspace = await resolveWorkspaceContext({
          cwd,
          env,
          workspaceOverride: globals.workspace
        });
        const edgeId =
          (command.opts().id as string | undefined) ?? generateId();
        const state = await addEdge(
          workspace.workspaceRoot,
          {
            caseId: command.opts().case as string,
            edge: {
              edge_id: edgeId,
              type: command.opts().type as EdgeType,
              source_id: command.opts().from as string,
              target_id: command.opts().to as string,
              metadata: {},
              extensions: {}
            }
          },
          createDefaultMutationContext()
        );
        return successResult(
          "edge add",
          { edge: state.edges.get(edgeId) ?? null },
          state.caseRecord.case_revision
        );
      });
    });

  edgeCommand
    .command("remove")
    .requiredOption("--case <caseId>")
    .requiredOption("--id <edgeId>")
    .action(async (_, command) => {
      const globals = getGlobalOptions(command);
      outputFormat = globals.format;
      await runCommand(io, globals.format, async () => {
        const workspace = await resolveWorkspaceContext({
          cwd,
          env,
          workspaceOverride: globals.workspace
        });
        const state = await removeEdge(
          workspace.workspaceRoot,
          command.opts().case as string,
          command.opts().id as string,
          createDefaultMutationContext()
        );
        return successResult("edge remove", { edge_id: command.opts().id as string }, state.caseRecord.case_revision);
      });
    });

  const taskCommand = program.command("task");
  addTaskStateCommand(taskCommand, "start", "doing", io, cwd, env);
  addTaskStateCommand(taskCommand, "done", "done", io, cwd, env);
  addTaskStateCommand(taskCommand, "resume", "todo", io, cwd, env);
  addTaskStateCommand(taskCommand, "cancel", "cancelled", io, cwd, env);
  addTaskStateCommand(taskCommand, "fail", "failed", io, cwd, env, "--reason");

  taskCommand
    .command("wait <nodeId>")
    .requiredOption("--case <caseId>")
    .option("--reason <reason>")
    .option("--for <eventId>")
    .action(async (nodeId, options, command) => {
      const globals = getGlobalOptions(command);
      outputFormat = globals.format;
      await runCommand(io, globals.format, async () => {
        const workspace = await resolveWorkspaceContext({
          cwd,
          env,
          workspaceOverride: globals.workspace
        });
        const state = await waitTask(
          workspace.workspaceRoot,
          {
            caseId: options.case as string,
            nodeId: nodeId as string,
            reason: options.reason as string | undefined,
            eventId: options.for as string | undefined
          },
          createDefaultMutationContext()
        );
        return successResult(
          "task wait",
          { node: state.nodes.get(nodeId as string) ?? null },
          state.caseRecord.case_revision
        );
      });
    });

  const decisionCommand = program.command("decision");
  decisionCommand
    .command("decide <nodeId>")
    .requiredOption("--case <caseId>")
    .option("--result <result>")
    .action(async (nodeId, options, command) => {
      const globals = getGlobalOptions(command);
      outputFormat = globals.format;
      await runCommand(io, globals.format, async () => {
        const workspace = await resolveWorkspaceContext({
          cwd,
          env,
          workspaceOverride: globals.workspace
        });
        const state = await decideNode(
          workspace.workspaceRoot,
          {
            caseId: options.case as string,
            nodeId: nodeId as string,
            result: options.result as string | undefined
          },
          createDefaultMutationContext()
        );
        return successResult(
          "decision decide",
          { node: state.nodes.get(nodeId as string) ?? null },
          state.caseRecord.case_revision
        );
      });
    });

  const eventCommand = program.command("event");
  eventCommand
    .command("record <nodeId>")
    .requiredOption("--case <caseId>")
    .action(async (nodeId, options, command) => {
      const globals = getGlobalOptions(command);
      outputFormat = globals.format;
      await runCommand(io, globals.format, async () => {
        const workspace = await resolveWorkspaceContext({
          cwd,
          env,
          workspaceOverride: globals.workspace
        });
        const state = await recordEventNode(
          workspace.workspaceRoot,
          { caseId: options.case as string, nodeId: nodeId as string },
          createDefaultMutationContext()
        );
        return successResult(
          "event record",
          { node: state.nodes.get(nodeId as string) ?? null },
          state.caseRecord.case_revision
        );
      });
    });

  const evidenceCommand = program.command("evidence");
  evidenceCommand
    .command("add")
    .requiredOption("--case <caseId>")
    .requiredOption("--title <title>")
    .option("--id <nodeId>")
    .option("--target <targetId>")
    .option("--description <description>", "Evidence description", "")
    .option("--file <path>")
    .option("--url <url>")
    .action(async (_, command) => {
      const globals = getGlobalOptions(command);
      outputFormat = globals.format;
      await runCommand(io, globals.format, async () => {
        const workspace = await resolveWorkspaceContext({
          cwd,
          env,
          workspaceOverride: globals.workspace
        });
        const nodeId = (command.opts().id as string | undefined) ?? generateId();
        const attachment = createAttachmentOptions(command.opts(), nodeId);
        const state = await addEvidence(
          workspace.workspaceRoot,
          {
            caseId: command.opts().case as string,
            evidence: {
              node_id: nodeId,
              title: command.opts().title as string,
              description: command.opts().description as string,
              state: "done",
              labels: [],
              acceptance: [],
              metadata: {},
              extensions: {}
            },
            verifiesTargetId: command.opts().target as string | undefined,
            attachment
          },
          createDefaultMutationContext()
        );
        return successResult(
          "evidence add",
          { node: state.nodes.get(nodeId) ?? null },
          state.caseRecord.case_revision
        );
      });
    });

  program
    .command("frontier")
    .requiredOption("--case <caseId>")
    .action(async (_, command) => {
      const globals = getGlobalOptions(command);
      outputFormat = globals.format;
      await runCommand(io, globals.format, async () => {
        const workspace = await resolveWorkspaceContext({
          cwd,
          env,
          workspaceOverride: globals.workspace
        });
        const data = await getFrontierItems(workspace.workspaceRoot, command.opts().case as string);
        return successResult("frontier", data, data.revision);
      });
    });

  program
    .command("blockers")
    .requiredOption("--case <caseId>")
    .action(async (_, command) => {
      const globals = getGlobalOptions(command);
      outputFormat = globals.format;
      await runCommand(io, globals.format, async () => {
        const workspace = await resolveWorkspaceContext({
          cwd,
          env,
          workspaceOverride: globals.workspace
        });
        const data = await listBlockedItems(
          workspace.workspaceRoot,
          command.opts().case as string
        );
        return successResult("blockers", data, data.revision);
      });
    });

  const validateCommand = program.command("validate");
  validateCommand
    .command("storage")
    .action(async (_, command) => {
      const globals = getGlobalOptions(command);
      outputFormat = globals.format;
      await runCommand(io, globals.format, async () => {
        const workspace = await resolveWorkspaceContext({
          cwd,
          env,
          workspaceOverride: globals.workspace
        });
        return successResult(
          "validate storage",
          await validateStorage(workspace.workspaceRoot)
        );
      });
    });

  validateCommand.option("--case <caseId>");
  validateCommand.action(async (_, command) => {
      const globals = getGlobalOptions(command);
      outputFormat = globals.format;
      await runCommand(io, globals.format, async () => {
        const workspace = await resolveWorkspaceContext({
          cwd,
          env,
          workspaceOverride: globals.workspace
        });
        const caseId = command.opts().case as string | undefined;
        if (!caseId) {
          throw new Error("--case is required for validate");
        }
        const data = await validateCase(workspace.workspaceRoot, caseId);
        return successResult("validate", data);
      });
    });

  const cacheCommand = program.command("cache");
  cacheCommand.command("rebuild").action(async (_, command) => {
    const globals = getGlobalOptions(command);
    outputFormat = globals.format;
    await runCommand(io, globals.format, async () => {
      const workspace = await resolveWorkspaceContext({
        cwd,
        env,
        workspaceOverride: globals.workspace
      });
      return successResult("cache rebuild", await rebuildCache(workspace.workspaceRoot));
    });
  });

  const eventsCommand = program.command("events");
  eventsCommand
    .command("verify")
    .requiredOption("--case <caseId>")
    .action(async (_, command) => {
      const globals = getGlobalOptions(command);
      outputFormat = globals.format;
      await runCommand(io, globals.format, async () => {
        const workspace = await resolveWorkspaceContext({
          cwd,
          env,
          workspaceOverride: globals.workspace
        });
        const data = await verifyEvents(workspace.workspaceRoot, command.opts().case as string);
        return successResult("events verify", data, data.revision);
      });
    });

  eventsCommand
    .command("export")
    .requiredOption("--case <caseId>")
    .action(async (_, command) => {
      const globals = getGlobalOptions(command);
      outputFormat = globals.format;
      await runCommand(io, globals.format, async () => {
        const workspace = await resolveWorkspaceContext({
          cwd,
          env,
          workspaceOverride: globals.workspace
        });
        return successResult("events export", {
          case_id: command.opts().case as string,
          events: await exportEvents(workspace.workspaceRoot, command.opts().case as string)
        });
      });
    });

  try {
    await program.parseAsync(argv, { from: "user" });
    return 0;
  } catch (error) {
    const normalized = normalizeUnknownError(error);
    emitResult(
      io,
      outputFormat,
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
    return normalized.exitCode;
  }
}

function addTaskStateCommand(
  taskCommand: Command,
  name: string,
  state: "doing" | "done" | "todo" | "cancelled" | "failed",
  io: CliIo,
  cwd: string,
  env: NodeJS.ProcessEnv,
  reasonFlag?: string
): void {
  const command = taskCommand.command(`${name} <nodeId>`).requiredOption("--case <caseId>");
  if (reasonFlag) {
    command.option(reasonFlag, "Reason");
  }
  command.action(async (nodeId, options, commandInstance) => {
    const globals = getGlobalOptions(commandInstance);
    await runCommand(io, globals.format, async () => {
      const workspace = await resolveWorkspaceContext({
        cwd,
        env,
        workspaceOverride: globals.workspace
      });
      const reasonOptionName = reasonFlag ? reasonFlag.replace(/^--/, "") : undefined;
      const metadata =
        reasonOptionName && options[reasonOptionName]
          ? { [`last_${name}_reason`]: options[reasonOptionName] as string }
          : undefined;
      const resultState = await changeNodeState(
        workspace.workspaceRoot,
        {
          caseId: options.case as string,
          nodeId: nodeId as string,
          state,
          metadata
        },
        createDefaultMutationContext()
      );
      return successResult(
        `task ${name}`,
        { node: resultState.nodes.get(nodeId as string) ?? null },
        resultState.caseRecord.case_revision
      );
    });
  });
}

async function runCommand<T>(
  io: CliIo,
  format: "text" | "json",
  action: () => Promise<CommandResult<T>>
): Promise<void> {
  try {
    const result = await action();
    emitResult(io, format, result, false);
  } catch (error) {
    const normalized = normalizeUnknownError(error);
    emitResult(
      io,
      format,
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

function emitResult(
  io: CliIo,
  format: "text" | "json",
  result: CommandResult<unknown>,
  isError: boolean
): void {
  const target = isError ? io.stderr : io.stdout;
  target(format === "json" ? `${JSON.stringify(result, null, 2)}\n` : `${renderText(result)}\n`);
}

function renderText(result: CommandResult<unknown>): string {
  if (!result.ok) {
    return `ERROR ${result.error.code}: ${result.error.message}`;
  }

  switch (result.command) {
    case "init":
      return `Initialized workspace ${String((result.data as any).workspace.title)}`;
    case "case list":
      return renderCaseList((result as CommandSuccess<{ cases: any[] }>).data.cases);
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
      const data = (result as CommandSuccess<any>).data;
      return data.valid ? "VALID" : `INVALID (${data.errors.length} errors)`;
    }
    case "cache rebuild":
      return `Rebuilt cache for ${(result as CommandSuccess<{ cases: number }>).data.cases} cases`;
    case "events verify": {
      const data = (result as CommandSuccess<any>).data;
      return `Verified ${data.event_count} events for ${data.case_id}`;
    }
    case "events export":
      return JSON.stringify((result as CommandSuccess<any>).data.events, null, 2);
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
      (item) =>
        `${item.node.node_id}\t${item.reasons.map((reason) => reason.message).join("; ")}`
    )
    .join("\n");
}

function parseCsv(value: string | undefined): string[] {
  if (!value) {
    return [];
  }

  return value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function parseJsonObject(value: string | undefined): Record<string, unknown> {
  if (!value) {
    return {};
  }

  return JSON.parse(value) as Record<string, unknown>;
}

function getGlobalOptions(command: Command): GlobalOptions {
  const options: Record<string, unknown> = {};
  let current: unknown = command;
  while (
    current &&
    typeof current === "object" &&
    "opts" in current &&
    typeof (current as Command).opts === "function"
  ) {
    const currentCommand = current as Command;
    Object.assign(options, currentCommand.opts());
    current = currentCommand.parent;
  }
  return {
    workspace: options.workspace as string | undefined,
    format: (options.format as "text" | "json" | undefined) ?? "text",
    quiet: options.quiet as boolean | undefined,
    verbose: options.verbose as boolean | undefined
  };
}

function createAttachmentOptions(options: Record<string, unknown>, nodeId: string) {
  if (typeof options.file === "string") {
    return {
      attachment_id: generateId(),
      evidence_node_id: nodeId,
      storage_mode: "workspace_copy" as const,
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
      storage_mode: "url" as const,
      path_or_url: options.url,
      sha256: null,
      mime_type: null,
      size_bytes: null
    };
  }

  return undefined;
}
