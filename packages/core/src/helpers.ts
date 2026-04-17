import { createHash } from "node:crypto";
import { copyFile, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { ulid } from "ulid";

import { DEFAULT_ACTOR_ID, DEFAULT_ACTOR_NAME, SPEC_VERSION } from "./constants.js";
import type {
  ActorRef,
  AttachmentRecord,
  CaseRecord,
  EdgeRecord,
  EventEnvelope,
  NodeRecord
} from "./types.js";

export function nowUtc(): string {
  return new Date().toISOString();
}

export function generateId(): string {
  return ulid();
}

export function defaultActor(): ActorRef {
  return {
    kind: "user",
    id: DEFAULT_ACTOR_ID,
    display_name: DEFAULT_ACTOR_NAME
  };
}

export function cloneRecord<T>(value: T): T {
  return structuredClone(value);
}

export function createEvent<TPayload extends Record<string, unknown>>(
  input: Omit<EventEnvelope<TPayload>, "event_id" | "spec_version" | "actor"> & {
    event_id?: string;
    actor?: ActorRef;
  }
): EventEnvelope<TPayload> {
  return {
    ...input,
    event_id: input.event_id ?? generateId(),
    spec_version: SPEC_VERSION,
    actor: input.actor ?? defaultActor()
  };
}

export function ensureArray(value: string[] | undefined): string[] {
  return value ? [...value] : [];
}

export function ensureObject(value: Record<string, unknown> | undefined): Record<string, unknown> {
  return value ? { ...value } : {};
}

export function sanitizeCaseRecord(caseRecord: CaseRecord): CaseRecord {
  return {
    ...caseRecord,
    description: caseRecord.description ?? "",
    labels: ensureArray(caseRecord.labels),
    metadata: ensureObject(caseRecord.metadata),
    extensions: ensureObject(caseRecord.extensions)
  };
}

export function sanitizeNodeRecord(node: NodeRecord): NodeRecord {
  return {
    ...node,
    description: node.description ?? "",
    labels: ensureArray(node.labels),
    acceptance: ensureArray(node.acceptance),
    metadata: ensureObject(node.metadata),
    extensions: ensureObject(node.extensions)
  };
}

export function sanitizeEdgeRecord(edge: EdgeRecord): EdgeRecord {
  return {
    ...edge,
    metadata: ensureObject(edge.metadata),
    extensions: ensureObject(edge.extensions)
  };
}

export function sanitizeAttachmentRecord(attachment: AttachmentRecord): AttachmentRecord {
  return {
    ...attachment,
    sha256: attachment.sha256 ?? null,
    mime_type: attachment.mime_type ?? null,
    size_bytes: attachment.size_bytes ?? null
  };
}

export function metadataPriorityValue(metadata: Record<string, unknown>): number {
  const raw = metadata.priority;

  if (typeof raw === "number" && Number.isFinite(raw)) {
    return raw;
  }

  if (typeof raw === "string") {
    switch (raw.toLowerCase()) {
      case "high":
        return 1;
      case "medium":
        return 2;
      case "low":
        return 3;
      default:
        return Number.MAX_SAFE_INTEGER;
    }
  }

  return Number.MAX_SAFE_INTEGER;
}

export function dueDateValue(metadata: Record<string, unknown>): number {
  const raw = metadata.due_date;

  if (typeof raw !== "string") {
    return Number.MAX_SAFE_INTEGER;
  }

  const parsed = Date.parse(raw);
  return Number.isNaN(parsed) ? Number.MAX_SAFE_INTEGER : parsed;
}

export function estimateMinutesValue(node: Pick<NodeRecord, "kind" | "metadata">): number | null {
  if (node.kind === "event") {
    return 0;
  }

  const raw = node.metadata.estimate_minutes;
  if (typeof raw === "number" && Number.isInteger(raw) && raw >= 0) {
    return raw;
  }

  return null;
}

export function hasInvalidEstimateMinutes(node: Pick<NodeRecord, "kind" | "metadata">): boolean {
  if (node.kind === "event") {
    return false;
  }

  return Object.hasOwn(node.metadata, "estimate_minutes") && estimateMinutesValue(node) === null;
}

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
