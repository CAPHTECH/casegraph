import { access } from "node:fs/promises";
import path from "node:path";

import {
  CACHE_FILENAME,
  CASE_FILENAME,
  CaseGraphError,
  CONFIG_FILENAME,
  EVENTS_FILENAME,
  LOCK_FILENAME,
  WORKSPACE_DIRNAME,
  WORKSPACE_FILENAME
} from "@caphtech/casegraph-kernel";

export interface WorkspacePaths {
  workspaceRoot: string;
  workspaceDir: string;
  workspaceFile: string;
  configFile: string;
  casesDir: string;
  cacheDir: string;
  cacheFile: string;
  lockFile: string;
}

export interface CasePaths {
  caseDir: string;
  caseFile: string;
  eventsFile: string;
  attachmentsDir: string;
  projectionsDir: string;
}

export function getWorkspacePaths(workspaceRoot: string): WorkspacePaths {
  const workspaceDir = path.join(workspaceRoot, WORKSPACE_DIRNAME);

  return {
    workspaceRoot,
    workspaceDir,
    workspaceFile: path.join(workspaceDir, WORKSPACE_FILENAME),
    configFile: path.join(workspaceDir, CONFIG_FILENAME),
    casesDir: path.join(workspaceDir, "cases"),
    cacheDir: path.join(workspaceDir, "cache"),
    cacheFile: path.join(workspaceDir, "cache", CACHE_FILENAME),
    lockFile: path.join(workspaceDir, LOCK_FILENAME)
  };
}

export function getCasePaths(workspaceRoot: string, caseId: string): CasePaths {
  const workspacePaths = getWorkspacePaths(workspaceRoot);
  const caseDir = path.join(workspacePaths.casesDir, caseId);

  return {
    caseDir,
    caseFile: path.join(caseDir, CASE_FILENAME),
    eventsFile: path.join(caseDir, EVENTS_FILENAME),
    attachmentsDir: path.join(caseDir, "attachments"),
    projectionsDir: path.join(caseDir, "projections")
  };
}

export async function resolveWorkspaceRoot(
  cwd: string,
  workspaceOverride?: string,
  env?: NodeJS.ProcessEnv
): Promise<string> {
  if (workspaceOverride) {
    return path.resolve(cwd, workspaceOverride);
  }

  const envWorkspace = env?.CASEGRAPH_WORKSPACE;
  if (envWorkspace) {
    return path.resolve(cwd, envWorkspace);
  }

  let currentDir = cwd;
  while (true) {
    const candidate = path.join(currentDir, WORKSPACE_DIRNAME);

    try {
      await access(candidate);
      return currentDir;
    } catch {
      const parentDir = path.dirname(currentDir);
      if (parentDir === currentDir) {
        throw new CaseGraphError("workspace_not_found", "Could not find .casegraph workspace", {
          exitCode: 3
        });
      }
      currentDir = parentDir;
    }
  }
}
