export class CaseGraphError extends Error {
  public readonly code: string;
  public readonly details?: unknown;
  public readonly exitCode: number;

  public constructor(
    code: string,
    message: string,
    options?: { details?: unknown; exitCode?: number }
  ) {
    super(message);
    this.name = "CaseGraphError";
    this.code = code;
    this.details = options?.details;
    this.exitCode = options?.exitCode ?? 1;
  }
}

export function isCaseGraphError(value: unknown): value is CaseGraphError {
  return value instanceof CaseGraphError;
}

export function normalizeUnknownError(error: unknown): CaseGraphError {
  if (isCaseGraphError(error)) {
    return error;
  }

  if (error instanceof Error) {
    return new CaseGraphError("internal_error", error.message, { details: error });
  }

  return new CaseGraphError("internal_error", "Unexpected error", { details: error });
}
