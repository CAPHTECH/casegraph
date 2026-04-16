import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  CaseGraphError,
  createJsonRpcStdioClient,
  loadCaseState,
  loadConfigRecord,
  validatePatchDocument
} from "@casegraph/core";
import type { ImporterIngestResult } from "@casegraph/core";

export async function ingestMarkdownPatch(options: {
  workspaceRoot: string;
  caseId: string;
  inputFile: string;
  env: NodeJS.ProcessEnv;
}): Promise<ImporterIngestResult> {
  const config = await loadConfigRecord(options.workspaceRoot);
  const importerConfig = config.importers?.markdown;
  const command =
    importerConfig?.command && importerConfig.command.length > 0
      ? importerConfig.command
      : [
          process.execPath,
          "--experimental-strip-types",
          fileURLToPath(new URL("../../importer-markdown/src/index.ts", import.meta.url))
        ];

  const env = buildPluginEnv(options.env, importerConfig?.env_allowlist ?? []);
  const client = await createJsonRpcStdioClient({
    command,
    cwd: options.workspaceRoot,
    env,
    peerName: "importer"
  });
  const state = await loadCaseState(options.workspaceRoot, options.caseId);

  try {
    await client.request("initialize", {
      client: { name: "cg", version: "0.1.0" }
    });
    const capabilities = await client.request<{ methods?: string[] }>("capabilities.list");
    if (!Array.isArray(capabilities.methods) || !capabilities.methods.includes("importer.ingest")) {
      throw new CaseGraphError(
        "importer_capability_missing",
        "Importer does not advertise importer.ingest",
        { exitCode: 2, details: capabilities }
      );
    }

    const result = await client.request<ImporterIngestResult>("importer.ingest", {
      case_id: options.caseId,
      base_revision: state.caseRecord.case_revision.current,
      input: {
        kind: "file",
        path: options.inputFile
      },
      options: {
        mode: "append"
      }
    });

    const validation = validatePatchDocument(result.patch);
    if (!validation.valid || !validation.patch) {
      throw new CaseGraphError("importer_patch_invalid", "Importer returned invalid patch", {
        exitCode: 2,
        details: validation
      });
    }

    return {
      patch: validation.patch,
      warnings: Array.isArray(result.warnings) ? [...result.warnings] : []
    };
  } finally {
    await client.request("shutdown").catch(() => undefined);
    await client.close();
  }
}

function buildPluginEnv(
  sourceEnv: NodeJS.ProcessEnv,
  allowlist: string[]
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};

  for (const key of ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "TMP", "TEMP"]) {
    if (sourceEnv[key] !== undefined) {
      env[key] = sourceEnv[key];
    }
  }

  for (const key of allowlist) {
    if (sourceEnv[key] !== undefined) {
      env[key] = sourceEnv[key];
    }
  }

  return env;
}
