import { mkdir, readFile, writeFile } from "node:fs/promises";
import YAML from "yaml";

export async function ensureDirectory(dirPath: string): Promise<void> {
  await mkdir(dirPath, { recursive: true });
}

export async function readYamlFile<T>(filePath: string): Promise<T> {
  const contents = await readFile(filePath, "utf8");
  return parseYaml<T>(contents);
}

export async function writeYamlFile(filePath: string, value: unknown): Promise<void> {
  await writeFile(filePath, stringifyYaml(value), "utf8");
}

export function parseYaml<T>(contents: string): T {
  return YAML.parse(contents) as T;
}

export function stringifyYaml(value: unknown): string {
  return YAML.stringify(value);
}
