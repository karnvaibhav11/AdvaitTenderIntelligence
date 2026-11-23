/**
 * Data-quality and scenario-coverage audit of the synthetic procurement dataset.
 * Run with `npm run audit:data` or `npx tsx scripts/data-audit.ts [--out docs/data-quality]`.
 * Writes data-quality-report.json and DATA_QUALITY_REPORT.md. Exits non-zero only
 * when a CRITICAL integrity check fails. The dataset is never modified.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { getDocumentProxy, extractText } from "unpdf";
import { getStore } from "../src/modules/procurement/server/db";

type Severity = "critical" | "major" | "minor" | "info";
type Status = "pass" | "fail" | "warn";
type Coverage = "covered" | "thin" | "absent";

interface Check {
  id: string;
  title: string;
  category: string;
  severity: Severity;
  status: Status;
  count: number;
  sample: string[];
  sample_detail?: string[];
  sql: string;
  note?: string;
}
interface Scenario {
  id: string;
  group: string;
  name: string;
  unit: string;
  definition: string;
  count: number;
  coverage: Coverage;
  sample: string[];
  sample_detail?: string[];
  sql: string;
  population: number | null;
  clean: number | null;
  abnormal: number;
  ambiguous: number | null;
  ambiguous_note: string;
  judgement: string;
  generate?: { records: number; tables: string };
}
interface ScenarioSpec {
  id: string;
  group: string;
  name: string;
  unit: string;
  definition: string;
  sql?: string;
  compute?: () => { ids: string[]; details?: string[] };
  populationSql?: string;
  ambiguousSql?: string;
  ambiguousNote?: string;
  judgement: string;
  generate?: { records: number; tables: string };
}

const args = process.argv.slice(2);
const outIdx = args.indexOf("--out");
const outDir = path.resolve(process.cwd(), outIdx >= 0 && args[outIdx + 1] ? args[outIdx + 1] : "docs/data-quality");

const store = getStore();
const datasetRoot = path.resolve(store.dataDir, "..");
const ASOF = store.asOf;
const q = <T = Record<string, unknown>>(sql: string, params: Array<string | number | null> = []) =>
  store.query<T>(sql, params);
const num = (sql: string) => Number(Object.values(q<Record<string, unknown>>(sql)[0] ?? { n: 0 })[0] ?? 0);
const trim = (sql: string) => sql.replace(/\n\s*/g, " ").replace(/\s+/g, " ").trim();
const round = (n: number, d = 2) => Math.round(n * 10 ** d) / 10 ** d;
const fmt = (n: number | null | undefined) => (n === null || n === undefined ? "n/a" : Number(n).toLocaleString("en-IN"));

const checks: Check[] = [];
const timings: Record<string, number> = {};

function statusFor(severity: Severity, count: number): Status {
  if (count === 0 || severity === "info") return "pass";
  return severity === "minor" ? "warn" : "fail";
}

interface ViolationSpec {
  id: string;
  title: string;
  category: string;
  severity: Severity;
  /** Must return column `id` (offending record) and may return `detail`. */
  sql: string;
  note?: string;
}

function violation(spec: ViolationSpec): Check {
  const started = Date.now();
  const sql = trim(spec.sql);
  const count = num(`SELECT COUNT(*) AS n FROM (SELECT DISTINCT id FROM (${sql}))`);
  const seen = new Map<string, string | null>();
  for (const r of q<{ id: string; detail?: string | null }>(`SELECT * FROM (${sql}) ORDER BY id LIMIT 80`)) {
    if (!seen.has(String(r.id)) && seen.size < 5) seen.set(String(r.id), r.detail ?? null);
  }
  const check: Check = {
    id: spec.id,
    title: spec.title,
    category: spec.category,
    severity: spec.severity,
    status: statusFor(spec.severity, count),
    count,
    sample: [...seen.keys()],
    sql,
    note: spec.note,
  };
  if ([...seen.values()].some((d) => d !== null)) {
    check.sample_detail = [...seen].map(([id, d]) => `${id}${d ? ` — ${d}` : ""}`);
  }
  timings[spec.id] = Date.now() - started;
  checks.push(check);
  return check;
}

function manual(spec: Omit<Check, "status" | "sample"> & { status?: Status; sample?: string[] }): Check {
  const check: Check = {
    ...spec,
    sample: spec.sample ?? [],
    status: spec.status ?? statusFor(spec.severity, spec.count),
  };
  checks.push(check);
  return check;
}

const base = (s: Omit<ViolationSpec, "category">, category: string) => violation({ ...s, category });

/* ------------------------------------------------------------------ */
/* A. Volume against the reference list                                */
/* ------------------------------------------------------------------ */

interface VolumeRow {
  entity: string;
  source: string;
  actual: number;
  reference_actual: number;
  target_low: number;
  target_high: number;
  gap_to_target_low: number;
  pct_of_target_low: number;
  diff_vs_reference_actual: number;
}
const VOLUME_SPEC: Array<[string, string, string, number, number, number]> = [
  // entity, source description, SQL, reference actual, target low, target high
  ["Tenders", "tender_master", "SELECT COUNT(*) FROM tender_master", 1000, 2000, 2000],
  ["Vendors", "vendor_master", "SELECT COUNT(*) FROM vendor_master", 500, 1000, 1000],
  ["Bids", "bidder_submissions", "SELECT COUNT(*) FROM bidder_submissions", 2969, 6000, 8000],
  ["Technical evaluations", "technical_evaluations", "SELECT COUNT(*) FROM technical_evaluations", 2969, 6000, 8000],
  ["Financial evaluations", "financial_evaluations", "SELECT COUNT(*) FROM financial_evaluations", 2969, 6000, 8000],
  ["Comparative statements", "comparative_statements", "SELECT COUNT(*) FROM comparative_statements", 1000, 2000, 2000],
  ["Purchase orders", "purchase_orders", "SELECT COUNT(*) FROM purchase_orders", 922, 1500, 1500],
  ["Contracts", "contract_master", "SELECT COUNT(*) FROM contract_master", 922, 1500, 1500],
  ["Delivery records (delivery_milestones)", "delivery_milestones", "SELECT COUNT(*) FROM delivery_milestones", 1841, 3000, 3000],
  ["Inspections", "inspection_records", "SELECT COUNT(*) FROM inspection_records", 1841, 3000, 3000],
  ["GRNs", "goods_receipt_notes", "SELECT COUNT(*) FROM goods_receipt_notes", 1841, 3000, 3000],
  ["Invoices", "invoice_register", "SELECT COUNT(*) FROM invoice_register", 1396, 2500, 2500],
  ["Payments", "payment_register", "SELECT COUNT(*) FROM payment_register", 464, 1500, 1500],
  ["Approvals", "approvals", "SELECT COUNT(*) FROM approvals", 6922, 12000, 12000],
  ["Workflow / audit events", "procurement_audit_events", "SELECT COUNT(*) FROM procurement_audit_events", 6000, 15000, 15000],
  ["Audit observations", "procurement_risk_register (no other audit-observation table exists)", "SELECT COUNT(*) FROM procurement_risk_register", 323, 1000, 1000],
  ["Contract amendments", "contract_variations", "SELECT COUNT(*) FROM contract_variations", 131, 300, 300],
  ["Departments", "department_master", "SELECT COUNT(*) FROM department_master", 10, 15, 15],
  ["Users", "employee_officer_master", "SELECT COUNT(*) FROM employee_officer_master", 60, 100, 100],
  ["Budget allocations", "budget_controls", "SELECT COUNT(*) FROM budget_controls", 1000, 2000, 2000],
  ["Documents / PDFs", "document_metadata", "SELECT COUNT(*) FROM document_metadata", 13000, 15000, 15000],
];
const volume: VolumeRow[] = VOLUME_SPEC.map(([entity, source, sql, refActual, lo, hi]) => {
  const actual = num(sql);
  const row: VolumeRow = {
    entity,
    source,
    actual,
    reference_actual: refActual,
    target_low: lo,
    target_high: hi,
    gap_to_target_low: actual - lo,
    pct_of_target_low: round((actual / lo) * 100, 1),
    diff_vs_reference_actual: actual - refActual,
  };
  manual({
    id: `A.volume.${source.split(" ")[0]}`,
    title: `Volume: ${entity} — actual ${actual} vs reference ${refActual} / target ${lo === hi ? lo : `${lo}-${hi}`}`,
    category: "A. Volume vs reference/target",
    severity: "info",
    count: actual,
    sql: sql,
    status: actual < lo ? "warn" : "pass",
    note: `Gap to target (low end): ${actual - lo}. Targets are aspirations from an earlier prompt, not defects.`,
  });
  return row;
});
const extraVolume = {
  tables_loaded: store.tables.length,
  total_rows: store.tables.reduce((s, t) => s + num(`SELECT COUNT(*) FROM ${t}`), 0),
  procurement_cases: num("SELECT COUNT(*) FROM procurement_cases"),
  delivery_receipts: num("SELECT COUNT(*) FROM delivery_receipts"),
  dispatch_records: num("SELECT COUNT(*) FROM dispatch_records"),
  approval_workflows: num("SELECT COUNT(*) FROM approval_workflow"),
  requisitions: num("SELECT COUNT(*) FROM requisitions"),
};

/* ------------------------------------------------------------------ */
/* B. Referential integrity and key uniqueness                         */
/* ------------------------------------------------------------------ */
const CAT_B = "B. Referential integrity";
const OWNERS: Record<string, [string, string]> = {
  case_id: ["procurement_cases", "case_id"],
  tender_id: ["tender_master", "tender_id"],
  retender_of: ["tender_master", "tender_id"],
  requisition_id: ["requisitions", "requisition_id"],
  po_number: ["purchase_orders", "po_number"],
  contract_number: ["contract_master", "contract_number"],
  vendor_id: ["vendor_master", "vendor_id"],
  recommended_vendor_id: ["vendor_master", "vendor_id"],
  submission_id: ["bidder_submissions", "submission_id"],
  invoice_id: ["invoice_register", "invoice_id"],
  receipt_id: ["delivery_receipts", "receipt_id"],
  dispatch_id: ["dispatch_records", "dispatch_id"],
  inspection_id: ["inspection_records", "inspection_id"],
  acceptance_id: ["acceptance_certificates", "acceptance_id"],
  award_id: ["award_decisions", "award_id"],
  department_id: ["department_master", "department_id"],
  responsible_department_id: ["department_master", "department_id"],
  default_department_id: ["department_master", "department_id"],
  category_id: ["procurement_category_master", "category_id"],
  item_id: ["item_master", "item_id"],
  area_id: ["area_master", "area_id"],
  mine_id: ["mine_master", "mine_id"],
  organisation_id: ["organisation_master", "organisation_id"],
  workflow_id: ["approval_workflow", "workflow_id"],
  po_line_id: ["purchase_order_line_items", "po_line_id"],
  tender_line_id: ["tender_line_items", "tender_line_id"],
  criterion_id: ["tender_eligibility_criteria", "criterion_id"],
  tech_eval_id: ["technical_evaluations", "tech_eval_id"],
  ra_id: ["reverse_auction_master", "ra_id"],
  warranty_id: ["warranty_register", "warranty_id"],
  milestone_id: ["delivery_milestones", "milestone_id"],
  vendor_category_id: ["vendor_category_master", "vendor_category_id"],
  document_id: ["document_metadata", "document_id"],
  supersedes_document_id: ["document_metadata", "document_id"],
};
const OFFICER_COL = /(_officer_id|_by)$/;
const CORE_FK = new Set([
  "case_id", "tender_id", "requisition_id", "po_number", "contract_number", "vendor_id", "recommended_vendor_id",
  "submission_id", "invoice_id", "award_id", "receipt_id", "dispatch_id", "inspection_id", "acceptance_id", "document_id",
  "workflow_id", "po_line_id", "tender_line_id",
]);
const tableCols = new Map<string, string[]>();
for (const table of store.tables) {
  tableCols.set(table, q<{ name: string }>(`PRAGMA table_info(${table})`).map((c) => c.name));
}
const qi = (n: string) => `"${n}"`;
let fkChecked = 0;
for (const table of store.tables) {
  const cols = tableCols.get(table)!;
  const pk = cols[0];
  for (const col of cols) {
    if (col === pk) continue;
    let owner: [string, string] | undefined = OWNERS[col];
    if (!owner && OFFICER_COL.test(col)) owner = ["employee_officer_master", "officer_id"];
    if (!owner) continue;
    if (owner[0] === table && owner[1] === col) continue;
    fkChecked++;
    violation({
      id: `B.orphan.${table}.${col}`,
      title: `${table}.${col} references an existing ${owner[0]}.${owner[1]}`,
      category: CAT_B,
      severity: CORE_FK.has(col) ? "critical" : "major",
      sql: `SELECT t.${qi(pk)} || ' -> ' || t.${qi(col)} AS id FROM ${table} t LEFT JOIN ${owner[0]} o ON o.${qi(owner[1])} = t.${qi(col)} WHERE t.${qi(col)} IS NOT NULL AND o.${qi(owner[1])} IS NULL`,
    });
  }
}

// Polymorphic references: entity_id depends on entity_type.
const POLY: Record<string, [string, string] | null> = {
  case: ["procurement_cases", "case_id"], tender: ["tender_master", "tender_id"],
  purchase_order: ["purchase_orders", "po_number"], invoice: ["invoice_register", "invoice_id"],
  award: ["award_decisions", "award_id"], contract: ["contract_master", "contract_number"],
  requisition: ["requisitions", "requisition_id"], vendor: ["vendor_master", "vendor_id"],
  mine: ["mine_master", "mine_id"], department: ["department_master", "department_id"],
  category: ["procurement_category_master", "category_id"], submission: ["bidder_submissions", "submission_id"],
  acceptance: ["acceptance_certificates", "acceptance_id"], payment: ["payment_register", "payment_ref"],
  approval_workflow: ["approval_workflow", "workflow_id"], receipt: ["delivery_receipts", "receipt_id"],
  inspection: ["inspection_records", "inspection_id"], reverse_auction: ["reverse_auction_master", "ra_id"],
};
for (const [table, pk] of [["procurement_audit_events", "audit_id"], ["document_entity_links", "link_id"]] as const) {
  const types = q<{ t: string }>(`SELECT DISTINCT entity_type AS t FROM ${table}`).map((r) => r.t);
  for (const t of types) {
    const owner = POLY[t];
    if (!owner) continue; // asset / work_order point at systems outside this dataset
    fkChecked++;
    violation({
      id: `B.orphan.${table}.entity_id[${t}]`,
      title: `${table}.entity_id (entity_type=${t}) references an existing ${owner[0]}.${owner[1]}`,
      category: CAT_B,
      severity: "critical",
      sql: `SELECT t.${pk} || ' -> ' || t.entity_id AS id FROM ${table} t LEFT JOIN ${owner[0]} o ON o.${owner[1]} = t.entity_id WHERE t.entity_type = '${t}' AND o.${owner[1]} IS NULL`,
    });
  }
}

// Primary keys (first column of each table).
for (const table of store.tables) {
  const pk = tableCols.get(table)![0];
  violation({
    id: `B.pk.${table}`,
    title: `${table}.${pk} is unique and not null`,
    category: "B. Key uniqueness",
    severity: "critical",
    sql: `SELECT COALESCE(${qi(pk)}, '<NULL>') AS id, COUNT(*) || ' rows' AS detail FROM ${table} GROUP BY ${qi(pk)} HAVING COUNT(*) > 1 OR ${qi(pk)} IS NULL`,
  });
}

// Duplicate business identifiers.
const DUP_CAT = "B. Duplicate business identifiers";
const dup = (id: string, title: string, table: string, expr: string, severity: Severity, where = "1=1", note?: string) =>
  violation({
    id: `B.dup.${id}`,
    title,
    category: DUP_CAT,
    severity,
    sql: `SELECT ${expr} AS id, COUNT(*) || ' rows' AS detail FROM ${table} WHERE ${where} GROUP BY ${expr} HAVING COUNT(*) > 1`,
    note,
  });
dup("vendor.gstin", "Vendor GSTIN-like values are unique", "vendor_master", "gstin_like", "major", "gstin_like IS NOT NULL");
dup("vendor.pan", "Vendor PAN-like values are unique", "vendor_master", "pan_like", "major", "pan_like IS NOT NULL");
dup("vendor.name", "Vendor company names are unique", "vendor_master", "lower(company_name)", "major");
dup("officer.email", "Officer e-mail addresses are unique", "employee_officer_master", "email", "minor", "email IS NOT NULL");
dup("document.sha256", "Document sha256 values are unique (identical bytes under different ids)", "document_metadata", "sha256", "minor");
dup("document.path", "Document relative_path values are unique", "document_metadata", "relative_path", "major");
dup("case.po_number", "A PO number belongs to one case", "procurement_cases", "po_number", "major", "po_number IS NOT NULL");
dup("case.contract_number", "A contract number belongs to one case", "procurement_cases", "contract_number", "major", "contract_number IS NOT NULL");
dup("case.tender_id", "A tender id is the live tender of at most one case", "procurement_cases", "tender_id", "major", "tender_id IS NOT NULL");
dup("case.requisition_id", "A requisition belongs to one case", "procurement_cases", "requisition_id", "major");
dup("po.award_id", "An award produces at most one PO", "purchase_orders", "award_id", "major", "award_id IS NOT NULL");
dup("contract.po_number", "A PO has at most one contract", "contract_master", "po_number", "major", "po_number IS NOT NULL");
dup("award.tender_id", "A tender has at most one award decision", "award_decisions", "tender_id", "major");
dup("submission.tender_vendor", "A vendor submits at most one bid per tender", "bidder_submissions", "tender_id || '|' || vendor_id", "major");
dup("tender_line.tender_lineno", "(tender_id, line_no) is unique", "tender_line_items", "tender_id || '|' || line_no", "major");
dup("milestone.po_no", "(po_number, milestone_no) is unique", "delivery_milestones", "po_number || '|' || milestone_no", "major");
dup("invoice.acceptance_id", "An acceptance certificate is invoiced at most once", "invoice_register", "acceptance_id", "major", "acceptance_id IS NOT NULL");
dup("dispatch.challan", "Challan references are unique", "dispatch_records", "challan_ref", "minor", "challan_ref IS NOT NULL");
dup("payment.invoice_date_amount", "No two payments of the same invoice share date and amount", "payment_register", "invoice_id || '|' || payment_date || '|' || amount", "minor");
dup("grn.receipt", "A receipt has at most one GRN", "goods_receipt_notes", "receipt_id", "major");
dup("inspection.receipt", "A receipt has at most one inspection record", "inspection_records", "receipt_id", "major", "receipt_id IS NOT NULL");
dup("requisition.case", "A case has one requisition", "requisitions", "case_id", "major");
dup("budget.requisition", "A requisition has at most one budget control row", "budget_controls", "requisition_id", "major");
dup("workflow.requisition", "A requisition has at most one approval workflow", "approval_workflow", "requisition_id", "major");
violation({
  id: "B.dup.approvals_vs_approval_history",
  title: "approvals and approval_history are different tables (not a row-for-row copy)",
  category: DUP_CAT,
  severity: "info",
  sql: `SELECT a.approval_id AS id FROM approvals a JOIN approval_history h ON h.approval_id = a.approval_id AND h.decision IS a.decision AND h.decision_date IS a.decision_date AND h.step_no = a.step_no AND h.approver_officer_id IS a.approver_officer_id`,
  note: "Every approvals row has an identical twin in approval_history, so approval volume is counted once (4,357), not twice.",
});

// Chain consistency of the case record with its children.
const chain = (id: string, title: string, sql: string, severity: Severity = "major", note?: string) =>
  violation({ id: `B.chain.${id}`, title, category: "B. Referential consistency", severity, sql, note });
chain("case_tender_case", "procurement_cases.tender_id points at a tender of the same case", `SELECT c.case_id AS id, c.tender_id AS detail FROM procurement_cases c JOIN tender_master t ON t.tender_id = c.tender_id WHERE t.case_id <> c.case_id`);
chain("case_tender_req", "case requisition equals live tender requisition", `SELECT c.case_id AS id FROM procurement_cases c JOIN tender_master t ON t.tender_id = c.tender_id WHERE t.requisition_id <> c.requisition_id`);
chain("case_po_tender", "PO of a case belongs to the case's live tender", `SELECT c.case_id AS id, c.po_number AS detail FROM procurement_cases c JOIN purchase_orders p ON p.po_number = c.po_number WHERE p.tender_id <> c.tender_id`);
chain("case_contract_po", "Contract of a case belongs to the case's PO", `SELECT c.case_id AS id FROM procurement_cases c JOIN contract_master k ON k.contract_number = c.contract_number WHERE k.po_number <> c.po_number`);
chain("requisition_case_back", "requisitions.case_id and procurement_cases.requisition_id agree", `SELECT r.requisition_id AS id FROM requisitions r JOIN procurement_cases c ON c.case_id = r.case_id WHERE c.requisition_id <> r.requisition_id`);
chain("doc_case_vs_tender", "document tender_id belongs to the document's case", `SELECT d.document_id AS id FROM document_metadata d JOIN tender_master t ON t.tender_id = d.tender_id WHERE t.case_id <> d.case_id`);
chain("doc_case_vs_po", "document po_number belongs to the document's case", `SELECT d.document_id AS id FROM document_metadata d JOIN procurement_cases c ON c.po_number = d.po_number WHERE c.case_id <> d.case_id`);
chain("po_without_case", "every purchase order is attached to a case", `SELECT p.po_number AS id FROM purchase_orders p LEFT JOIN procurement_cases c ON c.po_number = p.po_number WHERE c.case_id IS NULL`);
chain("contract_without_case", "every contract is attached to a case", `SELECT k.contract_number AS id FROM contract_master k LEFT JOIN procurement_cases c ON c.contract_number = k.contract_number WHERE c.case_id IS NULL`);
chain("tender_without_case_link", "every tender is the case's live tender or a superseded (re-tendered/cancelled) tender", `SELECT t.tender_id AS id FROM tender_master t WHERE NOT EXISTS (SELECT 1 FROM procurement_cases c WHERE c.tender_id = t.tender_id) AND t.status NOT IN ('Re-Tendered','Cancelled')`, "major");
chain("po_without_contract", "every PO has a contract", `SELECT p.po_number AS id, p.po_date AS detail FROM purchase_orders p LEFT JOIN contract_master k ON k.po_number = p.po_number WHERE k.contract_number IS NULL`, "minor", "The POs without a contract are dated within 4 days of the as-of date: contract signing is pending, not missing.");

/* ------------------------------------------------------------------ */
/* C. Lifecycle, timeline and financial consistency                    */
/* ------------------------------------------------------------------ */
const CAT_C = "C. Lifecycle and financial consistency";
const lc = (id: string, title: string, sql: string, severity: Severity = "major", note?: string) => violation({ id: `C.${id}`, title, category: CAT_C, severity, sql, note });

lc("tender_window", "Tender: publish date ≤ bid end ≤ bid opening", `SELECT tender_id AS id FROM tender_master WHERE publish_date > substr(bid_end_at,1,10) OR bid_end_at > bid_opening_at OR original_bid_end_at > bid_end_at`, "critical");
lc("req_before_tender", "Requisition date is not after tender publication", `SELECT t.tender_id AS id, r.requisition_date || ' > ' || t.publish_date AS detail FROM tender_master t JOIN requisitions r ON r.requisition_id = t.requisition_id WHERE r.requisition_date > t.publish_date`);
lc("award_after_opening", "Award recommendation is not before bid opening; approval not before recommendation", `SELECT a.award_id AS id FROM award_decisions a JOIN tender_master t ON t.tender_id = a.tender_id WHERE a.recommended_date < substr(t.bid_opening_at,1,10) OR (a.approval_date IS NOT NULL AND a.approval_date < a.recommended_date)`);
lc("po_after_award", "PO date is not before award approval", `SELECT p.po_number AS id, p.po_date || ' < ' || a.approval_date AS detail FROM purchase_orders p JOIN award_decisions a ON a.award_id = p.award_id WHERE a.approval_date IS NOT NULL AND p.po_date < a.approval_date`);
lc("contract_after_po", "Contract start is not before PO date", `SELECT k.contract_number AS id FROM contract_master k JOIN purchase_orders p ON p.po_number = k.po_number WHERE k.start_date < p.po_date`);
lc("receipt_after_po", "Goods receipt is not before PO date", `SELECT r.receipt_id AS id FROM delivery_receipts r JOIN purchase_orders p ON p.po_number = r.po_number WHERE r.receipt_date < p.po_date`);
lc("inspection_after_receipt", "Inspection is not before the receipt it inspects", `SELECT i.inspection_id AS id FROM inspection_records i JOIN delivery_receipts r ON r.receipt_id = i.receipt_id WHERE i.inspection_date < r.receipt_date`);
lc("invoice_after_acceptance", "Invoice is not dated before its acceptance certificate", `SELECT i.invoice_id AS id, i.invoice_date || ' < ' || a.issue_date AS detail FROM invoice_register i JOIN acceptance_certificates a ON a.acceptance_id = i.acceptance_id WHERE i.invoice_date < a.issue_date`);
lc("payment_after_invoice", "Payment is not dated before its invoice", `SELECT p.payment_ref AS id FROM payment_register p JOIN invoice_register i ON i.invoice_id = p.invoice_id WHERE p.payment_date < i.invoice_date`);
lc("awarded_without_evaluation", "Awarded tender has technical evaluation history", `SELECT t.tender_id AS id FROM tender_master t WHERE t.status = 'Awarded' AND NOT EXISTS (SELECT 1 FROM technical_evaluations e WHERE e.tender_id = t.tender_id)`, "critical");
lc("po_without_approved_award", "PO traces to an approved award", `SELECT p.po_number AS id FROM purchase_orders p LEFT JOIN award_decisions a ON a.award_id = p.award_id WHERE a.award_id IS NULL OR a.approval_status <> 'Approved'`, "critical");
lc("po_vendor_vs_award", "PO vendor equals the awarded vendor", `SELECT p.po_number AS id FROM purchase_orders p JOIN award_decisions a ON a.award_id = p.award_id WHERE a.recommended_vendor_id <> p.vendor_id`, "critical");
lc("invoice_vendor_vs_po", "Invoice vendor equals PO vendor", `SELECT i.invoice_id AS id FROM invoice_register i JOIN purchase_orders p ON p.po_number = i.po_number WHERE i.vendor_id <> p.vendor_id`, "critical");
lc("accepted_over_ordered", "Accepted quantity does not exceed ordered quantity", `SELECT l.po_number AS id, ROUND(a.q,3) || ' accepted vs ' || ROUND(l.q,3) || ' ordered' AS detail FROM (SELECT po_number, SUM(quantity) AS q FROM purchase_order_line_items GROUP BY po_number) l JOIN (SELECT po_number, SUM(accepted_qty) AS q FROM acceptance_certificates GROUP BY po_number) a ON a.po_number = l.po_number WHERE a.q > l.q + 0.001`, "critical");
lc("received_over_ordered", "Goods received, net of rejected units, does not exceed ordered quantity", `SELECT l.po_number AS id, ROUND(g.q - COALESCE(j.q,0),3) || ' net received vs ' || ROUND(l.q,3) || ' ordered' AS detail FROM (SELECT po_number, SUM(quantity) AS q FROM purchase_order_line_items GROUP BY po_number) l JOIN (SELECT po_number, SUM(qty_received) AS q FROM delivery_receipts GROUP BY po_number) g ON g.po_number = l.po_number LEFT JOIN (SELECT po_number, SUM(qty_rejected) AS q FROM inspection_records GROUP BY po_number) j ON j.po_number = l.po_number WHERE g.q - COALESCE(j.q,0) > l.q + 0.001`, "major", "Gross receipts exceed the order on 217 POs, but in every case the surplus equals the rejected quantity re-supplied as a replacement lot and counted again in delivery_receipts. Net of rejections no PO is over-delivered.");
lc("payments_over_net", "Payments do not exceed invoice net payable", `SELECT i.invoice_id AS id FROM invoice_register i JOIN (SELECT invoice_id, SUM(amount) AS paid FROM payment_register GROUP BY invoice_id) p ON p.invoice_id = i.invoice_id WHERE p.paid > i.net_payable + 1`, "critical");
lc("invoice_total", "Invoice total = taxable + GST + other charges", `SELECT invoice_id AS id FROM invoice_register WHERE ABS(total_amount - (taxable_value + gst_value + other_charges)) > 1`);
lc("invoice_net", "Invoice net payable = total − deductions", `SELECT invoice_id AS id FROM invoice_register WHERE ABS(total_amount - deduction - net_payable) > 1`);
lc("invoice_outstanding", "Invoice outstanding = net payable − paid", `SELECT invoice_id AS id FROM invoice_register WHERE ABS(net_payable - amount_paid - outstanding_amount) > 1`);
lc("po_lines_total", "PO total value = sum of line totals", `SELECT p.po_number AS id FROM purchase_orders p JOIN (SELECT po_number, SUM(line_total) AS s FROM purchase_order_line_items GROUP BY po_number) l ON l.po_number = p.po_number WHERE ABS(p.total_value - l.s) > 1`);
lc("contract_vs_po", "Contract value equals PO value", `SELECT k.contract_number AS id FROM contract_master k JOIN purchase_orders p ON p.po_number = k.po_number WHERE ABS(k.contract_value - p.total_value) > 1`);
lc("po_vs_award", "PO value equals approved award value", `SELECT p.po_number AS id FROM purchase_orders p JOIN award_decisions a ON a.award_id = p.award_id WHERE ABS(p.total_value - a.approved_value) > 1`);
lc("approval_dates", "Approval decision is not dated before submission", `SELECT approval_id AS id FROM approvals WHERE decision_date IS NOT NULL AND decision_date < submitted_date`);
lc("approval_order", "Approval steps are submitted in step order", `SELECT a.approval_id AS id FROM approvals a JOIN approvals b ON b.requisition_id = a.requisition_id AND b.step_no = a.step_no - 1 WHERE a.submitted_date < b.submitted_date`, "minor");
lc("approval_after_reject", "No approval step is Approved after a Rejected step on the same requisition", `SELECT a.approval_id AS id FROM approvals a JOIN approvals r ON r.requisition_id = a.requisition_id AND r.decision = 'Rejected' AND r.step_no < a.step_no WHERE a.decision = 'Approved'`);
lc("closed_contract_outstanding", "Closed contracts have no outstanding invoice balance", `SELECT k.contract_number AS id FROM contract_master k JOIN invoice_register i ON i.po_number = k.po_number WHERE k.status = 'Closed' AND i.outstanding_amount > 1 GROUP BY k.contract_number`);

/* ------------------------------------------------------------------ */
/* D. Diversity                                                        */
/* ------------------------------------------------------------------ */
const diversity = {
  vendors_used_in_pos: num("SELECT COUNT(DISTINCT vendor_id) FROM purchase_orders"),
  vendors_bidding: num("SELECT COUNT(DISTINCT vendor_id) FROM bidder_submissions"),
  vendors_registered: num("SELECT COUNT(*) FROM vendor_master"),
  departments_in_cases: num("SELECT COUNT(DISTINCT department_id) FROM procurement_cases"),
  categories_in_cases: num("SELECT COUNT(DISTINCT category_id) FROM procurement_cases"),
  areas_in_cases: num("SELECT COUNT(DISTINCT area_id) FROM procurement_cases"),
  mines_in_cases: num("SELECT COUNT(DISTINCT mine_id) FROM procurement_cases"),
  top5_vendor_share_of_po_value_pct: round((num("SELECT SUM(v) FROM (SELECT SUM(total_value) AS v FROM purchase_orders GROUP BY vendor_id ORDER BY v DESC LIMIT 5)") / num("SELECT SUM(total_value) FROM purchase_orders")) * 100, 1),
  bids_per_tender: q<{ bids: number; tenders: number }>("SELECT n AS bids, COUNT(*) AS tenders FROM (SELECT tender_id, COUNT(*) AS n FROM bidder_submissions GROUP BY tender_id) GROUP BY n ORDER BY n"),
  case_value_bands: q<{ band: string; cases: number }>("SELECT CASE WHEN estimated_value < 100000 THEN '<1L' WHEN estimated_value < 500000 THEN '1-5L' WHEN estimated_value < 2500000 THEN '5-25L' WHEN estimated_value < 5000000 THEN '25-50L' WHEN estimated_value < 10000000 THEN '50L-1Cr' WHEN estimated_value < 50000000 THEN '1-5Cr' ELSE '>5Cr' END AS band, COUNT(*) AS cases FROM procurement_cases GROUP BY 1"),
  procurement_types: q<{ procurement_type: string; cases: number }>("SELECT procurement_type, COUNT(*) AS cases FROM procurement_cases GROUP BY 1"),
};
manual({ id: "D.diversity.vendor_concentration", title: `Top-5 vendors hold ${diversity.top5_vendor_share_of_po_value_pct}% of PO value`, category: "D. Diversity", severity: "info", count: diversity.top5_vendor_share_of_po_value_pct as number, sql: "SUM(total_value) of top-5 vendors / total", status: "pass" });
manual({ id: "D.diversity.vendor_use", title: `${diversity.vendors_used_in_pos} of ${diversity.vendors_registered} registered vendors hold a PO; ${diversity.vendors_bidding} have bid`, category: "D. Diversity", severity: "info", count: diversity.vendors_used_in_pos, sql: "COUNT(DISTINCT vendor_id)", status: "pass" });

/* ------------------------------------------------------------------ */
/* E. Scenario coverage for the risk scenarios in the brief             */
/* ------------------------------------------------------------------ */
const scenarios: Scenario[] = [];
const OPEN_CASE = "current_status NOT IN ('Closed Case','Cancelled','Rejected')";

function scenario(spec: ScenarioSpec): Scenario {
  let ids: string[] = [];
  let details: string[] | undefined;
  let sql = "(computed in script)";
  if (spec.sql) {
    sql = trim(spec.sql);
    const rows = q<{ id: string; detail?: string | null }>(sql);
    const seen = new Map<string, string | null>();
    for (const r of rows) if (!seen.has(String(r.id))) seen.set(String(r.id), r.detail ?? null);
    ids = [...seen.keys()];
    if ([...seen.values()].some((d) => d)) details = [...seen].map(([id, d]) => `${id}${d ? ` — ${d}` : ""}`);
  } else if (spec.compute) {
    const out = spec.compute();
    ids = out.ids;
    details = out.details;
  }
  const count = ids.length;
  const population = spec.populationSql ? num(spec.populationSql) : null;
  const ambiguous = spec.ambiguousSql ? num(spec.ambiguousSql) : null;
  const coverage: Coverage = count === 0 ? "absent" : count < 5 ? "thin" : "covered";
  const item: Scenario = {
    id: spec.id,
    group: spec.group,
    name: spec.name,
    unit: spec.unit,
    definition: spec.definition,
    count,
    coverage,
    sample: ids.slice(0, 5),
    sample_detail: details?.slice(0, 5),
    sql,
    population,
    clean: population === null ? null : Math.max(population - count, 0),
    abnormal: count,
    ambiguous,
    ambiguous_note: spec.ambiguousNote ?? "",
    judgement: spec.judgement,
    generate: coverage === "covered" ? undefined : spec.generate,
  };
  scenarios.push(item);
  return item;
}

const G_A = "A. Tender risks";
const G_B = "B. Vendor risks";
const G_C = "C. Bid risks";
const G_D = "D. Contract risks";
const G_E = "E. Financial risks";
const G_F = "F. Governance risks";

scenario({ id: "A1", group: G_A, name: "Tender published with incomplete specifications", unit: "tenders", definition: "Tender whose requisition has no technical_specifications rows", sql: `SELECT t.tender_id AS id FROM tender_master t WHERE NOT EXISTS (SELECT 1 FROM technical_specifications s WHERE s.requisition_id = t.requisition_id)`, populationSql: "SELECT COUNT(*) FROM tender_master", judgement: "Every tender carries specifications. Incompleteness (a thin or empty specification) is not modelled.", generate: { records: 30, tables: "technical_specifications (remove or truncate parameter rows), tender_master flags, BID PDFs with a thin specification annexure" } });
scenario({ id: "A2", group: G_A, name: "Unusually restrictive eligibility conditions", unit: "tenders", definition: "Minimum average turnover above 3× the tender estimate", sql: `SELECT tender_id AS id, ROUND(min_avg_turnover/estimated_value,1) || '× estimate' AS detail FROM tender_master WHERE min_avg_turnover > 3 * estimated_value`, populationSql: "SELECT COUNT(*) FROM tender_master WHERE min_avg_turnover IS NOT NULL", judgement: "A turnover requirement far above contract size can narrow competition but may also be legitimate for risky supply; it is an indicator, not a finding.", generate: { records: 25, tables: "tender_master, tender_eligibility_criteria (+ EXTRA restrictive criteria), BID PDFs" } });
scenario({ id: "A3", group: G_A, name: "Conflicting eligibility clauses", unit: "tenders", definition: "Not detectable: no field records clause-level conflicts", compute: () => ({ ids: [] }), judgement: "Not modelled. Needs eligibility criteria that contradict each other or the corrigenda (for example turnover stated differently in two places).", generate: { records: 20, tables: "tender_eligibility_criteria with contradictory rows, BID/COR PDFs with conflicting text" } });
scenario({ id: "A4", group: G_A, name: "Tender published without an approval record", unit: "tenders", definition: "Tender whose requisition has no approvals rows", sql: `SELECT t.tender_id AS id FROM tender_master t WHERE NOT EXISTS (SELECT 1 FROM approvals a WHERE a.requisition_id = t.requisition_id)`, populationSql: "SELECT COUNT(*) FROM tender_master", judgement: "Missing approval trails are not generated; this is the central audit scenario for the brief.", generate: { records: 30, tables: "approvals (delete steps for selected requisitions) with matching APR PDFs missing" } });
scenario({ id: "A5", group: G_A, name: "Repeated corrigenda (2 or more)", unit: "tenders", definition: "Tender with at least two corrigenda", sql: `SELECT tender_id AS id, COUNT(*) || ' corrigenda' AS detail FROM tender_corrigenda GROUP BY tender_id HAVING COUNT(*) >= 2`, populationSql: "SELECT COUNT(DISTINCT tender_id) FROM tender_corrigenda", judgement: "Each tender has at most one corrigendum in this data, so 'repeated corrigenda' questions have no positive examples.", generate: { records: 40, tables: "tender_corrigenda (versions 2→3→4), tender_master.current_version, COR PDFs and revised BID PDFs" } });
scenario({ id: "A6", group: G_A, name: "Bid deadline extended", unit: "tenders", definition: "tender_master.extended = true", sql: `SELECT tender_id AS id FROM tender_master WHERE extended = 'true'`, populationSql: "SELECT COUNT(*) FROM tender_master", judgement: "Well covered, with matching deadline corrigenda." });
scenario({ id: "A7", group: G_A, name: "Inconsistent estimated values", unit: "tenders", definition: "Tender estimate differs from the requisition estimate by more than 1%", sql: `SELECT t.tender_id AS id, ROUND(t.estimated_value) || ' vs ' || ROUND(r.estimated_value) AS detail FROM tender_master t JOIN requisitions r ON r.requisition_id = t.requisition_id WHERE ABS(t.estimated_value - r.estimated_value) > 0.01 * r.estimated_value`, populationSql: "SELECT COUNT(*) FROM tender_master", judgement: "Estimates are consistent by construction; no deliberate inconsistency exists.", generate: { records: 25, tables: "tender_master.estimated_value or requisitions.estimated_value altered, BID/PR PDFs showing both" } });
scenario({ id: "A8", group: G_A, name: "Unusually short submission window (< 7 days)", unit: "tenders", definition: "Days from publication to bid end below 7", sql: `SELECT tender_id AS id, CAST(julianday(substr(bid_end_at,1,10)) - julianday(publish_date) AS INTEGER) || ' days' AS detail FROM tender_master WHERE status <> 'Cancelled' AND julianday(substr(bid_end_at,1,10)) - julianday(publish_date) < 7`, populationSql: "SELECT COUNT(*) FROM tender_master", judgement: "Policy minimum is 10 days; short windows appear only through the generator's emergency route.", generate: { records: 15, tables: "tender_master (shorter windows), tender_milestones, BID PDFs" } });
scenario({ id: "A9", group: G_A, name: "Missing budget linkage", unit: "requisitions", definition: "Requisition with a tender but no budget_controls row", sql: `SELECT r.requisition_id AS id FROM requisitions r JOIN tender_master t ON t.requisition_id = r.requisition_id WHERE NOT EXISTS (SELECT 1 FROM budget_controls b WHERE b.requisition_id = r.requisition_id)`, populationSql: "SELECT COUNT(*) FROM requisitions", judgement: "Every requisition has a budget certificate.", generate: { records: 25, tables: "budget_controls (remove rows), APR PDFs without the budget certificate" } });

scenario({ id: "B1", group: G_B, name: "Vendor repeatedly failing technical evaluation (3+)", unit: "vendors", definition: "Vendor with at least 3 Technically Disqualified results", sql: `SELECT vendor_id AS id, COUNT(*) || ' failures' AS detail FROM technical_evaluations WHERE result = 'Technically Disqualified' GROUP BY vendor_id HAVING COUNT(*) >= 3`, populationSql: "SELECT COUNT(DISTINCT vendor_id) FROM technical_evaluations", judgement: "Well covered." });
scenario({ id: "B2", group: G_B, name: "Vendor winning several high-value tenders (3+ awards ≥ ₹1 crore)", unit: "vendors", definition: "Vendor with at least 3 approved awards of ₹1 crore or more", sql: `SELECT recommended_vendor_id AS id, COUNT(*) || ' awards' AS detail FROM award_decisions WHERE approval_status = 'Approved' AND approved_value >= 10000000 GROUP BY recommended_vendor_id HAVING COUNT(*) >= 3`, populationSql: "SELECT COUNT(DISTINCT recommended_vendor_id) FROM award_decisions", judgement: "Natural concentration exists; whether it is suspicious is a human judgement." });
scenario({ id: "B3", group: G_B, name: "Repeated delivery delays (5+ late milestones)", unit: "vendors", definition: "Vendor with at least 5 late delivery milestones", sql: `SELECT p.vendor_id AS id, COUNT(*) || ' late' AS detail FROM delivery_milestones m JOIN purchase_orders p ON p.po_number = m.po_number WHERE m.milestone_type = 'Delivery' AND (m.delay_days > 0 OR (m.actual_date IS NULL AND m.planned_date < '${ASOF}')) GROUP BY p.vendor_id HAVING COUNT(*) >= 5`, populationSql: "SELECT COUNT(DISTINCT vendor_id) FROM purchase_orders", judgement: "Well covered." });
scenario({ id: "B4", group: G_B, name: "Quality rejections (3+ inspections with rejection)", unit: "vendors", definition: "Vendor with at least 3 inspections that rejected quantity", sql: `SELECT p.vendor_id AS id, COUNT(*) || ' inspections' AS detail FROM inspection_records i JOIN purchase_orders p ON p.po_number = i.po_number WHERE i.qty_rejected > 0 GROUP BY p.vendor_id HAVING COUNT(*) >= 3`, populationSql: "SELECT COUNT(DISTINCT vendor_id) FROM purchase_orders", judgement: "Well covered." });
scenario({ id: "B5", group: G_B, name: "Contract termination", unit: "contracts", definition: "Contract status Terminated/Cancelled/Foreclosed", sql: `SELECT contract_number AS id FROM contract_master WHERE status IN ('Terminated','Cancelled','Foreclosed')`, judgement: "Contract statuses are only Active, Extended and Closed. Termination does not exist in the data.", generate: { records: 20, tables: "contract_master.status, contract_closure (termination reason), PO/CON PDFs and a termination notice document type" } });
scenario({ id: "B6", group: G_B, name: "Financial exposure concentration (vendor ≥ 5% of PO value)", unit: "vendors", definition: "Vendor share of total PO value of at least 5%", sql: `SELECT vendor_id AS id, ROUND(100.0*SUM(total_value)/(SELECT SUM(total_value) FROM purchase_orders),1) || '%' AS detail FROM purchase_orders GROUP BY vendor_id HAVING SUM(total_value) >= 0.05*(SELECT SUM(total_value) FROM purchase_orders)`, judgement: "Concentration is spread across many vendors, so few pass 5%.", generate: { records: 6, tables: "purchase_orders, contract_master for two dominant vendors" } });
scenario({ id: "B7", group: G_B, name: "Incomplete vendor documentation (3+ incomplete bids)", unit: "vendors", definition: "Vendor with at least 3 submissions with documents_complete = false or status Incomplete", sql: `SELECT vendor_id AS id, COUNT(*) || ' bids' AS detail FROM bidder_submissions WHERE documents_complete = 'false' OR submission_status = 'Incomplete' GROUP BY vendor_id HAVING COUNT(*) >= 3`, judgement: "Covered." });
scenario({ id: "B8", group: G_B, name: "Similar vendor identities needing investigation", unit: "vendor groups", definition: "Vendors sharing the same first two name words or the same registered address", compute: () => {
  const vendors = q<{ vendor_id: string; company_name: string; registered_address: string }>("SELECT vendor_id, company_name, registered_address FROM vendor_master");
  const groups = new Map<string, string[]>();
  for (const v of vendors) {
    const core = v.company_name.toLowerCase().replace(/[^a-z ]/g, "").split(/\s+/).slice(0, 2).join(" ");
    for (const key of [`name:${core}`, `addr:${v.registered_address}`]) groups.set(key, [...(groups.get(key) ?? []), v.vendor_id]);
  }
  const hits = [...groups.entries()].filter(([, ids]) => ids.length > 1);
  return { ids: hits.map(([k]) => k), details: hits.map(([k, ids]) => `${k} → ${ids.join(", ")}`) };
}, judgement: "Vendor names and addresses are unique by construction, so look-alike identities are not modelled.", generate: { records: 20, tables: "vendor_master (near-duplicate names, shared address, similar PAN-like ids)" } });

scenario({ id: "C1", group: G_C, name: "Single-bid participation", unit: "tenders", definition: "Tender with exactly one submission", sql: `SELECT tender_id AS id FROM bidder_submissions GROUP BY tender_id HAVING COUNT(*) = 1`, populationSql: "SELECT COUNT(DISTINCT tender_id) FROM bidder_submissions", judgement: "Well covered." });
scenario({ id: "C2", group: G_C, name: "Large bid price deviation (> ±30% from estimate)", unit: "bids", definition: "financial_evaluations.quoted_vs_estimate_pct beyond ±30", sql: `SELECT submission_id AS id, quoted_vs_estimate_pct || '%' AS detail FROM financial_evaluations WHERE ABS(quoted_vs_estimate_pct) > 30`, populationSql: "SELECT COUNT(*) FROM financial_evaluations", judgement: "Prices cluster near the estimate; large deviations are rare.", generate: { records: 60, tables: "financial_quotes, financial_evaluations, comparative_statements (extreme high and low quotes), SUB PDFs" } });
scenario({ id: "C3", group: G_C, name: "Suspiciously similar bid patterns", unit: "tender pairs", definition: "Two bids in one tender within 0.5% of each other from different vendors", sql: `SELECT a.tender_id AS id, a.vendor_id || ' / ' || b.vendor_id AS detail FROM financial_evaluations a JOIN financial_evaluations b ON b.tender_id = a.tender_id AND b.vendor_id > a.vendor_id WHERE ABS(a.quoted_total - b.quoted_total) <= 0.005 * a.quoted_total`, judgement: "Many matches, but quotes cluster near the estimate so near-equality is expected by chance. These are ambiguous; no designed collusion or bid-rigging pattern exists.", ambiguousNote: "Treat as noise: a designed pattern would use identical unit prices or proportional quotes across vendors.", generate: { records: 30, tables: "financial_quotes (identical or proportional unit prices across vendors), SUB PDFs sharing wording" } });
scenario({ id: "C4", group: G_C, name: "Missing bid documents", unit: "documents", definition: "bidder_document_checklist rows not provided or expired", sql: `SELECT checklist_id AS id FROM bidder_document_checklist WHERE validity <> 'Valid'`, judgement: "Covered." });
scenario({ id: "C5", group: G_C, name: "Technical non-compliance", unit: "bids", definition: "Technically Disqualified evaluation results", sql: `SELECT tech_eval_id AS id FROM technical_evaluations WHERE result = 'Technically Disqualified'`, judgement: "Well covered, with stated reasons." });
scenario({ id: "C6", group: G_C, name: "L1 bidder failing eligibility", unit: "tenders", definition: "Cheapest quote belongs to a technically disqualified bidder", sql: `WITH m AS (SELECT tender_id, MIN(quoted_total) AS mn FROM financial_evaluations GROUP BY tender_id) SELECT f.tender_id AS id FROM financial_evaluations f JOIN m ON m.tender_id = f.tender_id AND f.quoted_total = m.mn WHERE f.technically_qualified = 'false'`, judgement: "Covered by the 'lowest not qualified' scenario." });
scenario({ id: "C7", group: G_C, name: "Inconsistent bid evaluation records", unit: "bids", definition: "financial_evaluations.technically_qualified disagrees with technical_evaluations.result", sql: `SELECT f.submission_id AS id FROM financial_evaluations f JOIN technical_evaluations e ON e.submission_id = f.submission_id WHERE (f.technically_qualified = 'true') <> (e.result = 'Technically Qualified')`, judgement: "Evaluation records are internally consistent.", generate: { records: 30, tables: "financial_evaluations or comparative_statements rank contradicting the technical result, EVAL PDFs" } });

scenario({ id: "D1", group: G_D, name: "PO issued with an incomplete approval trail", unit: "POs", definition: "PO above ₹5 lakh whose requisition has fewer than 3 approved steps", sql: `SELECT p.po_number AS id FROM purchase_orders p JOIN requisitions r ON r.requisition_id = p.requisition_id WHERE r.estimated_value > 500000 AND (SELECT COUNT(*) FROM approvals a WHERE a.requisition_id = r.requisition_id AND a.decision = 'Approved') < 3`, populationSql: "SELECT COUNT(*) FROM purchase_orders", ambiguousSql: "SELECT COUNT(*) FROM purchase_orders p JOIN requisitions r ON r.requisition_id = p.requisition_id WHERE r.estimated_value <= 500000 AND (SELECT COUNT(*) FROM approvals a WHERE a.requisition_id = r.requisition_id AND a.decision = 'Approved') < 3", ambiguousNote: "122 POs, all at or below ₹5 lakh, have fewer than three approved steps. Approval depth appears to follow value, so these are ambiguous (consistent with delegation by value) rather than bypasses.", judgement: "Above ₹5 lakh every PO has at least three approved steps. Low-value POs with shorter trails exist and are ambiguous.", generate: { records: 40, tables: "approvals (missing or non-approved steps) for requisitions with POs, matching APR PDFs" } });
scenario({ id: "D2", group: G_D, name: "Contract amount differing from award amount", unit: "contracts", definition: "Contract value differs from approved award value by more than ₹1", sql: `SELECT k.contract_number AS id FROM contract_master k JOIN purchase_orders p ON p.po_number = k.po_number JOIN award_decisions a ON a.award_id = p.award_id WHERE ABS(k.contract_value - a.approved_value) > 1`, judgement: "Amounts agree by construction.", generate: { records: 30, tables: "contract_master.contract_value or purchase_orders.total_value altered, PO PDFs showing both" } });
scenario({ id: "D3", group: G_D, name: "Repeated contract extensions (2+)", unit: "contracts", definition: "Contract with at least 2 variations", sql: `SELECT contract_number AS id FROM contract_variations GROUP BY contract_number HAVING COUNT(*) >= 2`, judgement: "At most one amendment per contract exists.", generate: { records: 40, tables: "contract_variations (second and third extensions), contract_master.end_date" } });
scenario({ id: "D4", group: G_D, name: "Delivery overdue", unit: "milestones", definition: "Late or open-past-plan delivery milestones", sql: `SELECT milestone_id AS id FROM delivery_milestones WHERE delay_days > 0 OR (actual_date IS NULL AND planned_date < '${ASOF}')`, judgement: "Well covered." });
scenario({ id: "D5", group: G_D, name: "Partial delivery", unit: "milestones", definition: "Milestone status Partially Delivered", sql: `SELECT milestone_id AS id FROM delivery_milestones WHERE status = 'Partially Delivered'`, judgement: "Well covered." });
scenario({ id: "D6", group: G_D, name: "Excess delivery (net of rejected replacement lots)", unit: "POs", definition: "Received quantity minus rejected quantity above ordered quantity", sql: `SELECT l.po_number AS id FROM (SELECT po_number, SUM(quantity) AS q FROM purchase_order_line_items GROUP BY po_number) l JOIN (SELECT po_number, SUM(qty_received) AS q FROM delivery_receipts GROUP BY po_number) g ON g.po_number = l.po_number LEFT JOIN (SELECT po_number, SUM(qty_rejected) AS q FROM inspection_records GROUP BY po_number) j ON j.po_number = l.po_number WHERE g.q - COALESCE(j.q,0) > l.q + 0.001`, judgement: "Gross receipts exceed the order on 217 POs, but only because rejected units are re-supplied and received again; net of rejections nothing is over-delivered. A genuine excess-delivery scenario does not exist.", generate: { records: 30, tables: "delivery_receipts, goods_receipt_notes, dispatch_records exceeding ordered quantity (with and without a contract variation), DLV PDFs" } });
scenario({ id: "D7", group: G_D, name: "Quality rejection", unit: "inspections", definition: "Inspections with rejected quantity", sql: `SELECT inspection_id AS id FROM inspection_records WHERE qty_rejected > 0`, judgement: "Well covered." });
scenario({ id: "D8", group: G_D, name: "Pending inspection", unit: "receipts", definition: "Receipt older than 7 days with no inspection", sql: `SELECT r.receipt_id AS id FROM delivery_receipts r WHERE r.receipt_id NOT IN (SELECT receipt_id FROM inspection_records) AND julianday('${ASOF}') - julianday(r.receipt_date) > 7`, judgement: "Recent receipts are awaiting inspection, but none older than a week.", generate: { records: 25, tables: "delivery_receipts without inspection_records, missing DLV inspection pages" } });
scenario({ id: "D9", group: G_D, name: "Contract approaching expiry (within 60 days)", unit: "contracts", definition: "Active or extended contract ending within 60 days of the as-of date", sql: `SELECT contract_number AS id FROM contract_master WHERE status IN ('Active','Extended') AND end_date BETWEEN '${ASOF}' AND date('${ASOF}','+60 day')`, judgement: "Well covered." });

scenario({ id: "E1", group: G_E, name: "Invoice pending beyond payment terms (> 30 days overdue)", unit: "invoices", definition: "Outstanding balance with due date more than 30 days before the as-of date", sql: `SELECT invoice_id AS id FROM invoice_register WHERE outstanding_amount > 1 AND julianday('${ASOF}') - julianday(payment_due_date) > 30`, judgement: "Only four invoices are more than 30 days overdue.", generate: { records: 40, tables: "invoice_register, outstanding_payments, INV/PAY PDFs with older due dates" } });
scenario({ id: "E2", group: G_E, name: "Payment without verified invoice", unit: "payments", definition: "Payment against an invoice whose verification_status is not Verified", sql: `SELECT p.payment_ref AS id FROM payment_register p JOIN invoice_register i ON i.invoice_id = p.invoice_id WHERE i.verification_status <> 'Verified'`, judgement: "Payments follow verification.", generate: { records: 30, tables: "payment_register, invoice_verification (missing or later), PAY PDFs without the verification page" } });
scenario({ id: "E3", group: G_E, name: "Duplicate invoice indicators", unit: "invoice groups", definition: "Invoices sharing vendor, PO and amount", sql: `SELECT vendor_id || '/' || po_number AS id, COUNT(*) || ' invoices' AS detail FROM invoice_register GROUP BY vendor_id, po_number, ROUND(total_amount,2) HAVING COUNT(*) > 1`, judgement: "Matches occur because staged deliveries produce equal instalments, so these are ambiguous: most are probably not duplicates. No deliberate duplicates exist.", ambiguousNote: "Equal instalments against one PO are normal; treat every match as needing review.", generate: { records: 30, tables: "invoice_register, invoice_line_items with true duplicates (same invoice number or resubmitted), INV PDFs" } });
scenario({ id: "E4", group: G_E, name: "Invoice and GRN quantity mismatch", unit: "POs", definition: "Invoiced quantity above goods received", sql: `SELECT i.po_number AS id FROM (SELECT po_number, SUM(accepted_qty) AS q FROM invoice_register GROUP BY po_number) i JOIN (SELECT po_number, SUM(qty_received) AS q FROM delivery_receipts GROUP BY po_number) g ON g.po_number = i.po_number WHERE i.q > g.q + 0.001`, judgement: "Invoices reconcile to receipts.", generate: { records: 40, tables: "invoice_register.accepted_qty above GRN/acceptance, INV PDFs" } });
scenario({ id: "E5", group: G_E, name: "Budget overrun", unit: "budget certificates", definition: "available_after below zero or status Augmentation required", sql: `SELECT budget_control_id AS id FROM budget_controls WHERE available_after < 0 OR status = 'Augmentation required'`, judgement: "Only six certificates are flagged, which is enough for a demonstration but thin for testing.", generate: { records: 40, tables: "budget_controls, APR PDFs showing shortfall" } });
scenario({ id: "E6", group: G_E, name: "Incorrect tax calculation", unit: "invoices", definition: "Invoice total ≠ taxable + GST + other charges", sql: `SELECT invoice_id AS id FROM invoice_register WHERE ABS(total_amount - (taxable_value + gst_value + other_charges)) > 1`, judgement: "Arithmetic is consistent everywhere.", generate: { records: 30, tables: "invoice_register, invoice_line_items with wrong GST, INV PDFs" } });
scenario({ id: "E7", group: G_E, name: "Advance payment needing reconciliation", unit: "payments", definition: "Payment before any acceptance certificate for the PO", sql: `SELECT p.payment_ref AS id FROM payment_register p WHERE NOT EXISTS (SELECT 1 FROM acceptance_certificates a WHERE a.po_number = p.po_number AND a.issue_date <= p.payment_date)`, judgement: "Payment modes are NEFT, RTGS and e-Payment only; advances are not modelled.", generate: { records: 25, tables: "payment_register (payment_mode Advance, before acceptance), PAY PDFs, reconciliation records" } });
scenario({ id: "E8", group: G_E, name: "Multiple invoices against a contract", unit: "contracts", definition: "Two or more invoices on one PO", sql: `SELECT po_number AS id, COUNT(*) || ' invoices' AS detail FROM invoice_register GROUP BY po_number HAVING COUNT(*) >= 2`, judgement: "Well covered." });

scenario({ id: "F1", group: G_F, name: "Same officer requested and approved", unit: "approval steps", definition: "Approver equals the requisition's requesting officer on an Approved step", sql: `SELECT a.approval_id AS id, a.approver_officer_id AS detail FROM approvals a JOIN requisitions r ON r.requisition_id = a.requisition_id WHERE a.approver_officer_id = r.requesting_officer_id AND a.decision = 'Approved'`, populationSql: "SELECT COUNT(*) FROM approvals WHERE decision = 'Approved'", ambiguousNote: "About 15% of approved steps match, which is far above what a control environment would show; it most likely reflects how the generator picks approvers within a department, not a designed scenario. Treat the frequency as a possible artefact.", judgement: "Present at scale, but the volume suggests an artefact rather than a deliberate scenario; rare, clearly designed SoD cases are absent." });
scenario({ id: "F2", group: G_F, name: "Buyer also approved the award", unit: "awards", definition: "tender buyer_officer_id equals award approved_by", sql: `SELECT a.award_id AS id FROM award_decisions a JOIN tender_master t ON t.tender_id = a.tender_id WHERE t.buyer_officer_id = a.approved_by`, judgement: "None.", generate: { records: 20, tables: "award_decisions.approved_by set to the tender buyer, AWD PDFs" } });
scenario({ id: "F3", group: G_F, name: "Approval bypass (PO without Competent Authority approval)", unit: "POs", definition: "PO whose requisition has no approved Competent Authority step", sql: `SELECT p.po_number AS id FROM purchase_orders p JOIN requisitions r ON r.requisition_id = p.requisition_id WHERE r.estimated_value > 500000 AND NOT EXISTS (SELECT 1 FROM approvals a WHERE a.requisition_id = p.requisition_id AND a.stage = 'Competent Authority' AND a.decision = 'Approved')`, populationSql: "SELECT COUNT(*) FROM purchase_orders", ambiguousNote: "Low-value POs (≤ ₹5 lakh) skip the Competent Authority step, consistent with delegation by value.", judgement: "Not generated above ₹5 lakh.", generate: { records: 30, tables: "approvals (Competent Authority step removed or not approved) for requisitions with POs" } });
scenario({ id: "F4", group: G_F, name: "Unauthorized status changes", unit: "events", definition: "Not detectable: events carry an actor but no authority rules", compute: () => ({ ids: [] }), judgement: "Not modelled.", generate: { records: 40, tables: "procurement_audit_events with actors lacking authority or department, with documented exceptions" } });
scenario({ id: "F5", group: G_F, name: "Missing document versions", unit: "tenders", definition: "Tender with a corrigendum but no revised BID version (version 2)", sql: `SELECT c.tender_id AS id FROM (SELECT DISTINCT tender_id FROM tender_corrigenda) c WHERE NOT EXISTS (SELECT 1 FROM document_metadata d WHERE d.tender_id = c.tender_id AND d.doc_type = 'BID' AND d.version > 1)`, judgement: "Every corrigendum has a revised document.", generate: { records: 25, tables: "document_metadata/PDFs with a corrigendum but no revised tender version" } });
scenario({ id: "F6", group: G_F, name: "Inconsistent audit trail", unit: "cases", definition: "Status events out of chronological order for a case", sql: `SELECT DISTINCT a.case_id AS id FROM procurement_audit_events a JOIN procurement_audit_events b ON b.case_id = a.case_id AND b.audit_id < a.audit_id AND b.event_at > a.event_at`, judgement: "Audit trail is chronological.", generate: { records: 30, tables: "procurement_audit_events with gaps, reordered or contradictory transitions" } });
scenario({ id: "F7", group: G_F, name: "Delayed approvals (more than 14 days)", unit: "approval steps", definition: "Approval with recorded delay above 14 days", sql: `SELECT approval_id AS id, delay_days || ' days' AS detail FROM approvals WHERE delay_days > 14`, judgement: "Well covered." });
scenario({ id: "F8", group: G_F, name: "Conflicting approval records", unit: "requisitions", definition: "A requisition with both a Rejected step and a later Approved step", sql: `SELECT DISTINCT a.requisition_id AS id FROM approvals a JOIN approvals r ON r.requisition_id = a.requisition_id AND r.decision = 'Rejected' AND r.step_no < a.step_no WHERE a.decision = 'Approved'`, judgement: "Not generated.", generate: { records: 25, tables: "approvals with contradictory decisions across steps, APR PDFs" } });

/* ------------------------------------------------------------------ */
/* F. Document linkage                                                 */
/* ------------------------------------------------------------------ */
const CAT_F = "F. Document linkage";
const dl = (id: string, title: string, sql: string, severity: Severity = "major", note?: string) => violation({ id: `F.${id}`, title, category: CAT_F, severity, sql, note });
dl("doc_case", "Every document has a parent case", `SELECT d.document_id AS id FROM document_metadata d LEFT JOIN procurement_cases c ON c.case_id = d.case_id WHERE c.case_id IS NULL`, "critical");
dl("doc_tender", "Documents naming a tender point at an existing tender", `SELECT d.document_id AS id FROM document_metadata d LEFT JOIN tender_master t ON t.tender_id = d.tender_id WHERE d.tender_id IS NOT NULL AND t.tender_id IS NULL`, "critical");
dl("doc_po", "Documents naming a PO point at an existing PO", `SELECT d.document_id AS id FROM document_metadata d LEFT JOIN purchase_orders p ON p.po_number = d.po_number WHERE d.po_number IS NOT NULL AND p.po_number IS NULL`, "critical");
dl("tender_bid_doc", "Every tender has a bid document", `SELECT t.tender_id AS id FROM tender_master t WHERE NOT EXISTS (SELECT 1 FROM document_metadata d WHERE d.tender_id = t.tender_id AND d.doc_type = 'BID')`);
dl("po_doc", "Every PO has a PO document", `SELECT p.po_number AS id FROM purchase_orders p WHERE NOT EXISTS (SELECT 1 FROM document_metadata d WHERE d.po_number = p.po_number AND d.doc_type = 'PO')`);
dl("invoice_doc", "Every invoice appears in an invoice document", `SELECT i.invoice_id AS id FROM invoice_register i WHERE NOT EXISTS (SELECT 1 FROM document_entity_links l WHERE l.entity_type = 'invoice' AND l.entity_id = i.invoice_id)`, "minor");

const docRows = q<{ document_id: string; relative_path: string; sha256: string; doc_type: string }>("SELECT document_id, relative_path, sha256, doc_type FROM document_metadata ORDER BY document_id");
const missingFiles = docRows.filter((d) => !existsSync(path.join(datasetRoot, d.relative_path)));
manual({ id: "F.files_exist", title: "Every registered PDF exists on disk", category: CAT_F, severity: "critical", count: missingFiles.length, sample: missingFiles.slice(0, 5).map((d) => d.document_id), sql: "fs.existsSync(dataset_root + relative_path) for all rows" });
const shaSample = docRows.filter((_, i) => i % Math.max(Math.floor(docRows.length / 300), 1) === 0).slice(0, 300);
const shaBad = shaSample.filter((d) => existsSync(path.join(datasetRoot, d.relative_path)) && createHash("sha256").update(readFileSync(path.join(datasetRoot, d.relative_path))).digest("hex") !== d.sha256);
manual({ id: "F.sha256_sample", title: `sha256 of ${shaSample.length} sampled PDFs matches the manifest`, category: CAT_F, severity: "major", count: shaBad.length, sample: shaBad.slice(0, 5).map((d) => d.document_id), sql: "sha256(file bytes) vs document_metadata.sha256 (sampled)" });

const textSample = docRows.filter((_, i) => i % Math.max(Math.floor(docRows.length / 40), 1) === 0).slice(0, 40);
let noText = 0;
const noTextIds: string[] = [];
async function sampleText() {
  for (const d of textSample) {
    const file = path.join(datasetRoot, d.relative_path);
    if (!existsSync(file)) continue;
    const pdf = await getDocumentProxy(new Uint8Array(readFileSync(file)));
    const { text } = await extractText(pdf, { mergePages: true });
    if (String(text).trim().length < 50) {
      noText++;
      noTextIds.push(d.document_id);
    }
  }
}

const byType = q<{ doc_type: string; documents: number }>("SELECT doc_type, COUNT(*) AS documents FROM document_metadata GROUP BY 1 ORDER BY 2 DESC");

/* ------------------------------------------------------------------ */
/* Output                                                              */
/* ------------------------------------------------------------------ */
async function main() {
  await sampleText();
  manual({ id: "F.text_layer", title: `PDFs in a ${textSample.length}-file sample all have an extractable text layer (none scanned)`, category: CAT_F, severity: "info", count: noText, sample: noTextIds, sql: "unpdf extractText on a stratified sample", note: "The corpus appears to be native-text PDFs only: scanned or image documents for OCR testing do not exist." });

  const bySeverity: Record<string, { pass: number; fail: number; warn: number }> = {};
  for (const c of checks) {
    const bucket = (bySeverity[c.severity] ??= { pass: 0, fail: 0, warn: 0 });
    bucket[c.status]++;
  }
  const failedCritical = checks.filter((c) => c.severity === "critical" && c.status === "fail");
  const coverageCounts = { covered: scenarios.filter((s) => s.coverage === "covered").length, thin: scenarios.filter((s) => s.coverage === "thin").length, absent: scenarios.filter((s) => s.coverage === "absent").length };
  const report = {
    synthetic: true,
    generated_at: new Date().toISOString(),
    dataset: { root: datasetRoot, as_of: ASOF, tables: store.tables.length },
    summary: { checks: checks.length, by_severity: bySeverity, failed_critical: failedCritical.map((c) => c.id), scenario_coverage: coverageCounts },
    volume,
    extra_volume: extraVolume,
    diversity,
    documents_by_type: byType,
    checks,
    scenarios,
    timings_ms: timings,
  };
  mkdirSync(outDir, { recursive: true });
  writeFileSync(path.join(outDir, "data-quality-report.json"), JSON.stringify(report, null, 1));

  const md: string[] = [];
  md.push("# Data quality and scenario coverage report", "", "> Synthetic dataset. Generated by `npm run audit:data`; the dataset is never modified. Counts are exact; \"covered / thin / absent\" is a judgement (≥5 / 1–4 / 0 matching records).", "");
  md.push(`As-of date ${ASOF}; ${store.tables.length} tables; ${checks.length} checks.`, "");
  md.push("## Headline", "");
  const failing = checks.filter((c) => c.status === "fail");
  md.push(`- Failed checks: **${failing.length}** (critical ${failedCritical.length}, major ${failing.filter((c) => c.severity === "major").length}). Warnings: ${checks.filter((c) => c.status === "warn").length}.`);
  md.push(`- Scenario coverage of the ${scenarios.length} risk scenarios in the brief: **${coverageCounts.covered} covered, ${coverageCounts.thin} thin, ${coverageCounts.absent} absent**.`, "");
  md.push("## Failed checks", "", "| Severity | Check | Count | Sample |", "|---|---|---:|---|");
  for (const c of failing) md.push(`| ${c.severity} | ${c.title} | ${c.count} | ${(c.sample_detail ?? c.sample).slice(0, 3).join("; ").replaceAll("|", "/")} |`);
  if (!failing.length) md.push("| – | none | 0 | |");
  md.push("", "## Volume against the reference and target figures", "", "| Entity | Actual | Reference (earlier prompt) | Target | % of target |", "|---|---:|---:|---:|---:|");
  for (const v of volume) md.push(`| ${v.entity} | ${fmt(v.actual)} | ${fmt(v.reference_actual)} | ${v.target_low === v.target_high ? fmt(v.target_low) : `${fmt(v.target_low)}–${fmt(v.target_high)}`} | ${v.pct_of_target_low}% |`);
  md.push("", "The reference figures came from an earlier prompt and do not describe this repository. Targets are aspirations, not defects.", "");
  md.push("## Scenario coverage", "", "| # | Scenario | Matches | Coverage | Judgement |", "|---|---|---:|---|---|");
  for (const s of scenarios) md.push(`| ${s.id} | ${s.name} | ${fmt(s.count)} | ${s.coverage} | ${s.judgement.replaceAll("|", "/")} |`);
  md.push("", "## Data to generate for thin and absent scenarios", "", "| # | Scenario | Suggested records | Tables and documents to add |", "|---|---|---:|---|");
  for (const s of scenarios.filter((x) => x.coverage !== "covered" && x.generate)) md.push(`| ${s.id} | ${s.name} | ${s.generate!.records} | ${s.generate!.tables} |`);
  md.push("", "Each generated scenario needs clean, abnormal and ambiguous examples, deterministic seeds, linked PDFs and a scenario label kept out of the data the AI can read.", "");
  md.push("## Diversity", "", `- Vendors holding a PO: ${diversity.vendors_used_in_pos} of ${diversity.vendors_registered}; vendors that bid: ${diversity.vendors_bidding}.`, `- Departments in cases: ${diversity.departments_in_cases}; categories: ${diversity.categories_in_cases}; areas: ${diversity.areas_in_cases}; mines: ${diversity.mines_in_cases}.`, `- Top-5 vendors hold ${diversity.top5_vendor_share_of_po_value_pct}% of PO value.`, "");
  md.push("## Documents", "", byType.map((t) => `${t.doc_type} ${fmt(t.documents)}`).join(" · "), "", `Text-layer check on ${textSample.length} sampled PDFs: ${noText} without text. The corpus is native-text PDFs; there are no scanned or image documents to test OCR.`, "");
  md.push("## All checks", "", "| Result | Severity | Category | Check | Count |", "|---|---|---|---|---:|");
  for (const c of checks) md.push(`| ${c.status} | ${c.severity} | ${c.category} | ${c.title.replaceAll("|", "/")} | ${fmt(c.count)} |`);
  writeFileSync(path.join(outDir, "DATA_QUALITY_REPORT.md"), md.join("\n") + "\n");
  console.log(`${checks.length} checks, ${failing.length} failed (${failedCritical.length} critical); scenarios: ${coverageCounts.covered} covered / ${coverageCounts.thin} thin / ${coverageCounts.absent} absent`);
  console.log(`Wrote ${path.join(outDir, "data-quality-report.json")} and DATA_QUALITY_REPORT.md`);
  if (failedCritical.length) process.exitCode = 1;
}

void main();
