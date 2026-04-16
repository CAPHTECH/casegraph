import readline from "node:readline";

export interface PluginServerInfo {
  name: string;
  version: string;
  capabilities: Record<string, unknown>;
  methods: string[];
  extra?: Record<string, unknown>;
}

export type PluginMethodHandler = (params: unknown) => unknown | Promise<unknown>;

export interface PluginServerOptions {
  info: PluginServerInfo;
  handlers: Record<string, PluginMethodHandler>;
}

export async function runPluginStdioServer(options: PluginServerOptions): Promise<void> {
  const input = readline.createInterface({ input: process.stdin });
  const { info, handlers } = options;

  for await (const line of input) {
    if (line.trim().length === 0) {
      continue;
    }

    let request: {
      id?: number | string | null;
      method?: string;
      params?: unknown;
    };

    try {
      request = JSON.parse(line) as typeof request;
    } catch (error) {
      writeError(null, -32700, "Parse error", error);
      continue;
    }

    const id = request.id ?? null;

    if (typeof request.method !== "string") {
      writeError(id, -32600, "Invalid Request");
      continue;
    }

    try {
      switch (request.method) {
        case "initialize":
          writeResult(id, {
            name: info.name,
            version: info.version,
            capabilities: info.capabilities
          });
          break;
        case "health":
          writeResult(id, { ok: true });
          break;
        case "capabilities.list":
          writeResult(id, { methods: info.methods, ...info.extra });
          break;
        case "shutdown":
          writeResult(id, { ok: true });
          input.close();
          process.exit(0);
          break;
        default: {
          const handler = handlers[request.method];
          if (!handler) {
            writeError(id, -32601, `Method ${request.method} not found`);
            break;
          }
          writeResult(id, await handler(request.params));
        }
      }
    } catch (error) {
      writeError(id, -32000, toErrorMessage(error), error);
    }
  }
}

export function isRecord(input: unknown): input is Record<string, any> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

function writeResult(id: number | string | null, result: unknown): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

function writeError(
  id: number | string | null,
  code: number,
  message: string,
  data?: unknown
): void {
  process.stdout.write(
    `${JSON.stringify({ jsonrpc: "2.0", id, error: { code, message, data } })}\n`
  );
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error";
}
