import { mkdir, readFile, writeFile } from "node:fs/promises";
import YAML from "yaml";

export async function ensureDirectory(dirPath: string): Promise<void> {
  await mkdir(dirPath, { recursive: true });
}

export async function readYamlFile<T>(filePath: string): Promise<T> {
  const contents = await readFile(filePath, "utf8");
  return YAML.parse(contents) as T;
}

export async function writeYamlFile(filePath: string, value: unknown): Promise<void> {
  await writeFile(filePath, YAML.stringify(value), "utf8");
}

