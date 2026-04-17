import {
  CaseGraphError,
  type ImporterIngestResult,
  loadCaseState,
  loadConfigRecord,
  validatePatchDocument
} from "@casegraph/core";
import { builtInPluginCommand, closePluginClient, openPluginClient } from "./plugin-client.js";

export async function ingestMarkdownPatch(options: {
  workspaceRoot: string;
  caseId: string;
  inputFile: string;
  env: NodeJS.ProcessEnv;
}): Promise<ImporterIngestResult> {
  const config = await loadConfigRecord(options.workspaceRoot);
  const client = await openPluginClient({
    workspaceRoot: options.workspaceRoot,
    env: options.env,
    config: config.importers?.markdown,
    defaultCommand: builtInPluginCommand(
      new URL("../../importer-markdown/src/index.ts", import.meta.url)
    ),
    peerName: "importer",
    requiredMethod: "importer.ingest",
    capabilityErrorCode: "importer_capability_missing"
  });

  const state = await loadCaseState(options.workspaceRoot, options.caseId);

  try {
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
    if (!(validation.valid && validation.patch)) {
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
    await closePluginClient(client);
  }
}
