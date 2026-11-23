import type {
  Chart,
  Column,
  DataTable,
  Kpi,
  ModuleView,
  RecordRow,
} from "../shared/types";
import { AUDIT_RULES } from "./audit-rules";
import { getScopedStore, getStore } from "./db";
import { requirePrincipal } from "./platform/context";
import { scopeKey } from "./platform/rbac";
import { ACTIVE } from "./drills";

export const q = (sql: string, params: Array<string | number | null> = []): RecordRow[] =>
  getScopedStore().query(sql, params);

/** Cache key that separates results by what the signed-in principal may see. */
export const currentScopeKey = (): string => scopeKey(requirePrincipal());

export function scalar(sql: string, params: Array<string | number | null> = []): number {
  const row = q(sql, params)[0];
  const value = row ? Object.values(row)[0] : 0;
  return typeof value === "number" ? value : Number(value) || 0;
}

export function table(
  title: string,
  columns: Column[],
  rows: RecordRow[],
  extra: Partial<DataTable> = {},
): DataTable {
  return { title, columns, rows, ...extra };
}

const OPEN_TENDER = `status IN ('Open for Bidding','Extended')`;
const FY_SQL = (column: string) =>
  `CASE WHEN CAST(substr(${column},6,2) AS INTEGER) >= 4
        THEN substr(${column},1,4) || '-' || substr(CAST(CAST(substr(${column},1,4) AS INTEGER) + 1 AS TEXT),3,2)
        ELSE CAST(CAST(substr(${column},1,4) AS INTEGER) - 1 AS TEXT) || '-' || substr(${column},3,2) END`;

function bars(
  title: string,
  rows: RecordRow[],
  options: Partial<Chart> & { drillPrefix?: string } = {},
): Chart {
  const { drillPrefix, ...chart } = options;
  return {
    title,
    kind: "bars",
    ...chart,
    data: rows.map((row) => ({
      label: String(row.label ?? "Unspecified"),
      value: Number(row.value) || 0,
      secondary: row.secondary === undefined || row.secondary === null ? undefined : Number(row.secondary),
      drill: drillPrefix ? `${drillPrefix}:${row.label}` : undefined,
    })),
  };
}

// ───────────────────────────── Overview ─────────────────────────────

function overview(): ModuleView {
  const asOf = getStore().asOf;
  const kpis: Kpi[] = [
    { label: "Procurement cases", value: scalar("SELECT COUNT(*) FROM procurement_cases"), fmt: "int", drill: "all" },
    { label: "Active cases", value: scalar(`SELECT COUNT(*) FROM procurement_cases WHERE ${ACTIVE}`), fmt: "int", drill: "active" },
    { label: "Tenders open for bidding", value: scalar(`SELECT COUNT(*) FROM tender_master WHERE ${OPEN_TENDER}`), fmt: "int", drill: "open_tenders" },
    {
      label: "Estimated value",
      value: scalar(`SELECT SUM(estimated_value) FROM procurement_cases WHERE current_status NOT IN ('Cancelled','Rejected')`),
      fmt: "money",
      hint: "Cases excluding cancelled and rejected",
    },
    { label: "Purchase order value", value: scalar("SELECT SUM(total_value) FROM purchase_orders"), fmt: "money", hint: "Includes taxes", drill: "contracts_active" },
    { label: "Paid to vendors", value: scalar("SELECT SUM(amount) FROM payment_register"), fmt: "money" },
    {
      label: "Outstanding payable",
      value: scalar("SELECT SUM(outstanding_amount) FROM invoice_register WHERE outstanding_amount > 0"),
      fmt: "money",
      tone: "warn",
      drill: "payables",
    },
    {
      label: "Active cases past SLA",
      value: scalar(`SELECT COUNT(*) FROM procurement_cases WHERE ${ACTIVE} AND delay_days > 0`),
      fmt: "int",
      tone: "warn",
      drill: "overdue_active",
    },
    {
      label: "High / critical risk",
      value: scalar("SELECT COUNT(*) FROM procurement_cases WHERE risk_category IN ('High','Critical')"),
      fmt: "int",
      tone: "bad",
      drill: "high_risk",
    },
    {
      label: "Open risk-register items",
      value: scalar("SELECT COUNT(*) FROM procurement_risk_register WHERE status = 'Open'"),
      fmt: "int",
      hint: `Exposure ₹${(scalar("SELECT SUM(exposure_amount) FROM procurement_risk_register WHERE status = 'Open'") / 1e7).toFixed(1)} crore`,
      drill: "open_risks",
    },
  ];

  const charts: Chart[] = [
    bars(
      "Cases by current lifecycle stage",
      q(`SELECT current_stage_name AS label, COUNT(*) AS value FROM procurement_cases
         GROUP BY current_stage_name ORDER BY MIN(current_stage)`),
      { fmt: "int", drillPrefix: "stage" },
    ),
    {
      title: "Estimated vs awarded value by month started",
      subtitle: "Last 24 months of requisitions",
      kind: "columns",
      fmt: "money",
      primaryLabel: "Estimated",
      secondaryLabel: "Awarded",
      data: (
        q(`SELECT substr(started_date,1,7) AS label, SUM(estimated_value) AS value, SUM(award_value) AS secondary
           FROM procurement_cases WHERE current_status NOT IN ('Cancelled','Rejected')
           GROUP BY 1 ORDER BY 1 DESC LIMIT 24`) as Array<{ label: string; value: number; secondary: number }>
      )
        .reverse()
        .map((row) => ({ label: row.label, value: row.value, secondary: row.secondary, drill: `month:${row.label}` })),
    },
    bars(
      "Paid to vendors by department",
      q(`SELECT p.department_name AS label, SUM(pay.amount) AS value
         FROM payment_register pay JOIN v_po p ON p.po_number = pay.po_number
         GROUP BY 1 ORDER BY 2 DESC LIMIT 10`),
      { fmt: "money", drillPrefix: "dept" },
    ),
    bars(
      "Purchase order value by category group",
      q(`SELECT p.category_group AS label, SUM(p.total_value) AS value FROM v_po p GROUP BY 1 ORDER BY 2 DESC`),
      { fmt: "money", drillPrefix: "group" },
    ),
  ];

  const attention = q(`SELECT case_id, title, department_name, current_status, risk_category, risk_score, delay_days, next_action
                       FROM v_case WHERE ${ACTIVE} ORDER BY risk_score DESC, delay_days DESC LIMIT 15`);

  return {
    id: "overview",
    title: "Executive procurement overview",
    summary: "Portfolio position across requisition, tender, award, delivery and payment.",
    asOf,
    kpis,
    charts,
    tables: [
      table(
        "Attention queue",
        [
          { key: "case_id", label: "Case" },
          { key: "title", label: "Requirement" },
          { key: "department_name", label: "Department" },
          { key: "current_status", label: "Status", fmt: "badge" },
          { key: "risk_category", label: "Risk", fmt: "badge" },
          { key: "risk_score", label: "Score", fmt: "num" },
          { key: "delay_days", label: "Delay", fmt: "days" },
          { key: "next_action", label: "Next action" },
        ],
        attention,
        { caseKey: "case_id", subtitle: "Active cases ranked by risk score, then delay" },
      ),
    ],
    notes: [
      "Every figure is computed from the loaded synthetic records; select a card or bar to see the underlying cases.",
      "Risk scores and categories are taken from the source risk register; they flag items for review and are not findings of wrongdoing.",
    ],
  };
}

// ───────────────────────────── Tenders ─────────────────────────────

function tenders(): ModuleView {
  const asOf = getStore().asOf;
  const bidderStats = q(`SELECT ROUND(AVG(bids_received),1) AS avg_bids FROM v_tender WHERE bids_received > 0`)[0];
  const kpis: Kpi[] = [
    { label: "Tenders published", value: scalar("SELECT COUNT(*) FROM tender_master"), fmt: "int" },
    { label: "Open for bidding", value: scalar(`SELECT COUNT(*) FROM tender_master WHERE ${OPEN_TENDER}`), fmt: "int", drill: "open_tenders" },
    {
      label: "Closing within 30 days",
      value: scalar(`SELECT COUNT(*) FROM tender_master WHERE ${OPEN_TENDER} AND substr(bid_end_at,1,10) BETWEEN {ASOF} AND date({ASOF},'+30 day')`),
      fmt: "int",
      tone: "warn",
      drill: "closing_30",
    },
    { label: "Amended by corrigendum", value: scalar("SELECT COUNT(DISTINCT tender_id) FROM tender_corrigenda"), fmt: "int", drill: "with_corrigenda" },
    { label: "Bid deadline extended", value: scalar("SELECT COUNT(*) FROM tender_master WHERE extended = 'true'"), fmt: "int" },
    { label: "Re-tendered", value: scalar("SELECT COUNT(*) FROM tender_master WHERE status = 'Re-Tendered'"), fmt: "int", drill: "retendered" },
    { label: "Single-bid tenders", value: scalar("SELECT COUNT(*) FROM v_tender WHERE bids_received = 1"), fmt: "int", tone: "warn", drill: "single_bid" },
    { label: "Average bids per tender", value: Number(bidderStats.avg_bids) || 0, fmt: "num", hint: "Tenders that received bids" },
  ];

  const charts: Chart[] = [
    bars(
      "Tenders by category group",
      q(`SELECT category_group AS label, COUNT(*) AS value FROM v_tender GROUP BY 1 ORDER BY 2 DESC`),
      { fmt: "int", drillPrefix: "group" },
    ),
    {
      title: "Tenders published per month",
      kind: "columns",
      fmt: "int",
      data: (
        q(`SELECT substr(publish_date,1,7) AS label, COUNT(*) AS value FROM tender_master GROUP BY 1 ORDER BY 1 DESC LIMIT 24`) as Array<{ label: string; value: number }>
      )
        .reverse()
        .map((row) => ({ label: row.label, value: row.value })),
    },
    bars(
      "Department-wise tender activity",
      q(`SELECT department_name AS label, COUNT(*) AS value FROM v_tender GROUP BY 1 ORDER BY 2 DESC LIMIT 10`),
      { fmt: "int", drillPrefix: "dept" },
    ),
    bars(
      "Corrigenda by change type",
      q(`SELECT change_type AS label, COUNT(*) AS value FROM tender_corrigenda GROUP BY 1 ORDER BY 2 DESC`),
      { fmt: "int" },
    ),
  ];

  const closing = q(`SELECT tender_id, case_id, title, category_name, department_name, substr(bid_end_at,1,16) AS bid_end,
                       CAST(julianday(substr(bid_end_at,1,10)) - julianday({ASOF}) AS INTEGER) AS days_left,
                       estimated_value, bids_received, extension_count, current_version
                     FROM v_tender WHERE ${OPEN_TENDER} ORDER BY bid_end_at LIMIT 40`);
  const amendments = q(`SELECT c.corrigendum_id, c.tender_id, t.case_id, c.version_from || ' → ' || c.version_to AS version,
                          c.issued_date, c.change_type, c.description, c.new_bid_end_at AS new_bid_end,
                          t.original_bid_end_at AS original_bid_end
                        FROM tender_corrigenda c JOIN tender_master t ON t.tender_id = c.tender_id
                        ORDER BY c.issued_date DESC LIMIT 40`);
  const duplicates = q(`SELECT a.tender_id AS tender_a, b.tender_id AS tender_b, a.case_id AS case_id,
                          a.title AS requirement_a, b.title AS requirement_b, a.category_name,
                          a.department_name, a.estimated_value AS value_a, b.estimated_value AS value_b,
                          CAST(ABS(julianday(a.publish_date) - julianday(b.publish_date)) AS INTEGER) AS days_apart
                        FROM v_tender a JOIN v_tender b
                          ON a.category_id = b.category_id AND a.department_id = b.department_id
                         AND a.tender_id < b.tender_id AND a.case_id <> b.case_id
                         AND ABS(a.estimated_value - b.estimated_value) <= 0.05 * a.estimated_value
                         AND ABS(julianday(a.publish_date) - julianday(b.publish_date)) <= 45
                         AND COALESCE(a.retender_of,'') <> b.tender_id AND COALESCE(b.retender_of,'') <> a.tender_id
                        ORDER BY days_apart, a.estimated_value DESC LIMIT 20`);
  const lineage = q(`SELECT t.tender_id AS retender_id, t.case_id, t.retender_of AS original_tender,
                       o.cancellation_reason AS original_reason, o.status AS original_status,
                       t.status AS current_status, t.estimated_value
                     FROM tender_master t JOIN tender_master o ON o.tender_id = t.retender_of
                     ORDER BY t.publish_date DESC LIMIT 25`);

  return {
    id: "tenders",
    title: "Tender discovery & document intelligence",
    summary: "Open tenders, closing dates, amendment history and tender-level duplicates or re-tenders.",
    asOf,
    kpis,
    charts,
    tables: [
      table(
        "Tenders closing next",
        [
          { key: "tender_id", label: "Tender" },
          { key: "title", label: "Requirement" },
          { key: "category_name", label: "Category" },
          { key: "department_name", label: "Department" },
          { key: "bid_end", label: "Bid end" },
          { key: "days_left", label: "Days left", fmt: "days" },
          { key: "estimated_value", label: "Estimated", fmt: "money" },
          { key: "bids_received", label: "Bids", fmt: "int" },
          { key: "extension_count", label: "Extensions", fmt: "int" },
          { key: "current_version", label: "Version", fmt: "int" },
        ],
        closing,
        { caseKey: "case_id", subtitle: "Open tenders by bid end date" },
      ),
      table(
        "Amendment tracker",
        [
          { key: "tender_id", label: "Tender" },
          { key: "version", label: "Version" },
          { key: "issued_date", label: "Issued", fmt: "date" },
          { key: "change_type", label: "Change", fmt: "badge" },
          { key: "description", label: "What changed" },
          { key: "original_bid_end", label: "Original bid end" },
          { key: "new_bid_end", label: "Revised bid end" },
        ],
        amendments,
        { caseKey: "case_id", subtitle: "Latest corrigenda with original and revised conditions" },
      ),
      table(
        "Possible duplicate requirements (heuristic)",
        [
          { key: "tender_a", label: "Tender A" },
          { key: "tender_b", label: "Tender B" },
          { key: "requirement_a", label: "Requirement A" },
          { key: "requirement_b", label: "Requirement B" },
          { key: "department_name", label: "Department" },
          { key: "value_a", label: "Value A", fmt: "money" },
          { key: "value_b", label: "Value B", fmt: "money" },
          { key: "days_apart", label: "Days apart", fmt: "days" },
        ],
        duplicates,
        {
          caseKey: "case_id",
          subtitle: "Same category and department, estimates within 5%, published within 45 days. Candidates for human review only.",
        },
      ),
      table(
        "Re-tender lineage",
        [
          { key: "retender_id", label: "Re-tender" },
          { key: "original_tender", label: "Original" },
          { key: "original_status", label: "Original status", fmt: "badge" },
          { key: "original_reason", label: "Reason recorded" },
          { key: "current_status", label: "Current status", fmt: "badge" },
          { key: "estimated_value", label: "Estimated", fmt: "money" },
        ],
        lineage,
        { caseKey: "case_id" },
      ),
    ],
    notes: [
      "Open a case from any row to see the tender conditions, eligibility criteria, version history and source PDF pages.",
      "Personalised tender recommendations are not implemented: they need an authenticated user profile from the host application.",
    ],
  };
}

// ───────────────────────────── Bid evaluation ─────────────────────────────

function evaluation(): ModuleView {
  const asOf = getStore().asOf;
  const totalEvals = scalar("SELECT COUNT(*) FROM technical_evaluations");
  const disq = scalar("SELECT COUNT(*) FROM technical_evaluations WHERE result = 'Technically Disqualified'");
  const kpis: Kpi[] = [
    { label: "Tenders under evaluation", value: scalar("SELECT COUNT(*) FROM tender_master WHERE status = 'Under Evaluation'"), fmt: "int", drill: "under_evaluation" },
    { label: "Bids received", value: scalar("SELECT COUNT(*) FROM bidder_submissions"), fmt: "int" },
    { label: "Technical evaluations", value: totalEvals, fmt: "int" },
    { label: "Technically disqualified", value: disq, fmt: "int", hint: `${totalEvals ? ((disq / totalEvals) * 100).toFixed(1) : 0}% of evaluated bids`, tone: "warn" },
    { label: "Incomplete or withdrawn bids", value: scalar("SELECT COUNT(*) FROM bidder_submissions WHERE submission_status <> 'Submitted'"), fmt: "int" },
    { label: "Single-bid tenders", value: scalar("SELECT COUNT(*) FROM v_tender WHERE bids_received = 1"), fmt: "int", drill: "single_bid" },
    {
      label: "Lowest quote disqualified",
      value: scalar(`WITH m AS (SELECT tender_id, MIN(quoted_total) AS mn FROM financial_evaluations GROUP BY tender_id)
                     SELECT COUNT(DISTINCT f.tender_id) FROM financial_evaluations f JOIN m ON m.tender_id = f.tender_id AND f.quoted_total = m.mn
                     WHERE f.technically_qualified = 'false'`),
      fmt: "int",
      hint: "Tenders where the cheapest quote failed technical evaluation",
      drill: "lowest_disqualified",
    },
    { label: "Missing or expired bid documents", value: scalar("SELECT COUNT(*) FROM bidder_document_checklist WHERE validity <> 'Valid'"), fmt: "int", tone: "warn" },
  ];

  const charts: Chart[] = [
    bars(
      "Why bids were technically disqualified",
      q(`SELECT CASE WHEN disqualification_reason LIKE 'Failed:%' THEN disqualification_reason
                      ELSE substr(disqualification_reason,1,instr(disqualification_reason,': ')-1) END AS label,
                COUNT(*) AS value
         FROM technical_evaluations WHERE result = 'Technically Disqualified' GROUP BY 1 ORDER BY 2 DESC LIMIT 8`),
      { fmt: "int" },
    ),
    bars(
      "Bids received per tender",
      q(`SELECT bids_received || ' bid(s)' AS label, COUNT(*) AS value FROM v_tender GROUP BY bids_received ORDER BY bids_received`),
      { fmt: "int" },
    ),
    bars(
      "Deficient bid documents",
      q(`SELECT document_name || ' (' || validity || ')' AS label, COUNT(*) AS value FROM bidder_document_checklist
         WHERE validity <> 'Valid' GROUP BY document_name, validity ORDER BY 2 DESC LIMIT 8`),
      { fmt: "int" },
    ),
    bars(
      "Bid rank distribution",
      q(`SELECT status AS label, COUNT(*) AS value FROM comparative_statements GROUP BY status ORDER BY CASE WHEN status='Disqualified' THEN 99 ELSE CAST(substr(status,2) AS INTEGER) END`),
      { fmt: "int" },
    ),
  ];

  const underEvaluation = q(`SELECT t.tender_id, t.case_id, t.title, t.category_name, t.bids_received,
        (SELECT COUNT(*) FROM technical_evaluations e WHERE e.tender_id = t.tender_id AND e.result = 'Technically Qualified') AS qualified,
        (SELECT COUNT(*) FROM technical_evaluations e WHERE e.tender_id = t.tender_id AND e.result = 'Technically Disqualified') AS disqualified,
        (SELECT MIN(f.quoted_total) FROM financial_evaluations f WHERE f.tender_id = t.tender_id AND f.technically_qualified = 'true') AS lowest_qualified_quote,
        t.estimated_value, t.evaluation_method
      FROM v_tender t WHERE t.status = 'Under Evaluation' ORDER BY t.estimated_value DESC LIMIT 40`);
  const recentDq = q(`SELECT e.tender_id, t.case_id, v.company_name, e.evaluation_date, e.total_score, e.cutoff_score,
        e.eligibility_result, e.disqualification_reason, e.committee_ref
      FROM technical_evaluations e JOIN tender_master t ON t.tender_id = e.tender_id
      JOIN vendor_master v ON v.vendor_id = e.vendor_id
      WHERE e.result = 'Technically Disqualified' ORDER BY e.evaluation_date DESC LIMIT 30`);
  const methods = q(`SELECT evaluation_method AS method, COUNT(*) AS evaluations,
        SUM(CASE WHEN result='Technically Disqualified' THEN 1 ELSE 0 END) AS disqualified,
        ROUND(100.0*SUM(CASE WHEN result='Technically Disqualified' THEN 1 ELSE 0 END)/COUNT(*),1) AS disqualified_pct
      FROM technical_evaluations GROUP BY 1`);

  return {
    id: "evaluation",
    title: "Bid evaluation assistance",
    summary: "Compliance, deficiencies and comparative statements to support the evaluation committee.",
    asOf,
    kpis,
    charts,
    tables: [
      table(
        "Tenders currently under evaluation",
        [
          { key: "tender_id", label: "Tender" },
          { key: "title", label: "Requirement" },
          { key: "evaluation_method", label: "Method" },
          { key: "bids_received", label: "Bids", fmt: "int" },
          { key: "qualified", label: "Qualified", fmt: "int" },
          { key: "disqualified", label: "Disqualified", fmt: "int" },
          { key: "lowest_qualified_quote", label: "Lowest qualified quote", fmt: "money" },
          { key: "estimated_value", label: "Estimate", fmt: "money" },
        ],
        underEvaluation,
        { caseKey: "case_id", subtitle: "Open a case for the compliance matrix and comparative statement" },
      ),
      table(
        "Disqualification record with stated reasons",
        [
          { key: "tender_id", label: "Tender" },
          { key: "company_name", label: "Bidder" },
          { key: "evaluation_date", label: "Date", fmt: "date" },
          { key: "total_score", label: "Score", fmt: "num" },
          { key: "cutoff_score", label: "Cut-off", fmt: "num" },
          { key: "disqualification_reason", label: "Reason recorded by committee" },
          { key: "committee_ref", label: "Committee ref" },
        ],
        recentDq,
        { caseKey: "case_id" },
      ),
      table(
        "Outcome by evaluation method",
        [
          { key: "method", label: "Method" },
          { key: "evaluations", label: "Evaluations", fmt: "int" },
          { key: "disqualified", label: "Disqualified", fmt: "int" },
          { key: "disqualified_pct", label: "Disqualified %", fmt: "pct" },
        ],
        methods,
      ),
    ],
    notes: [
      "This workspace assists the committee. It never disqualifies a bidder, ranks a bid as final, or selects an award; those remain human decisions.",
      "L1 is the lowest price among technically qualified bidders; QCBS tenders rank on the combined technical and financial score.",
    ],
  };
}

// ───────────────────────────── Finance ─────────────────────────────

function finance(): ModuleView {
  const asOf = getStore().asOf;
  const awardRow = q(`SELECT SUM(approved_value) AS awarded, SUM(estimated_value) AS estimate FROM award_decisions WHERE approval_status = 'Approved'`)[0];
  const awarded = Number(awardRow.awarded) || 0;
  const estimate = Number(awardRow.estimate) || 0;
  const vendorShares = q(`SELECT vendor_name AS label, SUM(total_value) AS value FROM v_po GROUP BY vendor_id ORDER BY 2 DESC`) as Array<{ label: string; value: number }>;
  const totalPo = vendorShares.reduce((sum, row) => sum + row.value, 0);
  const top5 = vendorShares.slice(0, 5).reduce((sum, row) => sum + row.value, 0);
  const hhi = vendorShares.reduce((sum, row) => sum + Math.pow((row.value / totalPo) * 100, 2), 0);

  const kpis: Kpi[] = [
    { label: "Estimated value of awarded cases", value: estimate, fmt: "money" },
    { label: "Approved award value", value: awarded, fmt: "money" },
    {
      label: "Award vs estimate",
      value: estimate - awarded,
      fmt: "money",
      hint: "A difference, not validated savings",
    },
    { label: "Purchase order value", value: totalPo, fmt: "money", hint: "Includes taxes and charges" },
    { label: "Paid", value: scalar("SELECT SUM(amount) FROM payment_register"), fmt: "money" },
    { label: "Outstanding invoices", value: scalar("SELECT SUM(outstanding_amount) FROM invoice_register WHERE outstanding_amount > 0"), fmt: "money", tone: "warn", drill: "payables" },
    { label: "Top-5 vendor share of PO value", value: totalPo ? (top5 / totalPo) * 100 : 0, fmt: "pct", hint: `HHI ${hhi.toFixed(0)} (below 1,500 is unconcentrated)` },
    { label: "Budget lines needing augmentation", value: scalar("SELECT COUNT(*) FROM budget_controls WHERE status = 'Augmentation required'"), fmt: "int", tone: "warn", drill: "budget_flag" },
  ];

  const charts: Chart[] = [
    bars(
      "Expenditure (paid) by department",
      q(`SELECT p.department_name AS label, SUM(pay.amount) AS value FROM payment_register pay JOIN v_po p ON p.po_number = pay.po_number GROUP BY 1 ORDER BY 2 DESC LIMIT 12`),
      { fmt: "money", drillPrefix: "dept" },
    ),
    bars(
      "Purchase order value by category group",
      q(`SELECT category_group AS label, SUM(total_value) AS value FROM v_po GROUP BY 1 ORDER BY 2 DESC`),
      { fmt: "money", drillPrefix: "group" },
    ),
    {
      title: "Payments released per month",
      kind: "columns",
      fmt: "money",
      data: (
        q(`SELECT substr(payment_date,1,7) AS label, SUM(amount) AS value FROM payment_register GROUP BY 1 ORDER BY 1 DESC LIMIT 24`) as Array<{ label: string; value: number }>
      )
        .reverse()
        .map((row) => ({ label: row.label, value: row.value })),
    },
    {
      title: "Vendor concentration: top 10 by PO value",
      kind: "bars",
      fmt: "money",
      data: vendorShares.slice(0, 10).map((row) => ({ label: row.label, value: row.value, drill: `vendor:${row.label}` })),
    },
  ];

  const fyColumns = ["2024-25", "2025-26", "2026-27"];
  const benchmark = q(`SELECT i.item_name AS item, l.uom,
        ${fyColumns.map((fy) => `ROUND(AVG(CASE WHEN ${FY_SQL("po.po_date")} = '${fy}' THEN l.unit_price END),0) AS "fy_${fy.replace("-", "_")}"`).join(",\n        ")},
        i.base_unit_price AS base_price, COUNT(*) AS po_lines, COUNT(DISTINCT po.vendor_id) AS vendors
      FROM purchase_order_line_items l
      JOIN purchase_orders po ON po.po_number = l.po_number
      JOIN item_master i ON i.item_id = l.item_id
      GROUP BY l.item_id, l.uom
      HAVING (COUNT(DISTINCT CASE WHEN ${FY_SQL("po.po_date")} = '2024-25' THEN 1 END)
            + COUNT(DISTINCT CASE WHEN ${FY_SQL("po.po_date")} = '2025-26' THEN 1 END)
            + COUNT(DISTINCT CASE WHEN ${FY_SQL("po.po_date")} = '2026-27' THEN 1 END)) >= 2
      ORDER BY po_lines DESC LIMIT 30`);
  const deviation = q(`WITH x AS (
        SELECT l.po_line_id, l.po_number, l.item_id, l.description, l.quantity, l.uom, l.unit_price,
               AVG(l.unit_price) OVER (PARTITION BY l.item_id, l.uom) AS avg_price,
               COUNT(*) OVER (PARTITION BY l.item_id, l.uom) AS n
        FROM purchase_order_line_items l)
      SELECT x.po_number, p.case_id, x.description, p.vendor_name, x.quantity, x.unit_price, ROUND(x.avg_price,2) AS item_average,
             ROUND((x.unit_price - x.avg_price) * 100.0 / x.avg_price, 1) AS deviation_pct, x.n AS comparable_lines
      FROM x JOIN v_po p ON p.po_number = x.po_number
      WHERE x.n >= 3 AND ABS(x.unit_price - x.avg_price) > 0.25 * x.avg_price
      ORDER BY ABS(deviation_pct) DESC LIMIT 25`);
  const estimateVsAward = q(`SELECT v.category_group AS category_group, COUNT(*) AS awards,
        SUM(a.estimated_value) AS estimated, SUM(a.approved_value) AS awarded,
        SUM(a.estimated_value) - SUM(a.approved_value) AS difference,
        ROUND(100.0 * (SUM(a.estimated_value) - SUM(a.approved_value)) / SUM(a.estimated_value), 1) AS difference_pct
      FROM award_decisions a JOIN v_case v ON v.case_id = a.case_id
      WHERE a.approval_status = 'Approved' GROUP BY 1 ORDER BY difference DESC`);
  const budget = q(`SELECT b.requisition_id, c.case_id, b.financial_year, b.budget_head, b.approved_budget, b.committed_before,
        b.requested_amount, b.available_after, b.status
      FROM budget_controls b JOIN procurement_cases c ON c.requisition_id = b.requisition_id
      WHERE b.status = 'Augmentation required' OR b.available_after < 0 ORDER BY b.available_after`);

  return {
    id: "finance",
    title: "Financial intelligence",
    summary: "Spend, price benchmarks, budget position and vendor concentration from PO, invoice and payment records.",
    asOf,
    kpis,
    charts,
    tables: [
      table(
        "Unit price benchmark by financial year",
        [
          { key: "item", label: "Item" },
          { key: "uom", label: "UoM" },
          { key: "fy_2024_25", label: "FY 2024-25", fmt: "money" },
          { key: "fy_2025_26", label: "FY 2025-26", fmt: "money" },
          { key: "fy_2026_27", label: "FY 2026-27", fmt: "money" },
          { key: "base_price", label: "Reference price", fmt: "money" },
          { key: "po_lines", label: "PO lines", fmt: "int" },
          { key: "vendors", label: "Vendors", fmt: "int" },
        ],
        benchmark,
        { subtitle: "Average pre-GST unit price per PO line, same item and unit of measure" },
      ),
      table(
        "Unit prices more than 25% from the item average",
        [
          { key: "po_number", label: "PO" },
          { key: "description", label: "Item" },
          { key: "vendor_name", label: "Vendor" },
          { key: "quantity", label: "Qty", fmt: "num" },
          { key: "unit_price", label: "Unit price", fmt: "money" },
          { key: "item_average", label: "Item average", fmt: "money" },
          { key: "deviation_pct", label: "Deviation", fmt: "pct" },
          { key: "comparable_lines", label: "Comparable lines", fmt: "int" },
        ],
        deviation,
        { caseKey: "case_id", subtitle: "Statistical outliers for review. Specification, quantity and delivery differences are not normalised beyond item and UoM." },
      ),
      table(
        "Estimate vs approved award by category group",
        [
          { key: "category_group", label: "Category group" },
          { key: "awards", label: "Awards", fmt: "int" },
          { key: "estimated", label: "Estimated", fmt: "money" },
          { key: "awarded", label: "Awarded", fmt: "money" },
          { key: "difference", label: "Difference", fmt: "money" },
          { key: "difference_pct", label: "Difference %", fmt: "pct" },
        ],
        estimateVsAward,
      ),
      table(
        "Budget certificates needing attention",
        [
          { key: "requisition_id", label: "Requisition" },
          { key: "financial_year", label: "FY" },
          { key: "budget_head", label: "Budget head" },
          { key: "approved_budget", label: "Approved", fmt: "money" },
          { key: "committed_before", label: "Committed", fmt: "money" },
          { key: "requested_amount", label: "Requested", fmt: "money" },
          { key: "available_after", label: "Available after", fmt: "money" },
          { key: "status", label: "Status", fmt: "badge" },
        ],
        budget,
        { caseKey: "case_id" },
      ),
    ],
    notes: [
      "Estimated minus awarded value is reported as a difference. It is not called savings without a validated baseline.",
      "Price comparisons use pre-GST unit prices for the same catalogue item and unit of measure; the dataset has no spec-level or delivery-term normalisation.",
    ],
  };
}

// ───────────────────────────── Workflow ─────────────────────────────

function workflow(): ModuleView {
  const asOf = getStore().asOf;
  const turnaround = `julianday(decision_date) - julianday(submitted_date)`;
  const kpis: Kpi[] = [
    { label: "Approvals pending", value: scalar("SELECT COUNT(*) FROM approvals WHERE decision = 'Pending'"), fmt: "int", tone: "warn", drill: "pending_approvals" },
    {
      label: "Average approval turnaround",
      value: scalar(`SELECT ROUND(AVG(${turnaround}),1) FROM approvals WHERE decision_date IS NOT NULL`),
      fmt: "days",
      hint: "Submission to decision",
    },
    {
      label: "Returned or rejected steps",
      value: scalar("SELECT COUNT(*) FROM approvals WHERE decision IN ('Returned','Rejected')"),
      fmt: "int",
      hint: `${((scalar("SELECT COUNT(*) FROM approvals WHERE decision IN ('Returned','Rejected')") / scalar("SELECT COUNT(*) FROM approvals")) * 100).toFixed(1)}% of approval steps`,
    },
    { label: "Active cases past SLA", value: scalar(`SELECT COUNT(*) FROM procurement_cases WHERE ${ACTIVE} AND delay_days > 0`), fmt: "int", tone: "warn", drill: "overdue_active" },
    { label: "Escalated active cases", value: scalar(`SELECT COUNT(*) FROM procurement_cases WHERE ${ACTIVE} AND escalation_level > 0`), fmt: "int", tone: "bad", drill: "escalated" },
    { label: "Average delay of those cases", value: scalar(`SELECT ROUND(AVG(delay_days),1) FROM procurement_cases WHERE ${ACTIVE} AND delay_days > 0`), fmt: "days" },
  ];

  const charts: Chart[] = [
    bars(
      "Average days from submission to decision, by approval stage",
      q(`SELECT stage AS label, ROUND(AVG(${turnaround}),1) AS value FROM approvals WHERE decision_date IS NOT NULL GROUP BY stage ORDER BY 2 DESC`),
      { fmt: "days" },
    ),
    bars(
      "Total recorded delay days by approval stage",
      q(`SELECT stage AS label, SUM(delay_days) AS value FROM approvals GROUP BY stage ORDER BY 2 DESC`),
      { fmt: "int" },
    ),
    bars(
      "Returned, resubmitted or pending steps by stage",
      q(`SELECT stage AS label, COUNT(*) AS value FROM approvals WHERE decision IN ('Returned','Resubmitted','Pending') GROUP BY stage ORDER BY 2 DESC`),
      { fmt: "int", drillPrefix: "approval" },
    ),
    bars(
      "Active cases past SLA by current stage",
      q(`SELECT current_stage_name AS label, COUNT(*) AS value FROM procurement_cases WHERE ${ACTIVE} AND delay_days > 0 GROUP BY 1 ORDER BY 2 DESC`),
      { fmt: "int", drillPrefix: "stage" },
    ),
  ];

  const stageTable = q(`SELECT stage, COUNT(*) AS steps, ROUND(AVG(${turnaround}),1) AS avg_days,
        MAX(${turnaround}) AS max_days, ROUND(AVG(delay_days),1) AS avg_delay_days, SUM(delay_days) AS total_delay_days,
        SUM(CASE WHEN decision IN ('Returned','Rejected') THEN 1 ELSE 0 END) AS returned_or_rejected,
        SUM(CASE WHEN decision = 'Pending' THEN 1 ELSE 0 END) AS pending
      FROM approvals GROUP BY stage ORDER BY total_delay_days DESC`);
  const pending = q(`SELECT a.approval_id, c.case_id, c.title, a.stage, o.officer_name AS approver, o.designation,
        a.submitted_date, CAST(julianday({ASOF}) - julianday(a.submitted_date) AS INTEGER) AS age_days,
        CASE WHEN julianday({ASOF}) - julianday(a.submitted_date) > 14 THEN 'Escalate to next authority'
             WHEN julianday({ASOF}) - julianday(a.submitted_date) > 7 THEN 'Send reminder' ELSE 'Within normal window' END AS suggested_action
      FROM approvals a JOIN v_case c ON c.requisition_id = a.requisition_id
      LEFT JOIN employee_officer_master o ON o.officer_id = a.approver_officer_id
      WHERE a.decision = 'Pending' ORDER BY age_days DESC`);
  const escalations = q(`SELECT case_id, title, department_name, current_stage_name, escalation_level, delay_days, next_action, responsible_officer_id
      FROM v_case WHERE ${ACTIVE} AND escalation_level > 0 ORDER BY escalation_level DESC, delay_days DESC LIMIT 30`);
  const tenderSlip = q(`SELECT milestone, COUNT(*) AS occurrences,
        ROUND(AVG(julianday(actual_at) - julianday(planned_at)),1) AS avg_slip_days,
        MAX(julianday(actual_at) - julianday(planned_at)) AS max_slip_days
      FROM tender_milestones WHERE actual_at IS NOT NULL GROUP BY milestone`);

  return {
    id: "workflow",
    title: "Workflow intelligence",
    summary: "Approval turnaround, bottlenecks, pending actions and escalations across the procurement file.",
    asOf,
    kpis,
    charts,
    tables: [
      table(
        "Stage-wise approval turnaround",
        [
          { key: "stage", label: "Approval stage" },
          { key: "steps", label: "Steps", fmt: "int" },
          { key: "avg_days", label: "Avg days", fmt: "days" },
          { key: "max_days", label: "Max days", fmt: "days" },
          { key: "avg_delay_days", label: "Avg delay", fmt: "days" },
          { key: "total_delay_days", label: "Total delay days", fmt: "int" },
          { key: "returned_or_rejected", label: "Returned / rejected", fmt: "int" },
          { key: "pending", label: "Pending", fmt: "int" },
        ],
        stageTable,
        { subtitle: "Ranked by total recorded delay days" },
      ),
      table(
        "Pending approvals and suggested follow-up",
        [
          { key: "case_id", label: "Case" },
          { key: "title", label: "Requirement" },
          { key: "stage", label: "Stage" },
          { key: "approver", label: "Approver" },
          { key: "submitted_date", label: "Submitted", fmt: "date" },
          { key: "age_days", label: "Age", fmt: "days" },
          { key: "suggested_action", label: "Suggested action", fmt: "badge" },
        ],
        pending,
        { caseKey: "case_id", subtitle: "Reminders are suggestions only; none are sent from this workspace." },
      ),
      table(
        "Escalated active cases",
        [
          { key: "case_id", label: "Case" },
          { key: "title", label: "Requirement" },
          { key: "department_name", label: "Department" },
          { key: "current_stage_name", label: "Stage" },
          { key: "escalation_level", label: "Level", fmt: "int" },
          { key: "delay_days", label: "Delay", fmt: "days" },
          { key: "next_action", label: "Next action" },
        ],
        escalations,
        { caseKey: "case_id" },
      ),
      table(
        "Tender milestone slippage",
        [
          { key: "milestone", label: "Milestone" },
          { key: "occurrences", label: "Completed", fmt: "int" },
          { key: "avg_slip_days", label: "Avg slip", fmt: "days" },
          { key: "max_slip_days", label: "Max slip", fmt: "days" },
        ],
        tenderSlip,
      ),
    ],
    notes: ["Delay days are as recorded in the source approval and case registers."],
  };
}

// ───────────────────────────── Contracts ─────────────────────────────

function contracts(): ModuleView {
  const asOf = getStore().asOf;
  const live = `status IN ('Active','Extended')`;
  const kpis: Kpi[] = [
    { label: "Active & extended contracts", value: scalar(`SELECT COUNT(*) FROM contract_master WHERE ${live}`), fmt: "int", drill: "contracts_active" },
    { label: "Value under contract", value: scalar(`SELECT SUM(contract_value) FROM contract_master WHERE ${live}`), fmt: "money" },
    {
      label: "Ending within 60 days",
      value: scalar(`SELECT COUNT(*) FROM contract_master WHERE ${live} AND end_date BETWEEN {ASOF} AND date({ASOF},'+60 day')`),
      fmt: "int",
      tone: "warn",
      drill: "contracts_expiring",
    },
    { label: "Extended contracts", value: scalar("SELECT COUNT(*) FROM contract_master WHERE status = 'Extended'"), fmt: "int", drill: "contracts_extended" },
    { label: "Contract amendments", value: scalar("SELECT COUNT(*) FROM contract_variations"), fmt: "int" },
    { label: "Penalties and LD recorded", value: scalar("SELECT SUM(penalty_amount) FROM penalty_register WHERE status <> 'Waived'"), fmt: "money", hint: "Excludes waived", drill: "penalties" },
    {
      label: "Warranties ending within 90 days",
      value: scalar(`SELECT COUNT(*) FROM warranty_register WHERE warranty_end BETWEEN {ASOF} AND date({ASOF},'+90 day')`),
      fmt: "int",
      drill: "warranty_expiring",
    },
    { label: "Unresolved warranty claims", value: scalar("SELECT COUNT(*) FROM warranty_claims WHERE status IN ('Open','In Rectification')"), fmt: "int", tone: "warn", drill: "open_warranty_claims" },
  ];

  const charts: Chart[] = [
    bars("Contracts by status", q(`SELECT status AS label, COUNT(*) AS value FROM contract_master GROUP BY 1 ORDER BY 2 DESC`), { fmt: "int" }),
    {
      title: "Contract end dates, next 12 months",
      subtitle: "Active and extended contracts",
      kind: "columns",
      fmt: "int",
      data: (q(`SELECT substr(end_date,1,7) AS label, COUNT(*) AS value FROM contract_master
                WHERE ${live} AND end_date >= {ASOF} AND end_date < date({ASOF},'+12 month') GROUP BY 1 ORDER BY 1`) as Array<{ label: string; value: number }>).map((row) => ({ label: row.label, value: row.value })),
    },
    bars("Penalties by type", q(`SELECT penalty_type AS label, SUM(penalty_amount) AS value FROM penalty_register GROUP BY 1 ORDER BY 2 DESC`), { fmt: "money" }),
    bars("Penalty status", q(`SELECT status AS label, COUNT(*) AS value FROM penalty_register GROUP BY 1 ORDER BY 2 DESC`), { fmt: "int" }),
  ];

  const expiring = q(`SELECT cm.contract_number, p.case_id, p.vendor_name, p.category_name, cm.start_date, cm.end_date,
        CAST(julianday(cm.end_date) - julianday({ASOF}) AS INTEGER) AS days_left, cm.contract_value, cm.status
      FROM contract_master cm JOIN v_po p ON p.po_number = cm.po_number
      WHERE cm.${live} AND cm.end_date BETWEEN {ASOF} AND date({ASOF},'+60 day') ORDER BY cm.end_date`);
  const variations = q(`SELECT v.variation_id, v.contract_number, c.case_id, v.variation_type, v.approved_date, v.previous_end_date, v.new_end_date, v.value_change, v.reason
      FROM contract_variations v JOIN procurement_cases c ON c.contract_number = v.contract_number ORDER BY v.approved_date DESC LIMIT 40`);
  const warranties = q(`SELECT w.warranty_id, p.case_id, w.contract_number, p.vendor_name, w.warranty_end,
        CAST(julianday(w.warranty_end) - julianday({ASOF}) AS INTEGER) AS days_left, w.coverage, w.status
      FROM warranty_register w JOIN v_po p ON p.po_number = w.po_number
      WHERE w.warranty_end BETWEEN {ASOF} AND date({ASOF},'+90 day') ORDER BY w.warranty_end`);
  const claims = q(`SELECT w.claim_id, p.case_id, w.contract_number, p.vendor_name, w.claim_date, w.defect_description, w.status,
        CAST(julianday({ASOF}) - julianday(w.claim_date) AS INTEGER) AS age_days
      FROM warranty_claims w JOIN v_po p ON p.contract_number = w.contract_number
      WHERE w.status IN ('Open','In Rectification') ORDER BY w.claim_date`);
  const penalties = q(`SELECT pr.penalty_id, p.case_id, pr.contract_number, p.vendor_name, pr.penalty_type, pr.delay_days,
        pr.penalty_amount, pr.status, pr.computed_basis
      FROM penalty_register pr JOIN v_po p ON p.po_number = pr.po_number ORDER BY pr.penalty_amount DESC LIMIT 30`);

  return {
    id: "contracts",
    title: "Purchase order & contract management",
    summary: "Contract repository status, expiry, amendments, warranty and penalty tracking.",
    asOf,
    kpis,
    charts,
    tables: [
      table(
        "Contracts ending within 60 days",
        [
          { key: "contract_number", label: "Contract" },
          { key: "vendor_name", label: "Vendor" },
          { key: "category_name", label: "Category" },
          { key: "end_date", label: "End date", fmt: "date" },
          { key: "days_left", label: "Days left", fmt: "days" },
          { key: "contract_value", label: "Value", fmt: "money" },
          { key: "status", label: "Status", fmt: "badge" },
        ],
        expiring,
        { caseKey: "case_id" },
      ),
      table(
        "Contract amendments",
        [
          { key: "contract_number", label: "Contract" },
          { key: "variation_type", label: "Type" },
          { key: "approved_date", label: "Approved", fmt: "date" },
          { key: "previous_end_date", label: "Previous end", fmt: "date" },
          { key: "new_end_date", label: "New end", fmt: "date" },
          { key: "value_change", label: "Value change", fmt: "money" },
          { key: "reason", label: "Reason" },
        ],
        variations,
        { caseKey: "case_id" },
      ),
      table(
        "Warranties ending within 90 days",
        [
          { key: "contract_number", label: "Contract" },
          { key: "vendor_name", label: "Vendor" },
          { key: "warranty_end", label: "Ends", fmt: "date" },
          { key: "days_left", label: "Days left", fmt: "days" },
          { key: "coverage", label: "Coverage" },
        ],
        warranties,
        { caseKey: "case_id" },
      ),
      table(
        "Unresolved warranty claims",
        [
          { key: "claim_id", label: "Claim" },
          { key: "vendor_name", label: "Vendor" },
          { key: "claim_date", label: "Raised", fmt: "date" },
          { key: "age_days", label: "Age", fmt: "days" },
          { key: "defect_description", label: "Defect" },
          { key: "status", label: "Status", fmt: "badge" },
        ],
        claims,
        { caseKey: "case_id" },
      ),
      table(
        "Largest penalties and liquidated damages",
        [
          { key: "penalty_id", label: "Penalty" },
          { key: "vendor_name", label: "Vendor" },
          { key: "penalty_type", label: "Type" },
          { key: "delay_days", label: "Delay", fmt: "days" },
          { key: "penalty_amount", label: "Amount", fmt: "money" },
          { key: "status", label: "Status", fmt: "badge" },
          { key: "computed_basis", label: "Basis" },
        ],
        penalties,
        { caseKey: "case_id" },
      ),
    ],
    notes: ["Contract end dates reflect approved extensions. Alerts are shown as lists; no notification is sent."],
  };
}

// ───────────────────────────── Delivery & inspection ─────────────────────────────

function delivery(): ModuleView {
  const asOf = getStore().asOf;
  const lateSql = `(delay_days > 0 OR (actual_date IS NULL AND planned_date < {ASOF}))`;
  const inspected = scalar("SELECT SUM(qty_inspected) FROM inspection_records");
  const rejected = scalar("SELECT SUM(qty_rejected) FROM inspection_records");
  const kpis: Kpi[] = [
    { label: "Milestones delivered late or overdue", value: scalar(`SELECT COUNT(*) FROM delivery_milestones WHERE ${lateSql}`), fmt: "int", tone: "warn", drill: "late_milestones" },
    { label: "Partially delivered milestones", value: scalar("SELECT COUNT(*) FROM delivery_milestones WHERE status = 'Partially Delivered'"), fmt: "int", drill: "partial_delivery" },
    { label: "Inspections with rejection", value: scalar("SELECT COUNT(*) FROM inspection_records WHERE qty_rejected > 0"), fmt: "int", tone: "warn", drill: "rejections" },
    { label: "Quantity rejected", value: inspected ? (rejected / inspected) * 100 : 0, fmt: "pct", hint: "Of quantity inspected" },
    { label: "Invoices under verification", value: scalar("SELECT COUNT(*) FROM invoice_register WHERE verification_status = 'Under verification'"), fmt: "int", drill: "invoices_unverified" },
    { label: "Disputed invoices", value: scalar("SELECT COUNT(*) FROM invoice_register WHERE payment_status = 'Disputed'"), fmt: "int", tone: "bad", drill: "disputed_invoices" },
    { label: "Outstanding payable", value: scalar("SELECT SUM(outstanding_amount) FROM invoice_register WHERE outstanding_amount > 0"), fmt: "money", drill: "payables" },
    { label: "Overdue payable", value: scalar("SELECT SUM(outstanding_amount) FROM invoice_register WHERE outstanding_amount > 1 AND payment_due_date < {ASOF}"), fmt: "money", tone: "warn", drill: "payables_overdue" },
  ];

  const charts: Chart[] = [
    bars("Delivery milestones by status", q(`SELECT status AS label, COUNT(*) AS value FROM delivery_milestones GROUP BY 1 ORDER BY 2 DESC`), { fmt: "int" }),
    bars("Inspection results", q(`SELECT result AS label, COUNT(*) AS value FROM inspection_records GROUP BY 1 ORDER BY 2 DESC`), { fmt: "int", drillPrefix: "inspection" }),
    bars(
      "Outstanding payables by ageing bucket",
      q(`SELECT ageing_bucket AS label, SUM(outstanding) AS value FROM outstanding_payments GROUP BY 1 ORDER BY MIN(days_overdue)`),
      { fmt: "money", drillPrefix: "ageing" },
    ),
    bars("Invoice payment status", q(`SELECT payment_status AS label, COUNT(*) AS value FROM invoice_register GROUP BY 1 ORDER BY 2 DESC`), { fmt: "int" }),
  ];

  const undelivered = q(`WITH ordered AS (SELECT po_number, SUM(quantity) AS q FROM purchase_order_line_items GROUP BY 1),
        acc AS (SELECT po_number, SUM(accepted_qty) AS a FROM acceptance_certificates GROUP BY 1)
      SELECT p.po_number, p.case_id, p.vendor_name, p.category_name, ROUND(o.q,2) AS ordered_qty, ROUND(COALESCE(a.a,0),2) AS accepted_qty,
             ROUND(o.q - COALESCE(a.a,0),2) AS pending_qty,
             ROUND((o.q - COALESCE(a.a,0)) * 100.0 / o.q,1) AS pending_pct, p.expected_delivery_date, p.contract_status
      FROM v_po p JOIN ordered o ON o.po_number = p.po_number LEFT JOIN acc a ON a.po_number = p.po_number
      WHERE p.contract_status IN ('Active','Extended') AND (o.q - COALESCE(a.a,0)) > 0.2 * o.q
      ORDER BY pending_pct DESC, o.q DESC LIMIT 40`);
  const lateTable = q(`SELECT m.milestone_id, p.case_id, m.po_number, p.vendor_name, m.milestone_type, m.planned_date, m.actual_date,
        CASE WHEN m.actual_date IS NOT NULL THEN m.delay_days ELSE CAST(julianday({ASOF}) - julianday(m.planned_date) AS INTEGER) END AS days_late,
        m.planned_qty, m.actual_qty, m.status
      FROM delivery_milestones m JOIN v_po p ON p.po_number = m.po_number
      WHERE ${lateSql.replaceAll("delay_days", "m.delay_days").replaceAll("actual_date", "m.actual_date").replaceAll("planned_date", "m.planned_date")}
      ORDER BY days_late DESC LIMIT 40`);
  const rejections = q(`SELECT i.inspection_id, p.case_id, i.po_number, p.vendor_name, i.inspection_date, i.qty_inspected, i.qty_accepted, i.qty_rejected,
        i.rejection_reason, i.result,
        (SELECT COUNT(*) FROM dispatch_records d WHERE d.po_number = i.po_number AND d.is_replacement = 'true') AS replacement_dispatches
      FROM inspection_records i JOIN v_po p ON p.po_number = i.po_number
      WHERE i.qty_rejected > 0 ORDER BY i.inspection_date DESC LIMIT 40`);
  const invoices = q(`SELECT invoice_id, case_id, po_number, vendor_name, invoice_date, total_amount, net_payable, amount_paid, outstanding_amount,
        verification_status, payment_status, payment_due_date,
        CASE WHEN outstanding_amount > 1 AND payment_due_date < {ASOF} THEN CAST(julianday({ASOF}) - julianday(payment_due_date) AS INTEGER) ELSE 0 END AS days_overdue
      FROM v_invoice WHERE outstanding_amount > 1 ORDER BY outstanding_amount DESC LIMIT 40`);

  return {
    id: "delivery",
    title: "Delivery & inspection intelligence",
    summary: "Milestones, goods receipt, inspection outcomes, invoice reconciliation and payment tracking.",
    asOf,
    kpis,
    charts,
    tables: [
      table(
        "Active contracts with more than 20% of ordered quantity not yet accepted",
        [
          { key: "po_number", label: "PO" },
          { key: "vendor_name", label: "Vendor" },
          { key: "category_name", label: "Category" },
          { key: "ordered_qty", label: "Ordered", fmt: "num" },
          { key: "accepted_qty", label: "Accepted", fmt: "num" },
          { key: "pending_qty", label: "Pending", fmt: "num" },
          { key: "pending_pct", label: "Pending %", fmt: "pct" },
          { key: "expected_delivery_date", label: "Expected by", fmt: "date" },
        ],
        undelivered,
        { caseKey: "case_id", subtitle: "Pending = ordered quantity minus accepted quantity on acceptance certificates" },
      ),
      table(
        "Late and overdue delivery milestones",
        [
          { key: "po_number", label: "PO" },
          { key: "vendor_name", label: "Vendor" },
          { key: "milestone_type", label: "Type" },
          { key: "planned_date", label: "Planned", fmt: "date" },
          { key: "actual_date", label: "Actual", fmt: "date" },
          { key: "days_late", label: "Days late", fmt: "days" },
          { key: "planned_qty", label: "Planned qty", fmt: "num" },
          { key: "actual_qty", label: "Actual qty", fmt: "num" },
          { key: "status", label: "Status", fmt: "badge" },
        ],
        lateTable,
        { caseKey: "case_id" },
      ),
      table(
        "Rejections and replacements",
        [
          { key: "po_number", label: "PO" },
          { key: "vendor_name", label: "Vendor" },
          { key: "inspection_date", label: "Inspected", fmt: "date" },
          { key: "qty_inspected", label: "Inspected qty", fmt: "num" },
          { key: "qty_rejected", label: "Rejected", fmt: "num" },
          { key: "rejection_reason", label: "Reason" },
          { key: "replacement_dispatches", label: "Replacement dispatches", fmt: "int" },
        ],
        rejections,
        { caseKey: "case_id" },
      ),
      table(
        "Invoices with an outstanding balance",
        [
          { key: "invoice_id", label: "Invoice" },
          { key: "vendor_name", label: "Vendor" },
          { key: "net_payable", label: "Net payable", fmt: "money" },
          { key: "amount_paid", label: "Paid", fmt: "money" },
          { key: "outstanding_amount", label: "Outstanding", fmt: "money" },
          { key: "verification_status", label: "Verification", fmt: "badge" },
          { key: "payment_status", label: "Payment", fmt: "badge" },
          { key: "payment_due_date", label: "Due", fmt: "date" },
          { key: "days_overdue", label: "Overdue", fmt: "days" },
        ],
        invoices,
        { caseKey: "case_id" },
      ),
    ],
    notes: [
      "A milestone is late when its status is Delayed, or it is still open after its planned date at the as-of date.",
      "Invoice reconciliation checks run in the Audit module (invoice quantity vs acceptance certificate, paid vs net payable).",
    ],
  };
}

// ───────────────────────────── Vendors ─────────────────────────────

export function vendorFlags(row: RecordRow): string[] {
  const flags: string[] = [];
  if (Number(row.avg_on_time) > 0 && Number(row.avg_on_time) < 70) flags.push(`On-time delivery ${Number(row.avg_on_time).toFixed(0)}%`);
  if (Number(row.avg_rejection) > 10) flags.push(`Quality rejection ${Number(row.avg_rejection).toFixed(0)}%`);
  if (Number(row.avg_sla) > 0 && Number(row.avg_sla) < 80) flags.push(`SLA compliance ${Number(row.avg_sla).toFixed(0)}%`);
  if (Number(row.late_milestones) >= 3) flags.push(`${row.late_milestones} late milestones`);
  if (Number(row.disputes) > 0) flags.push(`${row.disputes} payment disputes`);
  if (Number(row.disqualified_bids) >= 3) flags.push(`${row.disqualified_bids} technical disqualifications`);
  if (Number(row.incomplete_docs) >= 3) flags.push(`${row.incomplete_docs} incomplete submissions`);
  if (String(row.registration_status).startsWith("Suspended")) flags.push("Registration suspended");
  return flags;
}

const VENDOR_AGG = `
WITH perf AS (
  SELECT vendor_id, AVG(on_time_delivery_pct) AS avg_on_time, AVG(quality_rejection_pct) AS avg_rejection,
         AVG(sla_compliance_pct) AS avg_sla, AVG(overall_score) AS avg_score, SUM(payment_disputes) AS disputes
  FROM vendor_performance GROUP BY vendor_id),
con AS (SELECT vendor_id, COUNT(*) AS contracts, SUM(contract_value) AS contract_value FROM contract_master GROUP BY vendor_id),
late AS (SELECT p.vendor_id, COUNT(*) AS late_milestones FROM delivery_milestones m JOIN purchase_orders p ON p.po_number = m.po_number
         WHERE m.delay_days > 0 OR (m.actual_date IS NULL AND m.planned_date < {ASOF}) GROUP BY p.vendor_id),
pen AS (SELECT p.vendor_id, SUM(pr.penalty_amount) AS penalties FROM penalty_register pr JOIN purchase_orders p ON p.po_number = pr.po_number WHERE pr.status <> 'Waived' GROUP BY p.vendor_id),
bids AS (SELECT vendor_id, COUNT(*) AS bids, SUM(CASE WHEN submission_status <> 'Submitted' OR documents_complete = 'false' THEN 1 ELSE 0 END) AS incomplete_docs FROM bidder_submissions GROUP BY vendor_id),
dq AS (SELECT vendor_id, SUM(CASE WHEN result = 'Technically Disqualified' THEN 1 ELSE 0 END) AS disqualified_bids FROM technical_evaluations GROUP BY vendor_id)
SELECT v.vendor_id, v.company_name, v.state, v.msme_class, v.is_oem, v.vendor_risk_classification AS risk_class, v.registration_status,
       COALESCE(con.contracts,0) AS contracts, COALESCE(con.contract_value,0) AS contract_value,
       ROUND(perf.avg_on_time,1) AS avg_on_time, ROUND(perf.avg_rejection,1) AS avg_rejection, ROUND(perf.avg_sla,1) AS avg_sla,
       ROUND(perf.avg_score,1) AS avg_score, COALESCE(perf.disputes,0) AS disputes, COALESCE(late.late_milestones,0) AS late_milestones,
       COALESCE(pen.penalties,0) AS penalties, COALESCE(bids.bids,0) AS bids, COALESCE(bids.incomplete_docs,0) AS incomplete_docs,
       COALESCE(dq.disqualified_bids,0) AS disqualified_bids
FROM vendor_master v LEFT JOIN perf ON perf.vendor_id = v.vendor_id LEFT JOIN con ON con.vendor_id = v.vendor_id
LEFT JOIN late ON late.vendor_id = v.vendor_id LEFT JOIN pen ON pen.vendor_id = v.vendor_id
LEFT JOIN bids ON bids.vendor_id = v.vendor_id LEFT JOIN dq ON dq.vendor_id = v.vendor_id`;

export function vendorScorecards(): RecordRow[] {
  return q(`${VENDOR_AGG} ORDER BY contract_value DESC`).map((row) => ({
    ...row,
    flags: vendorFlags(row).join("; ") || "None recorded",
    flag_count: vendorFlags(row).length,
  }));
}

function vendors(): ModuleView {
  const asOf = getStore().asOf;
  const cards = vendorScorecards();
  const withContracts = cards.filter((row) => Number(row.contracts) > 0);
  const avg = (key: string) => {
    const values = cards.map((row) => row[key]).filter((v): v is number => typeof v === "number");
    return values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
  };
  const kpis: Kpi[] = [
    { label: "Registered vendors", value: cards.length, fmt: "int" },
    { label: "Vendors with contracts", value: withContracts.length, fmt: "int" },
    { label: "Classified high risk", value: cards.filter((row) => row.risk_class === "High").length, fmt: "int", tone: "warn" },
    { label: "Suspended or under review", value: cards.filter((row) => String(row.registration_status) !== "Active").length, fmt: "int", tone: "warn" },
    { label: "Average on-time delivery", value: avg("avg_on_time"), fmt: "pct" },
    { label: "Average quality rejection", value: avg("avg_rejection"), fmt: "pct" },
    { label: "Vendors with 3+ late milestones", value: cards.filter((row) => Number(row.late_milestones) >= 3).length, fmt: "int", tone: "warn" },
    { label: "Vendors with 3+ disqualifications", value: cards.filter((row) => Number(row.disqualified_bids) >= 3).length, fmt: "int" },
  ];
  const charts: Chart[] = [
    bars("Vendors by risk classification", q(`SELECT vendor_risk_classification AS label, COUNT(*) AS value FROM vendor_master GROUP BY 1 ORDER BY 2 DESC`), { fmt: "int" }),
    bars("Performance ratings across assessments", q(`SELECT rating AS label, COUNT(*) AS value FROM vendor_performance GROUP BY 1 ORDER BY 2 DESC`), { fmt: "int" }),
    bars("Vendors by MSME class", q(`SELECT msme_class AS label, COUNT(*) AS value FROM vendor_master GROUP BY 1 ORDER BY 2 DESC`), { fmt: "int" }),
    {
      title: "Top vendors by contract value",
      kind: "bars",
      fmt: "money",
      data: withContracts.slice(0, 10).map((row) => ({ label: String(row.company_name), value: Number(row.contract_value), drill: `vendor:${row.vendor_id}` })),
    },
  ];
  return {
    id: "vendors",
    title: "Vendor intelligence",
    summary: "Evidence-backed scorecards built from performance assessments, milestones, penalties and bid history.",
    asOf,
    kpis,
    charts,
    tables: [
      table(
        "Vendor scorecards",
        [
          { key: "company_name", label: "Vendor" },
          { key: "risk_class", label: "Source risk class", fmt: "badge" },
          { key: "contracts", label: "Contracts", fmt: "int" },
          { key: "contract_value", label: "Contract value", fmt: "money" },
          { key: "avg_on_time", label: "On-time %", fmt: "pct" },
          { key: "avg_rejection", label: "Rejection %", fmt: "pct" },
          { key: "avg_sla", label: "SLA %", fmt: "pct" },
          { key: "avg_score", label: "Score", fmt: "num" },
          { key: "late_milestones", label: "Late milestones", fmt: "int" },
          { key: "disqualified_bids", label: "Disqualified bids", fmt: "int" },
          { key: "flags", label: "Indicators from evidence" },
        ],
        cards,
        { vendorKey: "vendor_id", subtitle: "Select a vendor for the evidence behind each indicator" },
      ),
    ],
    notes: [
      "Indicators summarise recorded events. They are prompts for review and are not findings about any vendor's conduct.",
      "Vendor names and identifiers are fictional.",
    ],
  };
}

// ───────────────────────────── Audit ─────────────────────────────

export function runAuditRules(): Array<{ rule: (typeof AUDIT_RULES)[number]; rows: RecordRow[] }> {
  return AUDIT_RULES.map((rule) => ({ rule, rows: q(rule.sql) }));
}

function audit(): ModuleView {
  const asOf = getStore().asOf;
  const results = runAuditRules();
  const total = results.reduce((sum, item) => sum + item.rows.length, 0);
  const high = results.filter((item) => item.rule.severity === "High").reduce((sum, item) => sum + item.rows.length, 0);
  const kpis: Kpi[] = [
    { label: "Audit rules run", value: results.length, fmt: "int" },
    { label: "Exceptions for review", value: total, fmt: "int", tone: total ? "warn" : "good" },
    { label: "Rules with no exceptions", value: results.filter((item) => item.rows.length === 0).length, fmt: "int", tone: "good" },
    { label: "High-severity exceptions", value: high, fmt: "int", tone: high ? "bad" : "good" },
    { label: "Open risk-register items", value: scalar("SELECT COUNT(*) FROM procurement_risk_register WHERE status = 'Open'"), fmt: "int", drill: "open_risks" },
    { label: "Risk exposure (open items)", value: scalar("SELECT SUM(exposure_amount) FROM procurement_risk_register WHERE status = 'Open'"), fmt: "money" },
  ];
  const charts: Chart[] = [
    {
      title: "Exceptions by audit rule",
      kind: "bars",
      fmt: "int",
      data: results
        .filter((item) => item.rows.length > 0)
        .map((item) => ({ label: `${item.rule.id} ${item.rule.title}`, value: item.rows.length, drill: `audit:${item.rule.id}` })),
    },
    bars("Open risks by type", q(`SELECT risk_type AS label, COUNT(*) AS value FROM procurement_risk_register WHERE status = 'Open' GROUP BY 1 ORDER BY 2 DESC`), { fmt: "int" }),
    bars("Open risks by severity", q(`SELECT severity AS label, COUNT(*) AS value FROM procurement_risk_register WHERE status = 'Open' GROUP BY 1 ORDER BY 2 DESC`), { fmt: "int" }),
  ];
  const register: RecordRow[] = results
    .flatMap((item): RecordRow[] => item.rows.map((row) => ({ ...row, rule_id: item.rule.id, severity: item.rule.severity, rule: item.rule.title })))
    .sort((a, b) => (a.severity === b.severity ? Number(b.amount) - Number(a.amount) : a.severity === "High" ? -1 : 1))
    .slice(0, 150);
  const corrective = q(`SELECT r.risk_id, r.case_id, r.risk_type, r.severity, o.officer_name AS owner, r.recommended_action,
        r.exposure_amount, r.raised_date, CAST(julianday({ASOF}) - julianday(r.raised_date) AS INTEGER) AS age_days, r.status
      FROM procurement_risk_register r LEFT JOIN employee_officer_master o ON o.officer_id = r.owner_officer_id
      WHERE r.status = 'Open' ORDER BY CASE r.severity WHEN 'Critical' THEN 0 WHEN 'High' THEN 1 ELSE 2 END, r.exposure_amount DESC LIMIT 60`);

  return {
    id: "audit",
    title: "Audit & compliance intelligence",
    summary: "Rule-based exceptions with record-level evidence, and tracking of open corrective actions.",
    asOf,
    kpis,
    charts,
    tables: [
      table(
        "Audit rules",
        [
          { key: "rule_id", label: "Rule" },
          { key: "title", label: "Check" },
          { key: "severity", label: "Severity", fmt: "badge" },
          { key: "exceptions", label: "Exceptions", fmt: "int" },
          { key: "basis", label: "Data evaluated" },
        ],
        results.map((item) => ({
          rule_id: item.rule.id,
          title: item.rule.title,
          severity: item.rule.severity,
          exceptions: item.rows.length,
          basis: item.rule.basis,
        })),
      ),
      table(
        "Exception register",
        [
          { key: "rule_id", label: "Rule" },
          { key: "severity", label: "Severity", fmt: "badge" },
          { key: "case_id", label: "Case" },
          { key: "ref", label: "Record" },
          { key: "evidence", label: "Evidence" },
          { key: "amount", label: "Amount", fmt: "money" },
        ],
        register,
        { caseKey: "case_id", subtitle: "Showing up to 150 items. Open the case to read the source documents." },
      ),
      table(
        "Corrective-action tracker",
        [
          { key: "risk_id", label: "Risk" },
          { key: "risk_type", label: "Type" },
          { key: "severity", label: "Severity", fmt: "badge" },
          { key: "owner", label: "Owner" },
          { key: "recommended_action", label: "Recommended action" },
          { key: "exposure_amount", label: "Exposure", fmt: "money" },
          { key: "age_days", label: "Open for", fmt: "days" },
        ],
        corrective,
        { caseKey: "case_id" },
      ),
    ],
    notes: [
      "An exception is a record that departs from a stated rule. It is a prompt for human review, not evidence of wrongdoing.",
      "Each rule states the exact tables compared; zero exceptions means the rule found none in the loaded data.",
    ],
  };
}

const BUILDERS: Record<string, () => ModuleView> = {
  overview,
  tenders,
  evaluation,
  finance,
  workflow,
  contracts,
  delivery,
  vendors,
  audit,
};

const cache = new Map<string, ModuleView>();

export function getModule(id: string): ModuleView | null {
  const builder = BUILDERS[id];
  if (!builder) return null;
  const key = `${currentScopeKey()}::${id}`;
  let view = cache.get(key);
  if (!view) {
    view = builder();
    cache.set(key, view);
  }
  return view;
}
