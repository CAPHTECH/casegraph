import YAML from "yaml";

export function parseYaml<T>(contents: string): T {
  return YAML.parse(contents) as T;
}

export function stringifyYaml(value: unknown): string {
  return YAML.stringify(value);
}
