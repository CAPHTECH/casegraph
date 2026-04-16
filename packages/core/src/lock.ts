import { type FileHandle, open, unlink } from "node:fs/promises";

import { CaseGraphError } from "./errors.js";

export async function withWorkspaceLock<T>(
  lockFile: string,
  callback: () => Promise<T>
): Promise<T> {
  let handle: FileHandle;

  try {
    handle = await open(lockFile, "wx");
  } catch (error) {
    throw new CaseGraphError("workspace_locked", "Workspace is locked by another operation", {
      exitCode: 4,
      details: error
    });
  }

  try {
    return await callback();
  } finally {
    await handle.close();
    await unlink(lockFile).catch(() => undefined);
  }
}
