import { DatabaseSync } from "node:sqlite";

import { deriveProjectionMappings } from "./sink-mappings.js";
import type { CaseStateView } from "./types.js";

export function openCacheDatabase(databasePath: string): DatabaseSync {
  const database = new DatabaseSync(databasePath);
  database.exec(
    [
      "PRAGMA journal_mode = WAL;",
      "CREATE TABLE IF NOT EXISTS cases (",
      "  case_id TEXT PRIMARY KEY,",
      "  title TEXT NOT NULL,",
      "  state TEXT NOT NULL,",
      "  updated_at TEXT NOT NULL,",
      "  revision INTEGER NOT NULL,",
      "  last_event_id TEXT",
      ");",
      "CREATE TABLE IF NOT EXISTS nodes (",
      "  case_id TEXT NOT NULL,",
      "  node_id TEXT NOT NULL,",
      "  kind TEXT NOT NULL,",
      "  state TEXT NOT NULL,",
      "  title TEXT NOT NULL,",
      "  updated_at TEXT NOT NULL,",
      "  labels_json TEXT NOT NULL,",
      "  metadata_json TEXT NOT NULL,",
      "  PRIMARY KEY (case_id, node_id)",
      ");",
      "CREATE TABLE IF NOT EXISTS edges (",
      "  case_id TEXT NOT NULL,",
      "  edge_id TEXT NOT NULL,",
      "  type TEXT NOT NULL,",
      "  source_id TEXT NOT NULL,",
      "  target_id TEXT NOT NULL,",
      "  PRIMARY KEY (case_id, edge_id)",
      ");",
      "CREATE TABLE IF NOT EXISTS events (",
      "  case_id TEXT NOT NULL,",
      "  event_id TEXT NOT NULL,",
      "  timestamp TEXT NOT NULL,",
      "  type TEXT NOT NULL,",
      "  revision_hint INTEGER,",
      "  PRIMARY KEY (case_id, event_id)",
      ");",
      "CREATE TABLE IF NOT EXISTS node_derived (",
      "  case_id TEXT NOT NULL,",
      "  node_id TEXT NOT NULL,",
      "  is_ready INTEGER NOT NULL,",
      "  is_blocked INTEGER NOT NULL,",
      "  blockers_json TEXT NOT NULL,",
      "  waiting_for_json TEXT NOT NULL,",
      "  dependency_satisfied_ratio REAL NOT NULL,",
      "  has_unverified_completion INTEGER NOT NULL,",
      "  PRIMARY KEY (case_id, node_id)",
      ");",
      "CREATE TABLE IF NOT EXISTS attachments (",
      "  case_id TEXT NOT NULL,",
      "  attachment_id TEXT NOT NULL,",
      "  evidence_node_id TEXT NOT NULL,",
      "  storage_mode TEXT NOT NULL,",
      "  path_or_url TEXT NOT NULL,",
      "  sha256 TEXT,",
      "  mime_type TEXT,",
      "  size_bytes INTEGER,",
      "  created_at TEXT NOT NULL,",
      "  PRIMARY KEY (case_id, attachment_id)",
      ");",
      "CREATE TABLE IF NOT EXISTS projection_mappings (",
      "  case_id TEXT NOT NULL,",
      "  sink_name TEXT NOT NULL,",
      "  internal_node_id TEXT NOT NULL,",
      "  external_item_id TEXT,",
      "  last_pushed_at TEXT,",
      "  last_pulled_at TEXT,",
      "  last_known_external_hash TEXT,",
      "  sync_policy_json TEXT,",
      "  PRIMARY KEY (case_id, sink_name, internal_node_id)",
      ");"
    ].join("\n")
  );
  return database;
}

export function rebuildCaseCache(database: DatabaseSync, state: CaseStateView): void {
  const caseId = state.caseRecord.case_id;
  database.exec("BEGIN");
  try {
    database.prepare("DELETE FROM cases WHERE case_id = ?").run(caseId);
    database.prepare("DELETE FROM nodes WHERE case_id = ?").run(caseId);
    database.prepare("DELETE FROM edges WHERE case_id = ?").run(caseId);
    database.prepare("DELETE FROM events WHERE case_id = ?").run(caseId);
    database.prepare("DELETE FROM node_derived WHERE case_id = ?").run(caseId);
    database.prepare("DELETE FROM attachments WHERE case_id = ?").run(caseId);
    database.prepare("DELETE FROM projection_mappings WHERE case_id = ?").run(caseId);

    database
      .prepare(
        "INSERT INTO cases (case_id, title, state, updated_at, revision, last_event_id) VALUES (?, ?, ?, ?, ?, ?)"
      )
      .run(
        state.caseRecord.case_id,
        state.caseRecord.title,
        state.caseRecord.state,
        state.caseRecord.updated_at,
        state.caseRecord.case_revision.current,
        state.caseRecord.case_revision.last_event_id
      );

    const insertNode = database.prepare(
      "INSERT INTO nodes (case_id, node_id, kind, state, title, updated_at, labels_json, metadata_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    );
    for (const node of state.nodes.values()) {
      insertNode.run(
        caseId,
        node.node_id,
        node.kind,
        node.state,
        node.title,
        node.updated_at,
        JSON.stringify(node.labels),
        JSON.stringify(node.metadata)
      );
    }

    const insertEdge = database.prepare(
      "INSERT INTO edges (case_id, edge_id, type, source_id, target_id) VALUES (?, ?, ?, ?, ?)"
    );
    for (const edge of state.edges.values()) {
      insertEdge.run(caseId, edge.edge_id, edge.type, edge.source_id, edge.target_id);
    }

    const insertEvent = database.prepare(
      "INSERT INTO events (case_id, event_id, timestamp, type, revision_hint) VALUES (?, ?, ?, ?, ?)"
    );
    for (const event of state.events) {
      insertEvent.run(
        caseId,
        event.event_id,
        event.timestamp,
        event.type,
        event.revision_hint ?? null
      );
    }

    const insertDerived = database.prepare(
      [
        "INSERT INTO node_derived (",
        "  case_id, node_id, is_ready, is_blocked, blockers_json, waiting_for_json,",
        "  dependency_satisfied_ratio, has_unverified_completion",
        ") VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
      ].join(" ")
    );
    for (const derived of state.derived.values()) {
      insertDerived.run(
        caseId,
        derived.node_id,
        derived.is_ready ? 1 : 0,
        derived.is_blocked ? 1 : 0,
        JSON.stringify(derived.blockers),
        JSON.stringify(derived.waiting_for),
        derived.dependency_satisfied_ratio,
        derived.has_unverified_completion ? 1 : 0
      );
    }

    const insertAttachment = database.prepare(
      [
        "INSERT INTO attachments (",
        "  case_id, attachment_id, evidence_node_id, storage_mode, path_or_url, sha256,",
        "  mime_type, size_bytes, created_at",
        ") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
      ].join(" ")
    );
    for (const attachment of state.attachments.values()) {
      insertAttachment.run(
        caseId,
        attachment.attachment_id,
        attachment.evidence_node_id,
        attachment.storage_mode,
        attachment.path_or_url,
        attachment.sha256,
        attachment.mime_type,
        attachment.size_bytes,
        attachment.created_at
      );
    }

    const insertMapping = database.prepare(
      [
        "INSERT INTO projection_mappings (",
        "  case_id, sink_name, internal_node_id, external_item_id,",
        "  last_pushed_at, last_pulled_at, last_known_external_hash, sync_policy_json",
        ") VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
      ].join(" ")
    );
    for (const mapping of deriveProjectionMappings(state.events)) {
      insertMapping.run(
        caseId,
        mapping.sink_name,
        mapping.internal_node_id,
        mapping.external_item_id,
        mapping.last_pushed_at,
        mapping.last_pulled_at,
        mapping.last_known_external_hash,
        mapping.sync_policy_json
      );
    }

    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}
