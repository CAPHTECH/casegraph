import { createHash } from "node:crypto";
import { copyFile, readFile, stat } from "node:fs/promises";
import path from "node:path";

import type { AttachmentRecord } from "@caphtech/casegraph-kernel";

export async function copyAttachmentIntoWorkspace(
  sourcePath: string,
  destinationDir: string,
  fileNamePrefix: string
): Promise<Pick<AttachmentRecord, "path_or_url" | "sha256" | "size_bytes">> {
  const sourceBuffer = await readFile(sourcePath);
  const sha256 = createHash("sha256").update(sourceBuffer).digest("hex");
  const fileName = `${fileNamePrefix}${path.extname(sourcePath)}`;
  const destinationPath = path.join(destinationDir, fileName);

  await copyFile(sourcePath, destinationPath);

  const sourceStat = await stat(sourcePath);

  return {
    path_or_url: destinationPath,
    sha256,
    size_bytes: sourceStat.size
  };
}
