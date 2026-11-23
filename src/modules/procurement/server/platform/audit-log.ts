import { createHash } from "node:crypto";
import { type AppDb, getAppDb } from "./app-db";
import type { Principal } from "./rbac";

/**
 * Append-only, tamper-evident audit log. Each entry's hash covers its content
 * and the previous entry's hash, so editing, removing or re-ordering any row
 * breaks verification from that point on. SQLite triggers additionally reject
 * UPDATE and DELETE. Details hold query metadata, never result rows or
 * document contents.
 */

export type AuditAction =
  | "auth.login"
  | "auth.login_failed"
  | "auth.logout"
  | "access.denied"
  | "ai.query"
  | "ai.tool"
  | "ai.error"
  | "data.sql"
  | "document.view"
  | "export.csv"
  | "record.view"
  | "admin.view"
  | "admin.audit_verify";

export interface AuditEntry {
  seq: number;
  ts: string;
  actor_id: string;
  actor_role: string;
  action: string;
  resource: string | null;
  outcome: string;
  request_id: string | null;
  details: string;
  prev_hash: string;
  hash: string;
}

const GENESIS = "0".repeat(64);

function canonical(entry: Omit<AuditEntry, "seq" | "hash">): string {
  return JSON.stringify([entry.ts, entry.actor_id, entry.actor_role, entry.action, entry.resource, entry.outcome, entry.request_id, entry.details, entry.prev_hash]);
}

function hashOf(entry: Omit<AuditEntry, "seq" | "hash">): string {
  return createHash("sha256").update(canonical(entry)).digest("hex");
}

const SENSITIVE_KEYS = /password|secret|token|api[_-]?key|authorization|cookie/i;

function redact(value: unknown, depth = 0): unknown {
  if (depth > 4) return "[truncated]";
  if (typeof value === "string") return value.length > 600 ? `${value.slice(0, 600)}…` : value;
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => redact(item, depth + 1));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, SENSITIVE_KEYS.test(key) ? "[redacted]" : redact(item, depth + 1)]),
    );
  }
  return value;
}

export function recordAudit(
  actor: Pick<Principal, "id" | "role"> | { id: string; role: string },
  action: AuditAction,
  options: { resource?: string; outcome?: "success" | "denied" | "error"; requestId?: string; details?: Record<string, unknown> } = {},
  db: AppDb = getAppDb(),
): AuditEntry {
  db.exec("BEGIN IMMEDIATE");
  try {
    const last = db.prepare("SELECT hash FROM audit_log ORDER BY seq DESC LIMIT 1").get() as { hash: string } | undefined;
    const base = {
      ts: new Date().toISOString(),
      actor_id: actor.id,
      actor_role: actor.role,
      action,
      resource: options.resource ?? null,
      outcome: options.outcome ?? "success",
      request_id: options.requestId ?? null,
      details: JSON.stringify(redact(options.details ?? {})),
      prev_hash: last?.hash ?? GENESIS,
    };
    const hash = hashOf(base);
    const result = db
      .prepare("INSERT INTO audit_log (ts, actor_id, actor_role, action, resource, outcome, request_id, details, prev_hash, hash) VALUES (?,?,?,?,?,?,?,?,?,?)")
      .run(base.ts, base.actor_id, base.actor_role, base.action, base.resource, base.outcome, base.request_id, base.details, base.prev_hash, hash);
    db.exec("COMMIT");
    return { seq: Number(result.lastInsertRowid), ...base, hash };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export interface ChainVerification {
  valid: boolean;
  entries: number;
  headHash: string;
  firstBrokenSeq: number | null;
  reason: string | null;
}

export function verifyAuditChain(db: AppDb = getAppDb()): ChainVerification {
  const rows = db.prepare("SELECT * FROM audit_log ORDER BY seq").all() as unknown as AuditEntry[];
  let previous = GENESIS;
  let expectedSeq: number | null = null;
  for (const row of rows) {
    if (expectedSeq !== null && row.seq !== expectedSeq) {
      return { valid: false, entries: rows.length, headHash: previous, firstBrokenSeq: row.seq, reason: `Sequence gap: expected ${expectedSeq}, found ${row.seq}` };
    }
    expectedSeq = row.seq + 1;
    if (row.prev_hash !== previous) {
      return { valid: false, entries: rows.length, headHash: previous, firstBrokenSeq: row.seq, reason: "Previous-hash link does not match" };
    }
    const { seq: _seq, hash, ...rest } = row;
    void _seq;
    if (hashOf(rest) !== hash) {
      return { valid: false, entries: rows.length, headHash: previous, firstBrokenSeq: row.seq, reason: "Entry content does not match its hash" };
    }
    previous = hash;
  }
  return { valid: true, entries: rows.length, headHash: previous, firstBrokenSeq: null, reason: null };
}

export function listAudit(limit = 100, db: AppDb = getAppDb()): AuditEntry[] {
  return db.prepare("SELECT * FROM audit_log ORDER BY seq DESC LIMIT ?").all(Math.min(Math.max(limit, 1), 500)) as unknown as AuditEntry[];
}
