import { type ProcurementStore, getScopedStore } from "../db";
import { maskSql } from "../sql-text";
import { AI_VIEW_NAMES } from "./schema-catalog";

/**
 * Guard for SQL written by the model. Defence in depth, in order:
 *  1. text rules here (SELECT only, one statement, `ai_*` views only, bounded size and joins),
 *  2. row-level security (the views read tables shadowed by per-principal filters),
 *  3. a read-only database connection,
 *  4. a hard row cap applied by wrapping the statement.
 * It cannot interrupt a running statement (node:sqlite has no timeout), so join
 * shape is constrained instead. A PostgreSQL deployment should add statement_timeout.
 */

export const MAX_SQL_LENGTH = 4000;
export const MAX_RELATIONS = 3;
export const MAX_ROWS = 200;

const FORBIDDEN_WORDS =
  /\b(insert|update|delete|drop|alter|create|replace|attach|detach|pragma|vacuum|reindex|truncate|grant|revoke|recursive|load_extension|randomblob|zeroblob|readfile|writefile|sqlite_[a-z_]*|adv_[a-z_]*)\b/i;

export type SqlCheck = { ok: true; relations: string[]; wrapped: string } | { ok: false; reason: string };

export function checkAgentSql(rawSql: string, store: ProcurementStore = getScopedStore()): SqlCheck {
  const sql = rawSql.trim().replace(/;+\s*$/, "");
  if (!sql) return { ok: false, reason: "Empty statement." };
  if (sql.length > MAX_SQL_LENGTH) return { ok: false, reason: `Statement is longer than ${MAX_SQL_LENGTH} characters.` };
  const code = maskSql(sql);
  if (code.includes(";")) return { ok: false, reason: "Multiple statements are not allowed." };
  if (!/^(select|with)\b/i.test(code.trim())) return { ok: false, reason: "Only SELECT statements are allowed." };
  const forbidden = FORBIDDEN_WORDS.exec(code);
  if (forbidden) return { ok: false, reason: `Keyword or function not allowed: ${forbidden[0]}` };
  if (/\bcross\s+join\b/i.test(code)) return { ok: false, reason: "CROSS JOIN is not allowed; join with an ON condition." };
  if (/\bfrom\s+[a-z_][a-z0-9_]*(\s+(as\s+)?[a-z_][a-z0-9_]*)?\s*,/i.test(code) || /\bjoin\s+[a-z_][a-z0-9_]*(\s+(as\s+)?[a-z_][a-z0-9_]*)?\s*,/i.test(code)) {
    return { ok: false, reason: "Comma joins are not allowed; use JOIN ... ON." };
  }

  const cteNames = new Set([...code.matchAll(/\b([a-z_][a-z0-9_]*)\s+as\s*\(/gi)].map((m) => m[1].toLowerCase()));
  const relations: string[] = [];
  for (const match of code.matchAll(/\b(?:from|join)\s+([a-z_][a-z0-9_]*)/gi)) {
    const name = match[1].toLowerCase();
    if (cteNames.has(name)) continue;
    if (!AI_VIEW_NAMES.includes(name)) {
      return { ok: false, reason: `Relation not available: ${match[1]}. Use describe_data_model to list the permitted views (all start with ai_).` };
    }
    if (!store.views.includes(name)) return { ok: false, reason: `Relation not available: ${match[1]}` };
    relations.push(name);
  }
  if (relations.length === 0) return { ok: false, reason: "Query must read from at least one ai_* view." };
  if (relations.length > MAX_RELATIONS) return { ok: false, reason: `At most ${MAX_RELATIONS} relations per query; use a CTE or a business tool for larger analyses.` };
  if (relations.includes("ai_status_events") && relations.length > 1) {
    return { ok: false, reason: "ai_status_events is large; query it on its own (filter by case_id)." };
  }
  const joins = [...code.matchAll(/\bjoin\b/gi)].length;
  const onConditions = [...code.matchAll(/\bon\b[^=<>!]*=/gi)].length + [...code.matchAll(/\busing\s*\(/gi)].length;
  if (joins > onConditions) return { ok: false, reason: "Every JOIN needs an equality ON condition." };

  return { ok: true, relations, wrapped: `SELECT * FROM (${sql}) LIMIT ${MAX_ROWS + 1}` };
}

export interface SqlResult {
  columns: string[];
  rows: Array<Record<string, string | number | boolean | null>>;
  truncated: boolean;
  relations: string[];
}

export function runAgentSql(sql: string, store: ProcurementStore = getScopedStore()): SqlResult {
  const check = checkAgentSql(sql, store);
  if (!check.ok) throw new SqlRejected(check.reason);
  const rows = store.query<Record<string, string | number | boolean | null>>(check.wrapped);
  const truncated = rows.length > MAX_ROWS;
  const kept = truncated ? rows.slice(0, MAX_ROWS) : rows;
  return { columns: kept[0] ? Object.keys(kept[0]) : [], rows: kept, truncated, relations: check.relations };
}

export class SqlRejected extends Error {}
