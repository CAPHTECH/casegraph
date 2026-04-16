import path from "node:path";
import { Command } from "commander";

import {
  addEdge,
  addEvidence,
  addNode,
  changeNodeState,
  createCase,
  exportEvents,
  generateId,
  getFrontierItems,
  initWorkspace,
  listBlockedItems,
  listCases,
  recordEventNode,
  rebuildCache,
  removeEdge,
  showCase,
  updateNode,
  validateCase,
  validateStorage,
  verifyEvents,
  waitTask,
  decideNode
} from "@casegraph/core";
import type {
  EdgeType,
  NodeKind,
  NodeState,
} from "@casegraph/core";
import { successResult } from "./result.js";
import {
  type CliRuntime,
  type CliRuntimeOptions,
  createAttachmentOptions,
  createCliRuntime,
  emitFatalCliError,
  parseCsv,
  parseJsonObject,
  runCliAction,
  runMutationCommand,
  runWorkspaceCommand
} from "./runtime.js";

export async function runCli(
  argv: string[],
  runtimeOptions: CliRuntimeOptions = {}
): Promise<number> {
  const runtime = createCliRuntime(argv, runtimeOptions);

  const program = new Command();
  program
    .name("cg")
    .description("CaseGraph CLI")
    .option("--workspace <path>")
    .option("--format <format>", "text or json", "text")
    .option("--quiet")
    .option("--verbose")
    .showHelpAfterError(runtime.format === "text");

  program.configureOutput({
    writeOut: (text) => runtime.io.stdout(text),
    writeErr: (text) => {
      if (runtime.format === "text") {
        runtime.io.stderr(text);
      }
    }
  });

  program.exitOverride();

  program
    .command("init")
    .option("--title <title>")
    .action(async (_, command) => {
      const options = command.opts() as { title?: string };
      await runCliAction(runtime, command, async (globals) =>
        successResult("init", {
          workspace: await initWorkspace({
            workspaceRoot: globals.workspace
              ? path.resolve(runtime.cwd, globals.workspace)
              : runtime.cwd,
            title: options.title
          })
        })
      );
    });

  const caseCommand = program.command("case");
  caseCommand
    .command("new")
    .requiredOption("--id <caseId>")
    .requiredOption("--title <title>")
    .option("--description <description>", "Case description", "")
    .action(async (_, command) => {
      const options = command.opts() as {
        id: string;
        title: string;
        description: string;
      };
      await runMutationCommand(runtime, command, async (workspaceRoot, _, mutationContext) => {
        const state = await createCase(
          workspaceRoot,
          {
            case_id: options.id,
            title: options.title,
            description: options.description
          },
          mutationContext
        );
        return successResult(
          "case new",
          { case: state.caseRecord },
          state.caseRecord.case_revision
        );
      });
    });

  caseCommand.command("list").action(async (_, command) => {
    await runWorkspaceCommand(runtime, command, async (workspaceRoot) =>
      successResult("case list", { cases: await listCases(workspaceRoot) })
    );
  });

  caseCommand
    .command("show")
    .requiredOption("--case <caseId>")
    .action(async (_, command) => {
      const options = command.opts() as { case: string };
      await runWorkspaceCommand(runtime, command, async (workspaceRoot) => {
        const data = await showCase(workspaceRoot, options.case);
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
      const options = command.opts() as {
        case: string;
        kind: NodeKind;
        title: string;
        id?: string;
        description: string;
        state: NodeState;
        labels?: string;
        acceptance?: string;
        metadata?: string;
      };
      await runMutationCommand(runtime, command, async (workspaceRoot, _, mutationContext) => {
        const nodeId = options.id ?? generateId();
        const state = await addNode(
          workspaceRoot,
          {
            caseId: options.case,
            node: {
              node_id: nodeId,
              kind: options.kind,
              title: options.title,
              description: options.description,
              state: options.state,
              labels: parseCsv(options.labels),
              acceptance: parseCsv(options.acceptance),
              metadata: parseJsonObject(options.metadata),
              extensions: {}
            }
          },
          mutationContext
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
      const options = command.opts() as {
        case: string;
        id: string;
        title?: string;
        description?: string;
        labels?: string;
        acceptance?: string;
        metadata?: string;
      };
      await runMutationCommand(runtime, command, async (workspaceRoot, _, mutationContext) => {
        const state = await updateNode(
          workspaceRoot,
          {
            caseId: options.case,
            nodeId: options.id,
            changes: {
              title: options.title,
              description: options.description,
              labels: options.labels ? parseCsv(options.labels) : undefined,
              acceptance: options.acceptance ? parseCsv(options.acceptance) : undefined,
              metadata: options.metadata ? parseJsonObject(options.metadata) : undefined
            }
          },
          mutationContext
        );
        return successResult(
          "node update",
          { node: state.nodes.get(options.id) ?? null },
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
      const options = command.opts() as {
        case: string;
        type: EdgeType;
        from: string;
        to: string;
        id?: string;
      };
      await runMutationCommand(runtime, command, async (workspaceRoot, _, mutationContext) => {
        const edgeId = options.id ?? generateId();
        const state = await addEdge(
          workspaceRoot,
          {
            caseId: options.case,
            edge: {
              edge_id: edgeId,
              type: options.type,
              source_id: options.from,
              target_id: options.to,
              metadata: {},
              extensions: {}
            }
          },
          mutationContext
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
      const options = command.opts() as { case: string; id: string };
      await runMutationCommand(runtime, command, async (workspaceRoot, _, mutationContext) => {
        const state = await removeEdge(
          workspaceRoot,
          options.case,
          options.id,
          mutationContext
        );
        return successResult(
          "edge remove",
          { edge_id: options.id },
          state.caseRecord.case_revision
        );
      });
    });

  const taskCommand = program.command("task");
  addTaskStateCommand(taskCommand, "start", "doing", runtime);
  addTaskStateCommand(taskCommand, "done", "done", runtime);
  addTaskStateCommand(taskCommand, "resume", "todo", runtime);
  addTaskStateCommand(taskCommand, "cancel", "cancelled", runtime);
  addTaskStateCommand(taskCommand, "fail", "failed", runtime, "--reason");

  taskCommand
    .command("wait <nodeId>")
    .requiredOption("--case <caseId>")
    .option("--reason <reason>")
    .option("--for <eventId>")
    .action(async (nodeId, options, command) => {
      await runMutationCommand(runtime, command, async (workspaceRoot, _, mutationContext) => {
        const state = await waitTask(
          workspaceRoot,
          {
            caseId: options.case as string,
            nodeId: nodeId as string,
            reason: options.reason as string | undefined,
            eventId: options.for as string | undefined
          },
          mutationContext
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
      await runMutationCommand(runtime, command, async (workspaceRoot, _, mutationContext) => {
        const state = await decideNode(
          workspaceRoot,
          {
            caseId: options.case as string,
            nodeId: nodeId as string,
            result: options.result as string | undefined
          },
          mutationContext
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
      await runMutationCommand(runtime, command, async (workspaceRoot, _, mutationContext) => {
        const state = await recordEventNode(
          workspaceRoot,
          { caseId: options.case as string, nodeId: nodeId as string },
          mutationContext
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
      const options = command.opts() as {
        case: string;
        title: string;
        id?: string;
        target?: string;
        description: string;
        file?: string;
        url?: string;
      };
      await runMutationCommand(runtime, command, async (workspaceRoot, _, mutationContext) => {
        const nodeId = options.id ?? generateId();
        const attachment = createAttachmentOptions(options, nodeId);
        const state = await addEvidence(
          workspaceRoot,
          {
            caseId: options.case,
            evidence: {
              node_id: nodeId,
              title: options.title,
              description: options.description,
              state: "done",
              labels: [],
              acceptance: [],
              metadata: {},
              extensions: {}
            },
            verifiesTargetId: options.target,
            attachment
          },
          mutationContext
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
      const options = command.opts() as { case: string };
      await runWorkspaceCommand(runtime, command, async (workspaceRoot) => {
        const data = await getFrontierItems(workspaceRoot, options.case);
        return successResult("frontier", data, data.revision);
      });
    });

  program
    .command("blockers")
    .requiredOption("--case <caseId>")
    .action(async (_, command) => {
      const options = command.opts() as { case: string };
      await runWorkspaceCommand(runtime, command, async (workspaceRoot) => {
        const data = await listBlockedItems(workspaceRoot, options.case);
        return successResult("blockers", data, data.revision);
      });
    });

  const validateCommand = program.command("validate");
  validateCommand
    .command("storage")
    .action(async (_, command) => {
      await runWorkspaceCommand(runtime, command, async (workspaceRoot) =>
        successResult("validate storage", await validateStorage(workspaceRoot))
      );
    });

  validateCommand.option("--case <caseId>");
  validateCommand.action(async (_, command) => {
    const options = command.opts() as { case?: string };
    await runWorkspaceCommand(runtime, command, async (workspaceRoot) => {
      const caseId = options.case;
      if (!caseId) {
        throw new Error("--case is required for validate");
      }
      const data = await validateCase(workspaceRoot, caseId);
      return successResult("validate", data);
    });
  });

  const cacheCommand = program.command("cache");
  cacheCommand.command("rebuild").action(async (_, command) => {
    await runWorkspaceCommand(runtime, command, async (workspaceRoot) =>
      successResult("cache rebuild", await rebuildCache(workspaceRoot))
    );
  });

  const eventsCommand = program.command("events");
  eventsCommand
    .command("verify")
    .requiredOption("--case <caseId>")
    .action(async (_, command) => {
      const options = command.opts() as { case: string };
      await runWorkspaceCommand(runtime, command, async (workspaceRoot) => {
        const data = await verifyEvents(workspaceRoot, options.case);
        return successResult("events verify", data, data.revision);
      });
    });

  eventsCommand
    .command("export")
    .requiredOption("--case <caseId>")
    .action(async (_, command) => {
      const options = command.opts() as { case: string };
      await runWorkspaceCommand(runtime, command, async (workspaceRoot) => {
        return successResult("events export", {
          case_id: options.case,
          events: await exportEvents(workspaceRoot, options.case)
        });
      });
    });

  try {
    await program.parseAsync(argv, { from: "user" });
    return 0;
  } catch (error) {
    return emitFatalCliError(runtime, error);
  }
}

function addTaskStateCommand(
  taskCommand: Command,
  name: string,
  state: "doing" | "done" | "todo" | "cancelled" | "failed",
  runtime: CliRuntime,
  reasonFlag?: string
): void {
  const command = taskCommand.command(`${name} <nodeId>`).requiredOption("--case <caseId>");
  if (reasonFlag) {
    command.option(reasonFlag, "Reason");
  }
  command.action(async (nodeId, options, commandInstance) => {
    await runMutationCommand(runtime, commandInstance, async (workspaceRoot, _, mutationContext) => {
      const reasonOptionName = reasonFlag ? reasonFlag.replace(/^--/, "") : undefined;
      const metadata =
        reasonOptionName && options[reasonOptionName]
          ? { [`last_${name}_reason`]: options[reasonOptionName] as string }
          : undefined;
      const resultState = await changeNodeState(
        workspaceRoot,
        {
          caseId: options.case as string,
          nodeId: nodeId as string,
          state,
          metadata
        },
        mutationContext
      );
      return successResult(
        `task ${name}`,
        { node: resultState.nodes.get(nodeId as string) ?? null },
        resultState.caseRecord.case_revision
      );
    });
  });
}
