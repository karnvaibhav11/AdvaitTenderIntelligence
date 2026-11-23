import { parse } from "csv-parse/sync";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import type { RecordRow } from "../shared/types";
import { AI_VIEWS } from "./ai/schema-catalog";
import { maskSql } from "./sql-text";
import { currentContext } from "./platform/context";
import type { Permission } from "./platform/rbac";

/**
 * Embedded, read-only analytical store.
 *
 * The synthetic CSV exports are loaded into an in-memory SQLite database so
 * every metric, drill-down and TattvaAI answer is computed by SQL over the
 * real records. A host product can replace this file with a connector to its
 * own PostgreSQL/warehouse as long as the same table and view names exist.
 */

export interface ProcurementStore {
  query<T = RecordRow>(sql: string, params?: Array<string | number | null>): T[];
  asOf: string;
  tables: string[];
  views: string[];
  dataDir: string;
  documentsDir: string;
  /** Tables left unscoped on purpose (organisation-wide masters). */
  masterTables: string[];
  /** Per-table row-level security rules actually applied, for review and tests. */
  scopeRules: Array<{ table: string; key: string | null; permission: Permission | null; rule: string }>;
}

interface SqliteStatement {
  all(...params: unknown[]): unknown[];
  run(...params: unknown[]): unknown;
}
interface SqliteDatabase {
  exec(sql: string): void;
  function(name: string, options: { deterministic?: boolean; varargs?: boolean }, fn: (...args: unknown[]) => unknown): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
}

type CsvRow = Record<string, string>;

const NUMERIC = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/;

export function resolveDataDir(): string {
  return process.env.PROCUREMENT_DATA_DIR
    ? path.resolve(process.env.PROCUREMENT_DATA_DIR)
    : path.resolve(process.cwd(), "../ADVAITSI_GEM_SYNTHETIC_PROCUREMENT/data");
}

export function resolveDocumentsDir(dataDir: string): string {
  return process.env.PROCUREMENT_DOCUMENTS_DIR
    ? path.resolve(process.env.PROCUREMENT_DOCUMENTS_DIR)
    : path.resolve(dataDir, "../documents");
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function inferColumnType(rows: CsvRow[], column: string): "INTEGER" | "REAL" | "TEXT" {
  let sawValue = false;
  let sawDecimal = false;
  for (const row of rows) {
    const value = row[column];
    if (value === undefined || value === "") continue;
    if (!NUMERIC.test(value) || value.length > 15) return "TEXT";
    sawValue = true;
    if (value.includes(".")) sawDecimal = true;
  }
  if (!sawValue) return "TEXT";
  return sawDecimal ? "REAL" : "INTEGER";
}

function readAsOf(dataDir: string): string | null {
  if (process.env.PROCUREMENT_AS_OF) return process.env.PROCUREMENT_AS_OF;
  const configPath = path.resolve(dataDir, "../generation_config.yaml");
  if (!existsSync(configPath)) return null;
  const match = /^as_of_date:\s*"?(\d{4}-\d{2}-\d{2})"?/m.exec(
    readFileSync(configPath, "utf8"),
  );
  return match ? match[1] : null;
}

const VIEWS = `
CREATE TEMP VIEW v_case AS
SELECT c.*, d.department_name, cat.category_name, cat.category_group,
       r.item_description AS title, po.vendor_id, v.company_name AS vendor_name
FROM procurement_cases c
LEFT JOIN department_master d ON d.department_id = c.department_id
LEFT JOIN procurement_category_master cat ON cat.category_id = c.category_id
LEFT JOIN requisitions r ON r.case_id = c.case_id
LEFT JOIN purchase_orders po ON po.po_number = c.po_number
LEFT JOIN vendor_master v ON v.vendor_id = po.vendor_id;

CREATE TEMP VIEW v_tender AS
SELECT t.*, c.department_id AS case_department_id, d.department_name,
       cat.category_name, cat.category_group, r.item_description AS title,
       (SELECT COUNT(*) FROM bidder_submissions s WHERE s.tender_id = t.tender_id) AS bids_received
FROM tender_master t
LEFT JOIN procurement_cases c ON c.case_id = t.case_id
LEFT JOIN department_master d ON d.department_id = t.department_id
LEFT JOIN procurement_category_master cat ON cat.category_id = t.category_id
LEFT JOIN requisitions r ON r.case_id = t.case_id;

CREATE TEMP VIEW v_po AS
SELECT po.*, c.case_id, c.department_id, d.department_name, c.category_id,
       cat.category_name, cat.category_group, v.company_name AS vendor_name,
       cm.end_date AS contract_end_date, cm.status AS contract_status,
       cm.contract_number AS contract_number
FROM purchase_orders po
LEFT JOIN procurement_cases c ON c.po_number = po.po_number
LEFT JOIN department_master d ON d.department_id = c.department_id
LEFT JOIN procurement_category_master cat ON cat.category_id = c.category_id
LEFT JOIN vendor_master v ON v.vendor_id = po.vendor_id
LEFT JOIN contract_master cm ON cm.po_number = po.po_number;

CREATE TEMP VIEW v_invoice AS
SELECT i.*, p.case_id, p.vendor_name, p.department_name, p.category_name
FROM invoice_register i
LEFT JOIN v_po p ON p.po_number = i.po_number;
`;

export function createStore(): ProcurementStore {
  const dataDir = resolveDataDir();
  if (!existsSync(dataDir)) {
    throw new Error(`Procurement data directory not found: ${dataDir}`);
  }
  const files = readdirSync(dataDir).filter((file) => file.endsWith(".csv"));
  if (!files.includes("procurement_cases.csv")) {
    throw new Error(`procurement_cases.csv is missing from ${dataDir}`);
  }

  const sqlite = process.getBuiltinModule("node:sqlite") as unknown as {
    DatabaseSync: new (location: string) => SqliteDatabase;
  };
  const db = new sqlite.DatabaseSync(":memory:");
  const tables: string[] = [];
  const columnsByTable = new Map<string, string[]>();

  db.exec("BEGIN");
  for (const file of files) {
    const table = file.replace(/\.csv$/, "");
    const rows = parse(readFileSync(path.join(dataDir, file), "utf8"), {
      bom: true,
      columns: true,
      skip_empty_lines: true,
      relax_column_count: true,
    }) as CsvRow[];
    if (rows.length === 0) continue;
    const columns = Object.keys(rows[0]);
    const types = columns.map((column) => inferColumnType(rows, column));
    db.exec(
      `CREATE TABLE ${quoteIdent(table)} (${columns
        .map((column, index) => `${quoteIdent(column)} ${types[index]}`)
        .join(", ")})`,
    );
    const insert = db.prepare(
      `INSERT INTO ${quoteIdent(table)} VALUES (${columns.map(() => "?").join(",")})`,
    );
    for (const row of rows) {
      insert.run(
        ...columns.map((column, index) => {
          const value = row[column];
          if (value === undefined || value === "") return null;
          return types[index] === "TEXT" ? value : Number(value);
        }),
      );
    }
    columns.forEach((column, index) => {
      if (/(_id|_number)$/.test(column)) {
        db.exec(
          `CREATE INDEX ${quoteIdent(`ix_${table}_${index}`)} ON ${quoteIdent(table)}(${quoteIdent(column)})`,
        );
      }
    });
    tables.push(table);
    columnsByTable.set(table, columns);
  }
  db.exec("COMMIT");

  const lastUpdated = db
    .prepare("SELECT MAX(last_updated) AS d FROM procurement_cases")
    .all() as Array<{ d: string }>;
  const asOf = readAsOf(dataDir) ?? lastUpdated[0]?.d ?? new Date().toISOString().slice(0, 10);

  const scopeRules = installRowLevelSecurity(db, tables, columnsByTable);
  db.exec(VIEWS);
  for (const view of AI_VIEWS) db.exec(`CREATE TEMP VIEW ${view.name} AS ${view.sql}`);

  // Every query after loading is read-only.
  db.exec("PRAGMA query_only = ON");

  return {
    asOf,
    tables,
    views: ["v_case", "v_tender", "v_po", "v_invoice", ...AI_VIEWS.map((view) => view.name)],
    dataDir,
    documentsDir: resolveDocumentsDir(dataDir),
    masterTables: MASTER_TABLES.filter((name) => tables.includes(name)),
    scopeRules,
    query<T = RecordRow>(sql: string, params: Array<string | number | null> = []): T[] {
      return db
        .prepare(sql.replaceAll("{ASOF}", `'${asOf}'`))
        .all(...params) as T[];
    },
  };
}

/** Organisation-wide reference data; every other table is scoped or denied. */
const MASTER_TABLES = [
  "vendor_master",
  "item_master",
  "department_master",
  "procurement_category_master",
  "vendor_category_master",
  "area_master",
  "mine_master",
  "organisation_master",
  "employee_officer_master",
];

/** Tables whose contents need an explicit data permission on top of department scope. */
const PERMISSION_GATED: Array<{ permission: Permission; tables: string[] }> = [
  {
    permission: "data:bids_financial",
    tables: ["financial_quotes", "financial_evaluations", "comparative_statements", "qcbs_scores", "reverse_auction_results", "reverse_auction_participants", "reverse_auction_events"],
  },
  {
    permission: "data:payments",
    tables: ["invoice_register", "invoice_line_items", "invoice_verification", "payment_register", "payment_deductions", "outstanding_payments"],
  },
  { permission: "data:budget", tables: ["budget_controls"] },
];

/** First matching key decides how a table is tied to a procurement case. */
const KEY_PRIORITY: Array<{ key: string; owner: string; parent: string }> = [
  { key: "case_id", owner: "procurement_cases", parent: "" },
  { key: "requisition_id", owner: "requisitions", parent: "case_id" },
  { key: "tender_id", owner: "tender_master", parent: "case_id" },
  { key: "po_number", owner: "purchase_orders", parent: "tender_id" },
  { key: "contract_number", owner: "contract_master", parent: "po_number" },
  { key: "submission_id", owner: "bidder_submissions", parent: "tender_id" },
  { key: "invoice_id", owner: "invoice_register", parent: "po_number" },
  { key: "receipt_id", owner: "delivery_receipts", parent: "po_number" },
  { key: "inspection_id", owner: "inspection_records", parent: "po_number" },
  { key: "document_id", owner: "document_metadata", parent: "case_id" },
  { key: "tech_eval_id", owner: "technical_evaluations", parent: "tender_id" },
  { key: "ra_id", owner: "reverse_auction_master", parent: "tender_id" },
  { key: "award_id", owner: "award_decisions", parent: "case_id" },
  { key: "warranty_id", owner: "warranty_register", parent: "po_number" },
  { key: "tender_line_id", owner: "tender_line_items", parent: "tender_id" },
  { key: "dispatch_id", owner: "dispatch_records", parent: "po_number" },
  { key: "acceptance_id", owner: "acceptance_certificates", parent: "po_number" },
];

/**
 * Row-level security. SQL functions read the request principal from the async
 * context, and each table is shadowed by a TEMP view of the same name that
 * filters to the principal's departments/areas (and data permissions). Every
 * query, including generated SQL, then sees only authorised rows, with no
 * change to the query text. Tables that cannot be tied to a case and are not
 * declared master data are denied outright (fail closed).
 */
function installRowLevelSecurity(
  db: SqliteDatabase,
  tables: string[],
  columnsByTable: Map<string, string[]>,
): ProcurementStore["scopeRules"] {
  db.function("adv_row_ok", {}, (department, area) => {
    const context = currentContext();
    if (!context) return 1;
    const { scope } = context.principal;
    if (scope.all) return 1;
    if (scope.departments.length === 0 && scope.areas.length === 0) return 0;
    const departmentOk = scope.departments.length === 0 || scope.departments.includes(String(department));
    const areaOk = scope.areas.length === 0 || (area !== null && area !== undefined && scope.areas.includes(String(area)));
    return departmentOk && areaOk ? 1 : 0;
  });
  db.function("adv_perm_ok", {}, (permission) => {
    const context = currentContext();
    if (!context) return 1;
    return context.principal.permissions.includes(String(permission) as Permission) ? 1 : 0;
  });

  const available = (table: string) => tables.includes(table);
  const hasColumn = (table: string, column: string) => columnsByTable.get(table)?.includes(column) ?? false;

  for (const { key, owner, parent } of KEY_PRIORITY) {
    if (!available(owner)) continue;
    const predicate =
      key === "case_id"
        ? "adv_row_ok(department_id, area_id)"
        : hasColumn(owner, parent)
          ? `${parent} IN (SELECT ${parent} FROM adv_vis_${parent})`
          : "0";
    db.exec(`CREATE TEMP VIEW adv_vis_${key} AS SELECT DISTINCT ${key} FROM main."${owner}" WHERE ${predicate}`);
  }

  const gate = new Map<string, Permission>();
  for (const { permission, tables: gated } of PERMISSION_GATED) for (const table of gated) gate.set(table, permission);

  const rules: ProcurementStore["scopeRules"] = [];
  for (const table of tables) {
    if (MASTER_TABLES.includes(table)) {
      rules.push({ table, key: null, permission: null, rule: "organisation-wide master data" });
      continue;
    }
    const match = table === "procurement_cases" ? undefined : KEY_PRIORITY.find((entry) => hasColumn(table, entry.key));
    const permission = gate.get(table) ?? null;
    let predicate: string;
    let key: string | null = null;
    if (table === "procurement_cases") {
      predicate = "adv_row_ok(department_id, area_id)";
      key = "department_id";
    } else if (match && available(match.owner)) {
      predicate = `${match.key} IN (SELECT ${match.key} FROM adv_vis_${match.key})`;
      key = match.key;
    } else {
      predicate = "0";
    }
    if (permission) predicate = `adv_perm_ok('${permission}') AND ${predicate}`;
    db.exec(`CREATE TEMP VIEW "${table}" AS SELECT * FROM main."${table}" WHERE ${predicate}`);
    rules.push({ table, key, permission, rule: predicate === "0" ? "denied: no case linkage" : predicate });
  }
  return rules;
}

const globalStore = globalThis as unknown as {
  __advaitProcurementStore?: ProcurementStore;
};

/**
 * Unscoped store for trusted tooling (CLI audits, ingestion, tests). Outside a
 * request there is no principal, so row-level security does not restrict it.
 * Application code must use `getScopedStore()`.
 */
export function getStore(): ProcurementStore {
  globalStore.__advaitProcurementStore ??= createStore();
  return globalStore.__advaitProcurementStore;
}

/** Store for request handling: refuses to run without an authenticated context. */
export function getScopedStore(): ProcurementStore {
  const base = getStore();
  return {
    ...base,
    query<T = RecordRow>(sql: string, params: Array<string | number | null> = []): T[] {
      if (!currentContext()) throw new Error("Scoped store used without an authenticated request context");
      return base.query<T>(sql, params);
    },
  };
}

const FORBIDDEN =
  /\b(insert|update|delete|drop|alter|create|replace|attach|detach|pragma|vacuum|reindex|truncate|grant|revoke)\b/i;

/** Guard used for generated SQL: one SELECT statement over known tables only. */
export function validateReadOnlySql(
  sql: string,
  store: ProcurementStore,
): { ok: true } | { ok: false; reason: string } {
  const trimmed = sql.trim().replace(/;+\s*$/, "");
  const code = maskSql(trimmed);
  if (code.includes(";")) return { ok: false, reason: "Multiple statements are not allowed." };
  if (!/^(select|with)\b/i.test(code)) {
    return { ok: false, reason: "Only SELECT statements are allowed." };
  }
  if (FORBIDDEN.test(code)) return { ok: false, reason: "Statement contains a write or DDL keyword." };
  const known = new Set([...store.tables, ...store.views]);
  const cteNames = new Set(
    [...code.matchAll(/\b([a-z_][a-z0-9_]*)\s+as\s*\(/gi)].map((m) => m[1].toLowerCase()),
  );
  for (const match of code.matchAll(/\b(?:from|join)\s+([a-z_][a-z0-9_]*)/gi)) {
    const name = match[1];
    if (!known.has(name) && !cteNames.has(name.toLowerCase())) {
      return { ok: false, reason: `Unknown table or view: ${name}` };
    }
  }
  return { ok: true };
}
