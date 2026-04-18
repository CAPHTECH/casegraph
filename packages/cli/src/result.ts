import type { RevisionSnapshot } from "@caphtech/casegraph-kernel";

export interface CommandSuccess<TData> {
  ok: true;
  command: string;
  data: TData;
  revision?: RevisionSnapshot;
}

export interface CommandFailure {
  ok: false;
  command: string;
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

export type CommandResult<TData> = CommandSuccess<TData> | CommandFailure;

export function successResult<TData>(
  command: string,
  data: TData,
  revision?: RevisionSnapshot
): CommandSuccess<TData> {
  const result: CommandSuccess<TData> = {
    ok: true,
    command,
    data
  };

  if (revision) {
    result.revision = revision;
  }

  return result;
}
