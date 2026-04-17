import path from "node:path";
import type {
  EdgeType,
  GraphPatch,
  MutationContext,
  NodeKind,
  NodeState
} from "@caphtech/casegraph-core";

import {
  addEdge,
  addEvidence,
  addNode,
  analyzeBottlenecksForCase,
  analyzeBridgesForCase,
  analyzeComponentsForCase,
  analyzeCriticalPathForCase,
  analyzeCutpointsForCase,
  analyzeCyclesForCase,
  analyzeFragilityForCase,
  analyzeImpactForCase,
  analyzeMinimalUnblockSetForCase,
  analyzeSlackForCase,
  applyPatch,
  CaseGraphError,
  changeNodeState,
  checkWorkspaceMigrations,
  createCase,
  decideNode,
  exportEvents,
  generateId,
  getFrontierItems,
  initWorkspace,
  listBlockedItems,
  listCases,
  loadCaseState,
  rebuildCache,
  recordEventNode,
  removeEdge,
  reviewPatch,
  runWorkspaceMigrations,
  showCase,
  updateNode,
  validateCase,
  validateStorage,
  verifyEvents,
  waitTask
} from "@caphtech/casegraph-core";
import { Command } from "commander";
import { buildCaseViewData } from "./case-view.js";
import { ingestMarkdownPatch } from "./importer-host.js";
import { loadPatchValidation, loadValidPatch, writeStructuredFile } from "./patch-file.js";
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
import { runSinkPull, runSinkPush } from "./sink-host.js";
import { runWorkerExecute, type WorkerRunResult } from "./worker-host.js";

interface WorkerRunCommandOptions {
  worker: string;
  case: string;
  node: string;
  approve?: boolean;
  output?: string;
  timeout?: string;
}

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

  caseCommand
    .command("view")
    .requiredOption("--case <caseId>")
    .action(async (_, command) => {
      const options = command.opts() as { case: string };
      await runWorkspaceCommand(runtime, command, async (workspaceRoot) => {
        const state = await loadCaseState(workspaceRoot, options.case);
        const data = buildCaseViewData(state);
        return successResult("case view", data, data.revision);
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
        const state = await removeEdge(workspaceRoot, options.case, options.id, mutationContext);
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

  const analyzeCommand = program.command("analyze");
  analyzeCommand
    .command("impact")
    .requiredOption("--case <caseId>")
    .requiredOption("--node <nodeId>")
    .action(async (_, command) => {
      const options = command.opts() as { case: string; node: string };
      await runWorkspaceCommand(runtime, command, async (workspaceRoot) => {
        const data = await analyzeImpactForCase(workspaceRoot, options.case, options.node);
        return successResult("analyze impact", data, data.revision);
      });
    });

  analyzeCommand
    .command("critical-path")
    .requiredOption("--case <caseId>")
    .option("--goal <goalNodeId>")
    .action(async (_, command) => {
      const options = command.opts() as { case: string; goal?: string };
      await runWorkspaceCommand(runtime, command, async (workspaceRoot) => {
        const data = await analyzeCriticalPathForCase(workspaceRoot, options.case, options.goal);
        return successResult("analyze critical-path", data, data.revision);
      });
    });

  analyzeCommand
    .command("slack")
    .requiredOption("--case <caseId>")
    .option("--goal <goalNodeId>")
    .action(async (_, command) => {
      const options = command.opts() as { case: string; goal?: string };
      await runWorkspaceCommand(runtime, command, async (workspaceRoot) => {
        const data = await analyzeSlackForCase(workspaceRoot, options.case, options.goal);
        return successResult("analyze slack", data, data.revision);
      });
    });

  analyzeCommand
    .command("bottlenecks")
    .requiredOption("--case <caseId>")
    .option("--goal <goalNodeId>")
    .action(async (_, command) => {
      const options = command.opts() as { case: string; goal?: string };
      await runWorkspaceCommand(runtime, command, async (workspaceRoot) => {
        const data = await analyzeBottlenecksForCase(workspaceRoot, options.case, options.goal);
        return successResult("analyze bottlenecks", data, data.revision);
      });
    });

  analyzeCommand
    .command("unblock")
    .requiredOption("--case <caseId>")
    .requiredOption("--node <nodeId>")
    .action(async (_, command) => {
      const options = command.opts() as { case: string; node: string };
      await runWorkspaceCommand(runtime, command, async (workspaceRoot) => {
        const data = await analyzeMinimalUnblockSetForCase(
          workspaceRoot,
          options.case,
          options.node
        );
        return successResult("analyze unblock", data, data.revision);
      });
    });

  analyzeCommand
    .command("cycles")
    .requiredOption("--case <caseId>")
    .option("--goal <goalNodeId>")
    .action(async (_, command) => {
      const options = command.opts() as { case: string; goal?: string };
      await runWorkspaceCommand(runtime, command, async (workspaceRoot) => {
        const data = await analyzeCyclesForCase(workspaceRoot, options.case, {
          goalNodeId: options.goal
        });
        return successResult("analyze cycles", data, data.revision);
      });
    });

  analyzeCommand
    .command("components")
    .requiredOption("--case <caseId>")
    .option("--goal <goalNodeId>")
    .action(async (_, command) => {
      const options = command.opts() as { case: string; goal?: string };
      await runWorkspaceCommand(runtime, command, async (workspaceRoot) => {
        const data = await analyzeComponentsForCase(workspaceRoot, options.case, {
          goalNodeId: options.goal
        });
        return successResult("analyze components", data, data.revision);
      });
    });

  analyzeCommand
    .command("bridges")
    .requiredOption("--case <caseId>")
    .option("--goal <goalNodeId>")
    .action(async (_, command) => {
      const options = command.opts() as { case: string; goal?: string };
      await runWorkspaceCommand(runtime, command, async (workspaceRoot) => {
        const data = await analyzeBridgesForCase(workspaceRoot, options.case, {
          goalNodeId: options.goal
        });
        return successResult("analyze bridges", data, data.revision);
      });
    });

  analyzeCommand
    .command("cutpoints")
    .requiredOption("--case <caseId>")
    .option("--goal <goalNodeId>")
    .action(async (_, command) => {
      const options = command.opts() as { case: string; goal?: string };
      await runWorkspaceCommand(runtime, command, async (workspaceRoot) => {
        const data = await analyzeCutpointsForCase(workspaceRoot, options.case, {
          goalNodeId: options.goal
        });
        return successResult("analyze cutpoints", data, data.revision);
      });
    });

  analyzeCommand
    .command("fragility")
    .requiredOption("--case <caseId>")
    .option("--goal <goalNodeId>")
    .action(async (_, command) => {
      const options = command.opts() as { case: string; goal?: string };
      await runWorkspaceCommand(runtime, command, async (workspaceRoot) => {
        const data = await analyzeFragilityForCase(workspaceRoot, options.case, {
          goalNodeId: options.goal
        });
        return successResult("analyze fragility", data, data.revision);
      });
    });

  const validateCommand = program.command("validate");
  validateCommand.command("storage").action(async (_, command) => {
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
        throw new CaseGraphError("missing_case", "--case is required for validate", {
          exitCode: 2
        });
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

  const migrateCommand = program.command("migrate");
  migrateCommand
    .command("check")
    .option("--patch-file <path>", "Explicit patch file to scan", collectRepeatedOption, [])
    .action(async (_, command) => {
      const options = command.opts() as { patchFile?: string[] };
      await runWorkspaceCommand(runtime, command, async (workspaceRoot) =>
        successResult(
          "migrate check",
          await checkWorkspaceMigrations(workspaceRoot, {
            patchFiles: resolveOptionalPaths(runtime.cwd, options.patchFile)
          })
        )
      );
    });

  migrateCommand
    .command("run")
    .option("--dry-run")
    .option("--patch-file <path>", "Explicit patch file to migrate", collectRepeatedOption, [])
    .action(async (_, command) => {
      const options = command.opts() as { dryRun?: boolean; patchFile?: string[] };
      await runWorkspaceCommand(runtime, command, async (workspaceRoot) =>
        successResult(
          "migrate run",
          await runWorkspaceMigrations(workspaceRoot, {
            dryRun: options.dryRun === true,
            patchFiles: resolveOptionalPaths(runtime.cwd, options.patchFile)
          })
        )
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

  const patchCommand = program.command("patch");
  patchCommand
    .command("validate")
    .requiredOption("--file <path>")
    .action(async (_, command) => {
      const options = command.opts() as { file: string };
      await runCliAction(runtime, command, async () => {
        const data = await loadPatchValidation(path.resolve(runtime.cwd, options.file));
        return successResult("patch validate", data);
      });
    });

  patchCommand
    .command("review")
    .requiredOption("--file <path>")
    .action(async (_, command) => {
      const options = command.opts() as { file: string };
      await runWorkspaceCommand(runtime, command, async (workspaceRoot) => {
        const patch = await loadValidPatch(path.resolve(runtime.cwd, options.file));
        return successResult("patch review", await reviewPatch(workspaceRoot, patch));
      });
    });

  patchCommand
    .command("apply")
    .requiredOption("--file <path>")
    .action(async (_, command) => {
      const options = command.opts() as { file: string };
      await runMutationCommand(runtime, command, async (workspaceRoot, _, mutationContext) => {
        const patch = await loadValidPatch(path.resolve(runtime.cwd, options.file));
        const state = await applyPatch(workspaceRoot, patch, mutationContext);
        return successResult(
          "patch apply",
          {
            patch_id: patch.patch_id,
            case_id: patch.case_id,
            summary: patch.summary,
            op_count: patch.operations.length
          },
          state.caseRecord.case_revision
        );
      });
    });

  const importCommand = program.command("import");
  importCommand
    .command("markdown")
    .requiredOption("--case <caseId>")
    .requiredOption("--file <path>")
    .option("--output <path>")
    .action(async (_, command) => {
      const options = command.opts() as {
        case: string;
        file: string;
        output?: string;
      };
      await runWorkspaceCommand(runtime, command, async (workspaceRoot) => {
        const result = await ingestMarkdownPatch({
          workspaceRoot,
          caseId: options.case,
          inputFile: path.resolve(runtime.cwd, options.file),
          env: runtime.env
        });

        const outputPath = options.output ? path.resolve(runtime.cwd, options.output) : undefined;
        if (outputPath) {
          await writeStructuredFile(outputPath, result.patch);
        }

        return successResult("import markdown", {
          patch: result.patch,
          warnings: result.warnings,
          output_file: outputPath
        });
      });
    });

  const syncCommand = program.command("sync");
  syncCommand
    .command("push")
    .requiredOption("--sink <name>")
    .requiredOption("--case <caseId>")
    .option("--apply")
    .action(async (_, command) => {
      const options = command.opts() as {
        sink: string;
        case: string;
        apply?: boolean;
      };
      await runMutationCommand(
        runtime,
        command,
        async (workspaceRoot, _globals, mutationContext) => {
          const result = await runSinkPush({
            workspaceRoot,
            caseId: options.case,
            sinkName: options.sink,
            env: runtime.env,
            apply: options.apply === true,
            mutationContext
          });
          return successResult("sync push", result, result.revision ?? undefined);
        }
      );
    });

  syncCommand
    .command("pull")
    .requiredOption("--sink <name>")
    .requiredOption("--case <caseId>")
    .requiredOption("--output <path>")
    .action(async (_, command) => {
      const options = command.opts() as {
        sink: string;
        case: string;
        output: string;
      };
      await runMutationCommand(
        runtime,
        command,
        async (workspaceRoot, _globals, mutationContext) => {
          const result = await runSinkPull({
            workspaceRoot,
            caseId: options.case,
            sinkName: options.sink,
            env: runtime.env,
            mutationContext
          });

          const outputPath = path.resolve(runtime.cwd, options.output);
          if (result.patch) {
            await writeStructuredFile(outputPath, result.patch);
          }

          return successResult(
            "sync pull",
            {
              sink_name: result.sink_name,
              patch: result.patch,
              item_count: result.item_count,
              warnings: result.warnings,
              output_file: result.patch ? outputPath : null
            },
            result.revision
          );
        }
      );
    });

  const workerCommand = program.command("worker");
  workerCommand
    .command("run")
    .requiredOption("--worker <name>")
    .requiredOption("--case <caseId>")
    .requiredOption("--node <nodeId>")
    .option("--approve")
    .option("--output <path>")
    .option("--timeout <seconds>", "worker execution timeout in seconds")
    .action(async (_, command) => {
      await runWorkerRunCommand(runtime, command);
    });

  try {
    await program.parseAsync(argv, { from: "user" });
    return 0;
  } catch (error) {
    if (isCommanderDisplayExit(error)) {
      return 0;
    }

    return emitFatalCliError(runtime, error);
  }
}

function isCommanderDisplayExit(
  error: unknown
): error is { code: string; exitCode: number; message: string } {
  if (!error || typeof error !== "object") {
    return false;
  }

  const maybeCommanderError = error as {
    code?: unknown;
    exitCode?: unknown;
  };

  return (
    maybeCommanderError.exitCode === 0 &&
    (maybeCommanderError.code === "commander.helpDisplayed" ||
      maybeCommanderError.code === "commander.version")
  );
}

function addTaskStateCommand(
  taskCommand: Command,
  name: string,
  state: "doing" | "done" | "todo" | "cancelled" | "failed",
  runtime: CliRuntime,
  reasonFlag?: string
): void {
  const command = taskCommand.command(`${name} <nodeIds...>`).requiredOption("--case <caseId>");
  if (reasonFlag) {
    command.option(reasonFlag, "Reason");
  }
  command.action(async (nodeIds: string[], options, commandInstance) => {
    await runMutationCommand(
      runtime,
      commandInstance,
      async (workspaceRoot, _, mutationContext) => {
        const reasonOptionName = reasonFlag ? reasonFlag.replace(/^--/, "") : undefined;
        const metadata =
          reasonOptionName && options[reasonOptionName]
            ? { [`last_${name}_reason`]: options[reasonOptionName] as string }
            : undefined;
        let resultState = await changeNodeState(
          workspaceRoot,
          {
            caseId: options.case as string,
            nodeId: nodeIds[0] as string,
            state,
            metadata
          },
          mutationContext
        );
        for (let index = 1; index < nodeIds.length; index += 1) {
          resultState = await changeNodeState(
            workspaceRoot,
            {
              caseId: options.case as string,
              nodeId: nodeIds[index] as string,
              state,
              metadata
            },
            mutationContext
          );
        }
        const updated = nodeIds.map((id) => resultState.nodes.get(id) ?? null);
        return successResult(
          `task ${name}`,
          nodeIds.length === 1 ? { node: updated[0] } : { nodes: updated, count: nodeIds.length },
          resultState.caseRecord.case_revision
        );
      }
    );
  });
}

async function runWorkerRunCommand(runtime: CliRuntime, command: Command): Promise<void> {
  const options = command.opts() as WorkerRunCommandOptions;
  await runMutationCommand(runtime, command, async (workspaceRoot, _globals, mutationContext) =>
    executeWorkerRunMutation(runtime, workspaceRoot, mutationContext, options)
  );
}

async function executeWorkerRunMutation(
  runtime: CliRuntime,
  workspaceRoot: string,
  mutationContext: MutationContext,
  options: WorkerRunCommandOptions
) {
  const result = await runWorkerExecute({
    workspaceRoot,
    caseId: options.case,
    nodeId: options.node,
    workerName: options.worker,
    env: runtime.env,
    approve: options.approve === true,
    mutationContext,
    timeoutSeconds: parseWorkerTimeoutSeconds(options.timeout)
  });

  const outputFile = await writeWorkerRunPatchOutput(runtime.cwd, options.output, result.patch);
  return successResult("worker run", buildWorkerRunPayload(result, outputFile), result.revision);
}

function parseWorkerTimeoutSeconds(timeout?: string): number | undefined {
  if (typeof timeout !== "string") {
    return undefined;
  }

  const parsed = Number.parseInt(timeout, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return undefined;
  }

  return parsed;
}

function collectRepeatedOption(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function resolveOptionalPaths(cwd: string, values: string[] | undefined): string[] | undefined {
  if (!(values && values.length > 0)) {
    return undefined;
  }

  return values.map((value) => path.resolve(cwd, value));
}

async function writeWorkerRunPatchOutput(
  cwd: string,
  output: string | undefined,
  patch: GraphPatch | null
): Promise<string | null> {
  if (!(output && patch)) {
    return null;
  }

  const outputPath = path.resolve(cwd, output);
  await writeStructuredFile(outputPath, patch);
  return outputPath;
}

function buildWorkerRunPayload(result: WorkerRunResult, outputFile: string | null) {
  return {
    worker_name: result.worker_name,
    node_id: result.node_id,
    status: result.status,
    summary: result.summary,
    artifacts: result.artifacts,
    observations: result.observations,
    warnings: result.warnings,
    exit_code: result.exit_code,
    approval: result.approval,
    patch: result.patch,
    output_file: outputFile
  };
}
