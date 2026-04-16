import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { GraphPatch, PatchValidationData } from "@casegraph/core";
import { CaseGraphError, parseYaml, stringifyYaml, validatePatchDocument } from "@casegraph/core";

export async function readPatchDocument(filePath: string): Promise<unknown> {
  const absolutePath = path.resolve(filePath);
  const contents = await readFile(absolutePath, "utf8").catch((error) => {
    throw new CaseGraphError("patch_read_failed", `Could not read ${absolutePath}`, {
      exitCode: 3,
      details: error
    });
  });

  const extension = path.extname(absolutePath).toLowerCase();
  try {
    if (extension === ".json") {
      return JSON.parse(contents) as unknown;
    }

    if (extension === ".yaml" || extension === ".yml") {
      return parseYaml(contents);
    }
  } catch (error) {
    throw new CaseGraphError("patch_parse_failed", `Could not parse ${absolutePath}`, {
      exitCode: 2,
      details: error
    });
  }

  throw new CaseGraphError(
    "patch_format_unsupported",
    `Unsupported patch file format for ${absolutePath}`,
    { exitCode: 2 }
  );
}

export async function loadPatchValidation(filePath: string): Promise<PatchValidationData> {
  return validatePatchDocument(await readPatchDocument(filePath));
}

export async function loadValidPatch(filePath: string): Promise<GraphPatch> {
  const validation = await loadPatchValidation(filePath);
  if (!(validation.valid && validation.patch)) {
    throw new CaseGraphError("patch_invalid", "Patch validation failed", {
      exitCode: 2,
      details: validation
    });
  }

  return validation.patch;
}

export async function writeStructuredFile(filePath: string, value: unknown): Promise<void> {
  const absolutePath = path.resolve(filePath);
  const extension = path.extname(absolutePath).toLowerCase();

  if (extension === ".json") {
    await writeFile(absolutePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    return;
  }

  if (extension === ".yaml" || extension === ".yml") {
    await writeFile(absolutePath, stringifyYaml(value), "utf8");
    return;
  }

  throw new CaseGraphError(
    "patch_format_unsupported",
    `Unsupported output file format for ${absolutePath}`,
    { exitCode: 2 }
  );
}
