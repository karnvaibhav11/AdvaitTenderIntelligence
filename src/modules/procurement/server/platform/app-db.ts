import { mkdirSync } from "node:fs";
import path from "node:path";

/**
 * Writable application state (sessions, conversations, audit log, AI usage).
 * Kept apart from the read-only analytical store so that procurement records
 * can never be modified through the application database handle.
 */

export interface AppDb {
  exec(sql: string): void;
  prepare(sql: string): {
    all(...params: unknown[]): unknown[];
    get(...params: unknown[]): unknown;
    run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
  };
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  session_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  ip TEXT
);
CREATE TABLE IF NOT EXISTS conversations (
  conversation_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  title TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  context_json TEXT
);
CREATE INDEX IF NOT EXISTS ix_conv_user ON conversations(user_id, updated_at DESC);
CREATE TABLE IF NOT EXISTS messages (
  message_id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT NOT NULL REFERENCES conversations(conversation_id),
  role TEXT NOT NULL CHECK (role IN ('user','assistant')),
  content TEXT NOT NULL,
  payload_json TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_msg_conv ON messages(conversation_id, message_id);
CREATE TABLE IF NOT EXISTS ai_usage (
  usage_id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  user_id TEXT NOT NULL,
  conversation_id TEXT,
  request_id TEXT,
  model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  latency_ms INTEGER NOT NULL DEFAULT 0,
  tool_calls INTEGER NOT NULL DEFAULT 0,
  estimated_cost_usd REAL
);
CREATE TABLE IF NOT EXISTS audit_log (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  actor_role TEXT NOT NULL,
  action TEXT NOT NULL,
  resource TEXT,
  outcome TEXT NOT NULL,
  request_id TEXT,
  details TEXT NOT NULL,
  prev_hash TEXT NOT NULL,
  hash TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS audit_log_no_update BEFORE UPDATE ON audit_log
BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
CREATE TRIGGER IF NOT EXISTS audit_log_no_delete BEFORE DELETE ON audit_log
BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
`;

const globalDb = globalThis as unknown as { __advaitAppDb?: AppDb; __advaitAppDbPath?: string };

export function appDbPath(): string {
  return process.env.ADVAIT_APP_DB
    ? path.resolve(process.env.ADVAIT_APP_DB)
    : path.resolve(process.cwd(), ".data/tender-intelligence.db");
}

export function openAppDb(location: string = appDbPath()): AppDb {
  const sqlite = process.getBuiltinModule("node:sqlite") as unknown as {
    DatabaseSync: new (location: string) => AppDb & { exec(sql: string): void };
  };
  if (location !== ":memory:") mkdirSync(path.dirname(location), { recursive: true });
  const db = new sqlite.DatabaseSync(location);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(SCHEMA);
  return db;
}

export function getAppDb(): AppDb {
  const location = appDbPath();
  if (!globalDb.__advaitAppDb || globalDb.__advaitAppDbPath !== location) {
    globalDb.__advaitAppDb = openAppDb(location);
    globalDb.__advaitAppDbPath = location;
  }
  return globalDb.__advaitAppDb;
}

/** Test helper: replace the process-wide application database. */
export function useAppDbForTests(db: AppDb): void {
  globalDb.__advaitAppDb = db;
  globalDb.__advaitAppDbPath = appDbPath();
}
