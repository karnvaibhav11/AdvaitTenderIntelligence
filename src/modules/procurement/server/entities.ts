import { existsSync } from "node:fs";
import path from "node:path";
import type {
  CaseFilters,
  CaseList,
  CaseSummary,
  DataTable,
  DetailField,
  DetailSection,
  DocumentList,
  DocumentRef,
  EntityDetail,
  RecordRow,
  Tone,
} from "../shared/types";
import { getStore } from "./db";
import { resolveDrill } from "./drills";
import { currentScopeKey, q, scalar, table, vendorFlags, vendorScorecards, runAuditRules } from "./modules";

const str = (value: unknown): string => (value === null || value === undefined ? "" : String(value));
const num = (value: unknown): number => (typeof value === "number" ? value : Number(value) || 0);

// ───────────────────────────── Case register ─────────────────────────────

const SORTS: Record<string, string> = {
  recent: "last_updated DESC, case_id DESC",
  risk: "risk_score DESC, delay_days DESC",
  value: "COALESCE(NULLIF(award_value,0), estimated_value) DESC",
  delay: "delay_days DESC, risk_score DESC",
  oldest: "started_date ASC",
};

function toSummary(row: RecordRow): CaseSummary {
  return {
    caseId: str(row.case_id),
    tenderId: row.tender_id ? str(row.tender_id) : null,
    title: str(row.title) || str(row.case_id),
    department: str(row.department_name),
    category: str(row.category_name),
    stage: str(row.current_stage_name),
    status: str(row.current_status),
    priority: str(row.priority),
    riskCategory: str(row.risk_category),
    riskScore: num(row.risk_score),
    estimatedValue: num(row.estimated_value),
    awardValue: num(row.award_value),
    delayDays: num(row.delay_days),
    vendorName: row.vendor_name ? str(row.vendor_name) : null,
    nextAction: str(row.next_action),
    startedDate: str(row.started_date),
  };
}

const facetCache = new Map<string, CaseList["facets"]>();

function getFacets(): CaseList["facets"] {
  const key = currentScopeKey();
  const cached = facetCache.get(key);
  if (cached) return cached;
  const facets: CaseList["facets"] = {
    stages: q("SELECT current_stage_name AS v FROM procurement_cases GROUP BY 1 ORDER BY MIN(current_stage)").map((r) => str(r.v)),
    statuses: q("SELECT DISTINCT current_status AS v FROM procurement_cases ORDER BY 1").map((r) => str(r.v)),
    risks: ["Critical", "High", "Medium", "Low"],
    departments: q("SELECT department_id AS id, department_name AS name FROM department_master ORDER BY 2").map((r) => ({ id: str(r.id), name: str(r.name) })),
    categories: q("SELECT category_id AS id, category_name AS name FROM procurement_category_master ORDER BY 2").map((r) => ({ id: str(r.id), name: str(r.name) })),
    scenarios: q("SELECT DISTINCT scenario AS v FROM procurement_cases ORDER BY 1").map((r) => str(r.v)),
  };
  facetCache.set(key, facets);
  return facets;
}

export function listCases(filters: CaseFilters): CaseList {
  const where: string[] = [];
  const params: Array<string | number> = [];
  let drillTitle: string | undefined;

  if (filters.drill) {
    const drill = resolveDrill(filters.drill);
    if (!drill) throw new Error(`Unknown drill: ${filters.drill}`);
    drillTitle = drill.title;
    where.push(`case_id IN (${drill.sql})`);
    params.push(...drill.params);
  }
  if (filters.q?.trim()) {
    const like = `%${filters.q.trim().toLowerCase()}%`;
    where.push(
      `(LOWER(case_id) LIKE ? OR LOWER(COALESCE(tender_id,'')) LIKE ? OR LOWER(COALESCE(title,'')) LIKE ? OR LOWER(COALESCE(vendor_name,'')) LIKE ?
        OR LOWER(COALESCE(po_number,'')) LIKE ? OR LOWER(COALESCE(contract_number,'')) LIKE ? OR LOWER(COALESCE(category_name,'')) LIKE ?)`,
    );
    params.push(like, like, like, like, like, like, like);
  }
  const equals: Array<[string | undefined, string]> = [
    [filters.stage, "current_stage_name"],
    [filters.status, "current_status"],
    [filters.risk, "risk_category"],
    [filters.department, "department_id"],
    [filters.category, "category_id"],
    [filters.scenario, "scenario"],
  ];
  for (const [value, column] of equals) {
    if (value) {
      where.push(`${column} = ?`);
      params.push(value);
    }
  }
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const total = scalar(`SELECT COUNT(*) FROM v_case ${clause}`, params);
  const limit = Math.min(Math.max(filters.limit ?? 50, 1), 200);
  const offset = Math.max(filters.offset ?? 0, 0);
  const rows = q(
    `SELECT * FROM v_case ${clause} ORDER BY ${SORTS[filters.sort ?? "recent"] ?? SORTS.recent} LIMIT ${limit} OFFSET ${offset}`,
    params,
  );
  return { total, rows: rows.map(toSummary), facets: getFacets(), drillTitle };
}

// ───────────────────────────── Documents ─────────────────────────────

export function documentPath(relativePath: string): string {
  const { documentsDir } = getStore();
  return path.resolve(documentsDir, relativePath.replace(/^documents\//, ""));
}

function toDocument(row: RecordRow): DocumentRef {
  return {
    documentId: str(row.document_id),
    docType: str(row.doc_type),
    title: str(row.title),
    stage: str(row.stage_name),
    version: num(row.version),
    pages: num(row.page_count),
    createdDate: str(row.created_date),
    caseId: str(row.case_id),
    available: existsSync(documentPath(str(row.relative_path))),
  };
}

export function findDocument(documentId: string): { path: string; ref: DocumentRef } | null {
  const row = q("SELECT * FROM document_metadata WHERE document_id = ?", [documentId])[0];
  if (!row) return null;
  const ref = toDocument(row);
  return { path: documentPath(str(row.relative_path)), ref };
}

export function listDocuments(params: { q?: string; type?: string; limit?: number; offset?: number }): DocumentList {
  const where: string[] = [];
  const values: Array<string | number> = [];
  if (params.q?.trim()) {
    const like = `%${params.q.trim().toLowerCase()}%`;
    where.push("(LOWER(document_id) LIKE ? OR LOWER(title) LIKE ? OR LOWER(case_id) LIKE ? OR LOWER(COALESCE(tender_id,'')) LIKE ? OR LOWER(COALESCE(po_number,'')) LIKE ?)");
    values.push(like, like, like, like, like);
  }
  if (params.type) {
    where.push("doc_type = ?");
    values.push(params.type);
  }
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const limit = Math.min(Math.max(params.limit ?? 40, 1), 200);
  const offset = Math.max(params.offset ?? 0, 0);
  return {
    total: scalar(`SELECT COUNT(*) FROM document_metadata ${clause}`, values),
    rows: q(`SELECT * FROM document_metadata ${clause} ORDER BY created_date DESC, document_id LIMIT ${limit} OFFSET ${offset}`, values).map(toDocument),
    docTypes: q("SELECT doc_type AS id, COUNT(*) AS count FROM document_metadata GROUP BY 1 ORDER BY 2 DESC").map((r) => ({
      id: str(r.id),
      count: num(r.count),
    })),
  };
}

// ───────────────────────────── Detail helpers ─────────────────────────────

function fields(row: RecordRow | undefined, defs: Array<[string, string, DetailField["fmt"]?]>): DetailField[] {
  if (!row) return [];
  return defs
    .map(([key, label, fmt]) => ({ label, value: (row[key] ?? null) as DetailField["value"], fmt }))
    .filter((field) => field.value !== null && field.value !== "");
}

function toneFor(value: string): Tone {
  if (/critical|high|reject|disqual|overdue|disput|cancel/i.test(value)) return "bad";
  if (/medium|pending|partial|delay|review|open/i.test(value)) return "warn";
  if (/low|paid|closed|approved|accepted|complete/i.test(value)) return "good";
  return "neutral";
}

function section(
  id: string,
  title: string,
  content: Partial<DetailSection>,
): DetailSection | null {
  const hasContent =
    (content.fields?.length ?? 0) > 0 ||
    content.tables?.some((t) => t.rows.length > 0) ||
    (content.matrix?.rows.length ?? 0) > 0;
  return hasContent ? { id, title, ...content } : null;
}

const auditCache = new Map<string, Map<string, RecordRow[]>>();

function auditExceptionsFor(caseId: string): RecordRow[] {
  const key = currentScopeKey();
  let auditByCase = auditCache.get(key);
  if (!auditByCase) {
    auditByCase = new Map();
    auditCache.set(key, auditByCase);
    for (const { rule, rows } of runAuditRules()) {
      for (const row of rows) {
        const key = str(row.case_id);
        const list = auditByCase.get(key) ?? [];
        list.push({ rule_id: rule.id, severity: rule.severity, check: rule.title, ref: row.ref, evidence: row.evidence, amount: row.amount });
        auditByCase.set(key, list);
      }
    }
  }
  return auditByCase.get(caseId) ?? [];
}

function caseDocuments(caseId: string): DocumentRef[] {
  return q("SELECT * FROM document_metadata WHERE case_id = ? ORDER BY stage, created_date, document_id", [caseId]).map(toDocument);
}

// ───────────────────────────── Case detail ─────────────────────────────

export function caseDetail(caseId: string): EntityDetail | null {
  const c = q("SELECT * FROM v_case WHERE case_id = ?", [caseId])[0];
  if (!c) return null;
  const requisition = q("SELECT * FROM requisitions WHERE case_id = ?", [caseId])[0];
  const tenders = q("SELECT * FROM v_tender WHERE case_id = ? ORDER BY publish_date", [caseId]);
  const tenderIds = tenders.map((t) => str(t.tender_id));
  const sections: Array<DetailSection | null> = [];

  sections.push(
    section("summary", "Case summary", {
      fields: fields(c, [
        ["case_id", "Case ID"],
        ["requisition_id", "Requisition"],
        ["tender_id", "Current tender"],
        ["po_number", "Purchase order"],
        ["contract_number", "Contract"],
        ["department_name", "Department"],
        ["category_name", "Category"],
        ["procurement_type", "Type"],
        ["route", "Route"],
        ["scenario", "Dataset scenario"],
        ["criticality", "Criticality"],
        ["priority", "Priority"],
        ["estimated_value", "Estimated value", "money"],
        ["award_value", "Award value", "money"],
        ["vendor_name", "Awarded vendor"],
        ["current_stage_name", "Current stage"],
        ["current_status", "Status"],
        ["next_action", "Next action"],
        ["due_date", "Action due", "date"],
        ["delay_days", "Delay", "days"],
        ["escalation_level", "Escalation level", "int"],
        ["risk_score", "Risk score", "num"],
        ["risk_factors", "Risk factors"],
        ["started_date", "Started", "date"],
        ["last_updated", "Last updated", "date"],
      ]),
      notes: ["Risk scores come from the source risk register and flag items for review."],
    }),
  );

  const budget = q("SELECT * FROM budget_controls WHERE requisition_id = ?", [str(c.requisition_id)]);
  const link = q("SELECT link_type, asset_type, work_order_id, work_order_status, note FROM procurement_operational_links WHERE case_id = ?", [caseId]);
  sections.push(
    section("requirement", "Requirement & budget", {
      fields: fields(requisition, [
        ["item_description", "Requirement"],
        ["requisition_type", "Requisition type"],
        ["technical_requirement", "Technical requirement"],
        ["reason", "Justification"],
        ["total_quantity", "Quantity", "num"],
        ["uom", "UoM"],
        ["required_by_date", "Required by", "date"],
        ["budget_head", "Budget head"],
        ["existing_stock", "Existing stock", "num"],
        ["consumption_rate_per_month", "Consumption per month", "num"],
        ["supporting_documents", "Supporting documents"],
      ]),
      tables: [
        table("Budget certificate", [
          { key: "financial_year", label: "FY" },
          { key: "approved_budget", label: "Approved", fmt: "money" },
          { key: "committed_before", label: "Committed", fmt: "money" },
          { key: "requested_amount", label: "Requested", fmt: "money" },
          { key: "available_after", label: "Available after", fmt: "money" },
          { key: "status", label: "Status", fmt: "badge" },
        ], budget),
        table("Linked operational record", [
          { key: "link_type", label: "Link" },
          { key: "asset_type", label: "Asset type" },
          { key: "work_order_id", label: "Work order" },
          { key: "work_order_status", label: "Work order status", fmt: "badge" },
          { key: "note", label: "Note" },
        ], link),
      ],
    }),
  );

  const approvals = q(
    `SELECT a.step_no, a.stage, o.officer_name AS approver, o.designation, a.submitted_date, a.decision_date, a.decision, a.delay_days, a.remarks
     FROM approvals a LEFT JOIN employee_officer_master o ON o.officer_id = a.approver_officer_id
     WHERE a.requisition_id = ? ORDER BY a.step_no, a.submitted_date`,
    [str(c.requisition_id)],
  );
  const events = q(
    `SELECT e.event_at, e.entity_type, e.entity_id, e.from_status, e.to_status, o.officer_name AS actor, e.note
     FROM procurement_audit_events e LEFT JOIN employee_officer_master o ON o.officer_id = e.actor_officer_id
     WHERE e.case_id = ? ORDER BY e.event_at, e.audit_id`,
    [caseId],
  );
  sections.push(
    section("approvals", "Approvals & activity trail", {
      tables: [
        table("Approval workflow", [
          { key: "step_no", label: "Step", fmt: "int" },
          { key: "stage", label: "Stage" },
          { key: "approver", label: "Approver" },
          { key: "submitted_date", label: "Submitted", fmt: "date" },
          { key: "decision_date", label: "Decided", fmt: "date" },
          { key: "decision", label: "Decision", fmt: "badge" },
          { key: "delay_days", label: "Delay", fmt: "days" },
          { key: "remarks", label: "Remarks" },
        ], approvals),
        table("Recorded status changes", [
          { key: "event_at", label: "When" },
          { key: "entity_type", label: "Entity" },
          { key: "entity_id", label: "Record" },
          { key: "from_status", label: "From" },
          { key: "to_status", label: "To", fmt: "badge" },
          { key: "actor", label: "By" },
          { key: "note", label: "Note" },
        ], events, { subtitle: `${events.length} events from the audit-event repository` }),
      ],
    }),
  );

  for (const tender of tenders) {
    const tid = str(tender.tender_id);
    const eligibility = q("SELECT criterion_type, parameter, threshold_value, mandatory, evidence_required FROM tender_eligibility_criteria WHERE tender_id = ? ORDER BY criterion_id", [tid]);
    const terms = q("SELECT term_type, clause_no, term_text FROM tender_terms WHERE tender_id = ? ORDER BY term_id", [tid]);
    const corrigenda = q("SELECT version_from || ' → ' || version_to AS version, issued_date, change_type, description, new_bid_end_at FROM tender_corrigenda WHERE tender_id = ? ORDER BY issued_date", [tid]);
    const clarifications = q("SELECT clarification_type, asked_at, question, answer, answered_at, status FROM tender_clarifications WHERE tender_id = ? ORDER BY asked_at", [tid]);
    const milestones = q("SELECT milestone, planned_at, actual_at, status FROM tender_milestones WHERE tender_id = ? ORDER BY planned_at", [tid]);
    const extracted = q(
      `SELECT f.field_name, f.field_value, f.page, f.document_id, f.matches_structured_data
       FROM document_extracted_fields f JOIN document_metadata d ON d.document_id = f.document_id
       WHERE d.tender_id = ? AND d.doc_type = 'BID' ORDER BY f.page, f.field_id`,
      [tid],
    );
    const lines = q("SELECT line_no, description, quantity, uom, estimated_unit_price, estimated_line_value, hsn_sac_code FROM tender_line_items WHERE tender_id = ? ORDER BY line_no", [tid]);
    sections.push(
      section(`tender-${tid}`, `Tender ${tid}`, {
        description: tenders.length > 1 ? "This case has more than one tender (for example, a re-tender)." : undefined,
        fields: fields(tender, [
          ["status", "Status"],
          ["bid_type", "Bid type"],
          ["evaluation_method", "Evaluation method"],
          ["publish_date", "Published", "date"],
          ["original_bid_end_at", "Original bid end"],
          ["bid_end_at", "Current bid end"],
          ["bid_opening_at", "Bid opening"],
          ["extension_count", "Extensions", "int"],
          ["current_version", "Document version", "int"],
          ["retender_of", "Re-tender of"],
          ["cancellation_reason", "Cancellation reason"],
          ["emd_amount", "EMD", "money"],
          ["epbg_percent", "ePBG %", "num"],
          ["min_avg_turnover", "Minimum turnover", "money"],
          ["experience_years", "Experience (years)", "int"],
          ["delivery_days", "Delivery days", "int"],
          ["contract_period", "Contract period"],
          ["offer_validity_days", "Offer validity (days)", "int"],
          ["bids_received", "Bids received", "int"],
          ["policy_version", "Policy rule version"],
        ]),
        tables: [
          table("Eligibility criteria", [
            { key: "criterion_type", label: "Type" },
            { key: "parameter", label: "Parameter" },
            { key: "threshold_value", label: "Requirement" },
            { key: "mandatory", label: "Mandatory", fmt: "badge" },
            { key: "evidence_required", label: "Evidence required" },
          ], eligibility),
          table("Terms and conditions", [
            { key: "term_type", label: "Clause type" },
            { key: "clause_no", label: "No.", fmt: "int" },
            { key: "term_text", label: "Condition" },
          ], terms),
          table("Version history: corrigenda", [
            { key: "version", label: "Version" },
            { key: "issued_date", label: "Issued", fmt: "date" },
            { key: "change_type", label: "Change", fmt: "badge" },
            { key: "description", label: "Amendment" },
            { key: "new_bid_end_at", label: "Revised bid end" },
          ], corrigenda, { subtitle: "Original conditions are version 1; each row supersedes the previous version" }),
          table("Pre-bid clarifications", [
            { key: "clarification_type", label: "Type" },
            { key: "asked_at", label: "Asked" },
            { key: "question", label: "Question" },
            { key: "answer", label: "Departmental response" },
            { key: "status", label: "Status", fmt: "badge" },
          ], clarifications),
          table("Tender schedule", [
            { key: "milestone", label: "Milestone" },
            { key: "planned_at", label: "Planned" },
            { key: "actual_at", label: "Actual" },
            { key: "status", label: "Status", fmt: "badge" },
          ], milestones),
          table("Line items", [
            { key: "line_no", label: "#", fmt: "int" },
            { key: "description", label: "Description" },
            { key: "quantity", label: "Qty", fmt: "num" },
            { key: "uom", label: "UoM" },
            { key: "estimated_unit_price", label: "Est. unit price", fmt: "money" },
            { key: "estimated_line_value", label: "Est. value", fmt: "money" },
            { key: "hsn_sac_code", label: "HSN/SAC" },
          ], lines),
          table("Fields read from the bid document PDF (with page)", [
            { key: "field_name", label: "Field" },
            { key: "field_value", label: "Value in document" },
            { key: "page", label: "Page", fmt: "int" },
            { key: "document_id", label: "Source document" },
            { key: "matches_structured_data", label: "Matches register", fmt: "badge" },
          ], extracted, { documentKey: "document_id", subtitle: "Parsed from the PDF text and checked against the structured tender register" }),
        ],
      }),
    );
  }

  if (tenderIds.length) {
    const marks = tenderIds.map(() => "?").join(",");
    const comparative = q(
      `SELECT cs.tender_id, v.company_name, cs.vendor_id, te.total_score, te.cutoff_score, cs.technical_result, cs.quoted_total,
              fe.quoted_vs_estimate_pct, fe.price_reasonableness, cs.status AS rank_status, te.disqualification_reason,
              (SELECT COUNT(*) FROM bidder_document_checklist d WHERE d.submission_id = cs.submission_id AND d.validity <> 'Valid') AS document_gaps,
              te.committee_ref
       FROM comparative_statements cs
       JOIN vendor_master v ON v.vendor_id = cs.vendor_id
       LEFT JOIN technical_evaluations te ON te.submission_id = cs.submission_id
       LEFT JOIN financial_evaluations fe ON fe.submission_id = cs.submission_id
       WHERE cs.tender_id IN (${marks})
       ORDER BY cs.tender_id, CASE WHEN cs.status = 'Disqualified' THEN 99 ELSE CAST(substr(cs.status,2) AS INTEGER) END, cs.quoted_total`,
      tenderIds,
    );
    const deficiencies = q(
      `SELECT d.tender_id, v.company_name, d.document_name, d.validity, d.remarks
       FROM bidder_document_checklist d JOIN bidder_submissions s ON s.submission_id = d.submission_id
       JOIN vendor_master v ON v.vendor_id = s.vendor_id
       WHERE d.tender_id IN (${marks}) AND d.validity <> 'Valid' ORDER BY d.tender_id, v.company_name`,
      tenderIds,
    );
    const unmet = q(
      `SELECT e.tender_id, v.company_name, ec.parameter, e.required_value, e.bidder_value, e.remarks
       FROM bidder_eligibility e JOIN tender_eligibility_criteria ec ON ec.criterion_id = e.criterion_id
       JOIN vendor_master v ON v.vendor_id = e.vendor_id
       WHERE e.tender_id IN (${marks}) AND e.met = 'false' ORDER BY e.tender_id, v.company_name`,
      tenderIds,
    );
    const paramRows = q(
      `SELECT te.tender_id, te.vendor_id, v.company_name, p.parameter, p.marks_awarded, p.max_marks, p.comment
       FROM technical_evaluation_parameters p JOIN technical_evaluations te ON te.tech_eval_id = p.tech_eval_id
       JOIN vendor_master v ON v.vendor_id = te.vendor_id
       WHERE te.tender_id = ? ORDER BY p.param_id`,
      [tenderIds[tenderIds.length - 1]],
    );
    const vendorsInMatrix = [...new Set(paramRows.map((r) => str(r.company_name)))];
    const parametersInMatrix = [...new Set(paramRows.map((r) => str(r.parameter)))];
    const matrixRows = parametersInMatrix.map((parameter) => ({
      label: parameter,
      cells: vendorsInMatrix.map((vendor) => {
        const hit = paramRows.find((r) => r.parameter === parameter && r.company_name === vendor);
        if (!hit) return { text: "–" };
        const full = num(hit.marks_awarded) >= num(hit.max_marks);
        return {
          text: `${num(hit.marks_awarded)}/${num(hit.max_marks)}${hit.comment ? ` · ${hit.comment}` : ""}`,
          tone: (full ? "good" : "bad") as Tone,
        };
      }),
    }));
    const ra = q(
      `SELECT r.ra_id, v.company_name, r.initial_price, r.final_price, r.reduction_pct, r.final_rank, r.outcome
       FROM reverse_auction_results r JOIN reverse_auction_master m ON m.ra_id = r.ra_id
       JOIN vendor_master v ON v.vendor_id = r.vendor_id WHERE m.tender_id IN (${marks}) ORDER BY r.ra_id, r.final_rank`,
      tenderIds,
    );
    sections.push(
      section("evaluation", "Bid evaluation (decision support)", {
        description:
          "Compliance and price comparison for the evaluation committee. This view never disqualifies or selects a bidder.",
        tables: [
          table("Comparative statement", [
            { key: "tender_id", label: "Tender" },
            { key: "company_name", label: "Bidder" },
            { key: "technical_result", label: "Technical", fmt: "badge" },
            { key: "total_score", label: "Score", fmt: "num" },
            { key: "cutoff_score", label: "Cut-off", fmt: "num" },
            { key: "quoted_total", label: "Quoted total", fmt: "money" },
            { key: "quoted_vs_estimate_pct", label: "vs estimate", fmt: "pct" },
            { key: "rank_status", label: "Rank", fmt: "badge" },
            { key: "document_gaps", label: "Document gaps", fmt: "int" },
            { key: "disqualification_reason", label: "Reason recorded" },
          ], comparative, { vendorKey: "vendor_id" }),
          table("Missing or expired documents", [
            { key: "tender_id", label: "Tender" },
            { key: "company_name", label: "Bidder" },
            { key: "document_name", label: "Document" },
            { key: "validity", label: "Status", fmt: "badge" },
            { key: "remarks", label: "Remarks" },
          ], deficiencies),
          table("Eligibility criteria not met", [
            { key: "tender_id", label: "Tender" },
            { key: "company_name", label: "Bidder" },
            { key: "parameter", label: "Criterion" },
            { key: "required_value", label: "Required" },
            { key: "bidder_value", label: "Bidder value" },
            { key: "remarks", label: "Remarks" },
          ], unmet),
          table("Reverse auction outcome", [
            { key: "ra_id", label: "Auction" },
            { key: "company_name", label: "Bidder" },
            { key: "initial_price", label: "Initial price", fmt: "money" },
            { key: "final_price", label: "Final price", fmt: "money" },
            { key: "reduction_pct", label: "Reduction", fmt: "pct" },
            { key: "final_rank", label: "Rank", fmt: "int" },
            { key: "outcome", label: "Outcome", fmt: "badge" },
          ], ra),
        ],
        matrix: matrixRows.length
          ? { title: "Technical compliance matrix (latest tender)", columns: vendorsInMatrix, rows: matrixRows }
          : undefined,
      }),
    );
  }

  const award = q(
    `SELECT a.*, v.company_name, o.officer_name AS approver FROM award_decisions a
     LEFT JOIN vendor_master v ON v.vendor_id = a.recommended_vendor_id
     LEFT JOIN employee_officer_master o ON o.officer_id = a.approved_by WHERE a.case_id = ?`,
    [caseId],
  )[0];
  const po = c.po_number ? q("SELECT * FROM v_po WHERE po_number = ?", [str(c.po_number)])[0] : undefined;
  const poLines = c.po_number
    ? q("SELECT description, quantity, uom, unit_price, taxable_value, gst_pct, tax_value, line_total FROM purchase_order_line_items WHERE po_number = ?", [str(c.po_number)])
    : [];
  const contract = c.contract_number ? q("SELECT * FROM contract_master WHERE contract_number = ?", [str(c.contract_number)])[0] : undefined;
  const variations = c.contract_number
    ? q("SELECT variation_type, approved_date, previous_end_date, new_end_date, value_change, reason FROM contract_variations WHERE contract_number = ?", [str(c.contract_number)])
    : [];
  const security = c.contract_number
    ? q("SELECT percent, amount, instrument, issue_date, valid_until, status FROM performance_security WHERE contract_number = ?", [str(c.contract_number)])
    : [];
  sections.push(
    section("award", "Award, purchase order & contract", {
      fields: [
        ...fields(award, [
          ["evaluation_basis", "Evaluation basis"],
          ["company_name", "Recommended vendor"],
          ["recommended_date", "Recommended", "date"],
          ["approver", "Approved by"],
          ["approval_date", "Approval date", "date"],
          ["approval_status", "Approval status"],
          ["approved_value", "Approved value", "money"],
          ["remarks", "Evaluation remarks"],
        ]),
        ...fields(po, [
          ["po_date", "PO date", "date"],
          ["total_value", "PO value (incl. tax)", "money"],
          ["payment_terms", "Payment terms"],
          ["expected_delivery_date", "Expected delivery", "date"],
          ["warranty_months", "Warranty (months)", "int"],
          ["ld_terms", "Liquidated damages"],
          ["sla_clause", "SLA clause"],
        ]),
        ...fields(contract, [
          ["start_date", "Contract start", "date"],
          ["original_end_date", "Original end", "date"],
          ["end_date", "Current end", "date"],
          ["status", "Contract status"],
        ]),
      ],
      tables: [
        table("PO line items", [
          { key: "description", label: "Item" },
          { key: "quantity", label: "Qty", fmt: "num" },
          { key: "uom", label: "UoM" },
          { key: "unit_price", label: "Unit price", fmt: "money" },
          { key: "taxable_value", label: "Taxable", fmt: "money" },
          { key: "gst_pct", label: "GST %", fmt: "num" },
          { key: "line_total", label: "Line total", fmt: "money" },
        ], poLines),
        table("Contract amendments", [
          { key: "variation_type", label: "Type" },
          { key: "approved_date", label: "Approved", fmt: "date" },
          { key: "previous_end_date", label: "Previous end", fmt: "date" },
          { key: "new_end_date", label: "New end", fmt: "date" },
          { key: "reason", label: "Reason" },
        ], variations),
        table("Performance security", [
          { key: "percent", label: "%", fmt: "num" },
          { key: "amount", label: "Amount", fmt: "money" },
          { key: "instrument", label: "Instrument" },
          { key: "valid_until", label: "Valid until", fmt: "date" },
          { key: "status", label: "Status", fmt: "badge" },
        ], security),
      ],
    }),
  );

  if (c.po_number) {
    const po_number = str(c.po_number);
    const milestones = q("SELECT milestone_no, milestone_type, planned_date, planned_qty, actual_date, actual_qty, status, delay_days FROM delivery_milestones WHERE po_number = ? ORDER BY milestone_no", [po_number]);
    const receipts = q(
      `SELECT r.receipt_date, r.qty_received, r.condition, g.grn_id, g.store_location,
              (SELECT d.challan_ref FROM dispatch_records d WHERE d.dispatch_id = r.dispatch_id) AS challan,
              (SELECT d.is_replacement FROM dispatch_records d WHERE d.dispatch_id = r.dispatch_id) AS replacement
       FROM delivery_receipts r LEFT JOIN goods_receipt_notes g ON g.receipt_id = r.receipt_id WHERE r.po_number = ? ORDER BY r.receipt_date`,
      [po_number],
    );
    const inspections = q(
      "SELECT inspection_id, inspection_date, inspection_type, qty_inspected, qty_accepted, qty_rejected, result, rejection_reason FROM inspection_records WHERE po_number = ? ORDER BY inspection_date",
      [po_number],
    );
    const acceptance = q("SELECT acceptance_id, certificate_type, accepted_qty, issue_date, status FROM acceptance_certificates WHERE po_number = ? ORDER BY issue_date", [po_number]);
    const ordered = scalar("SELECT SUM(quantity) FROM purchase_order_line_items WHERE po_number = ?", [po_number]);
    const accepted = scalar("SELECT SUM(accepted_qty) FROM acceptance_certificates WHERE po_number = ?", [po_number]);
    sections.push(
      section("delivery", "Delivery, inspection & acceptance", {
        fields: [
          { label: "Ordered quantity", value: ordered, fmt: "num" },
          { label: "Accepted quantity", value: accepted, fmt: "num" },
          { label: "Pending quantity", value: Math.max(ordered - accepted, 0), fmt: "num" },
        ],
        tables: [
          table("Delivery milestones", [
            { key: "milestone_no", label: "#", fmt: "int" },
            { key: "milestone_type", label: "Type" },
            { key: "planned_date", label: "Planned", fmt: "date" },
            { key: "planned_qty", label: "Planned qty", fmt: "num" },
            { key: "actual_date", label: "Actual", fmt: "date" },
            { key: "actual_qty", label: "Actual qty", fmt: "num" },
            { key: "status", label: "Status", fmt: "badge" },
            { key: "delay_days", label: "Delay", fmt: "days" },
          ], milestones),
          table("Goods receipt", [
            { key: "receipt_date", label: "Received", fmt: "date" },
            { key: "qty_received", label: "Qty", fmt: "num" },
            { key: "condition", label: "Condition" },
            { key: "grn_id", label: "GRN" },
            { key: "challan", label: "Challan" },
            { key: "replacement", label: "Replacement lot", fmt: "badge" },
          ], receipts),
          table("Inspections", [
            { key: "inspection_id", label: "Inspection" },
            { key: "inspection_date", label: "Date", fmt: "date" },
            { key: "qty_inspected", label: "Inspected", fmt: "num" },
            { key: "qty_accepted", label: "Accepted", fmt: "num" },
            { key: "qty_rejected", label: "Rejected", fmt: "num" },
            { key: "result", label: "Result", fmt: "badge" },
            { key: "rejection_reason", label: "Rejection reason" },
          ], inspections),
          table("Acceptance certificates", [
            { key: "acceptance_id", label: "Certificate" },
            { key: "certificate_type", label: "Type" },
            { key: "accepted_qty", label: "Accepted qty", fmt: "num" },
            { key: "issue_date", label: "Issued", fmt: "date" },
          ], acceptance),
        ],
      }),
    );

    const invoices = q(
      "SELECT invoice_id, invoice_date, accepted_qty, total_amount, deduction, net_payable, amount_paid, outstanding_amount, verification_status, payment_status, payment_due_date FROM invoice_register WHERE po_number = ? ORDER BY invoice_date",
      [po_number],
    );
    const payments = q("SELECT payment_ref, invoice_id, payment_date, amount, payment_status, payment_mode, tds_amount FROM payment_register WHERE po_number = ? ORDER BY payment_date", [po_number]);
    const penalties = q("SELECT penalty_type, delay_days, penalty_amount, status, computed_basis FROM penalty_register WHERE po_number = ?", [po_number]);
    const warranty = q("SELECT warranty_id, warranty_start, warranty_end, coverage, status FROM warranty_register WHERE po_number = ?", [po_number]);
    sections.push(
      section("finance", "Invoices, payments & warranty", {
        tables: [
          table("Invoices", [
            { key: "invoice_id", label: "Invoice" },
            { key: "invoice_date", label: "Date", fmt: "date" },
            { key: "accepted_qty", label: "Accepted qty", fmt: "num" },
            { key: "total_amount", label: "Invoice total", fmt: "money" },
            { key: "deduction", label: "Deductions", fmt: "money" },
            { key: "net_payable", label: "Net payable", fmt: "money" },
            { key: "amount_paid", label: "Paid", fmt: "money" },
            { key: "outstanding_amount", label: "Outstanding", fmt: "money" },
            { key: "verification_status", label: "Verification", fmt: "badge" },
            { key: "payment_status", label: "Payment", fmt: "badge" },
          ], invoices),
          table("Payments", [
            { key: "payment_ref", label: "Reference" },
            { key: "invoice_id", label: "Invoice" },
            { key: "payment_date", label: "Date", fmt: "date" },
            { key: "amount", label: "Amount", fmt: "money" },
            { key: "tds_amount", label: "TDS", fmt: "money" },
            { key: "payment_status", label: "Status", fmt: "badge" },
          ], payments),
          table("Penalties and liquidated damages", [
            { key: "penalty_type", label: "Type" },
            { key: "delay_days", label: "Delay", fmt: "days" },
            { key: "penalty_amount", label: "Amount", fmt: "money" },
            { key: "status", label: "Status", fmt: "badge" },
            { key: "computed_basis", label: "Basis" },
          ], penalties),
          table("Warranty", [
            { key: "warranty_id", label: "Warranty" },
            { key: "warranty_start", label: "Start", fmt: "date" },
            { key: "warranty_end", label: "End", fmt: "date" },
            { key: "coverage", label: "Coverage" },
            { key: "status", label: "Status", fmt: "badge" },
          ], warranty),
        ],
      }),
    );
  }

  const risks = q(
    `SELECT r.risk_id, r.risk_type, r.severity, o.officer_name AS owner, r.recommended_action, r.exposure_amount, r.raised_date, r.status
     FROM procurement_risk_register r LEFT JOIN employee_officer_master o ON o.officer_id = r.owner_officer_id WHERE r.case_id = ?`,
    [caseId],
  );
  const exceptions = auditExceptionsFor(caseId);
  sections.push(
    section("audit", "Risks & audit exceptions", {
      tables: [
        table("Risk register", [
          { key: "risk_type", label: "Risk" },
          { key: "severity", label: "Severity", fmt: "badge" },
          { key: "owner", label: "Owner" },
          { key: "recommended_action", label: "Recommended action" },
          { key: "exposure_amount", label: "Exposure", fmt: "money" },
          { key: "raised_date", label: "Raised", fmt: "date" },
          { key: "status", label: "Status", fmt: "badge" },
        ], risks),
        table("Rule-based audit exceptions", [
          { key: "rule_id", label: "Rule" },
          { key: "severity", label: "Severity", fmt: "badge" },
          { key: "check", label: "Check" },
          { key: "ref", label: "Record" },
          { key: "evidence", label: "Evidence" },
        ], exceptions, { subtitle: "Prompts for human review, not findings of wrongdoing" }),
      ],
    }),
  );

  return {
    kind: "case",
    id: caseId,
    title: str(c.title) || caseId,
    subtitle: `${caseId} · ${str(c.department_name)} · ${str(c.category_name)}`,
    badges: [
      { label: str(c.current_status), tone: toneFor(str(c.current_status)) },
      { label: `${str(c.risk_category)} risk`, tone: toneFor(str(c.risk_category)) },
      { label: str(c.current_stage_name) },
      ...(num(c.delay_days) > 0 && !/closed|cancel|reject/i.test(str(c.current_status)) ? [{ label: `${num(c.delay_days)} days past SLA`, tone: "warn" as Tone }] : []),
    ],
    sections: sections.filter((s): s is DetailSection => s !== null),
    documents: caseDocuments(caseId),
  };
}

// ───────────────────────────── Vendor detail ─────────────────────────────

export function vendorDetail(vendorId: string): EntityDetail | null {
  const vendor = q("SELECT * FROM vendor_master WHERE vendor_id = ?", [vendorId])[0];
  if (!vendor) return null;
  const card = vendorScorecards().find((row) => row.vendor_id === vendorId);
  const flags = card ? vendorFlags(card) : [];
  const sections: Array<DetailSection | null> = [];

  sections.push(
    section("profile", "Vendor profile (synthetic)", {
      fields: fields(vendor, [
        ["vendor_id", "Vendor ID"],
        ["gstin_like", "GSTIN-like ID"],
        ["pan_like", "PAN-like ID"],
        ["registered_address", "Registered address"],
        ["state", "State"],
        ["msme_class", "MSME class"],
        ["is_startup", "Startup"],
        ["is_oem", "OEM"],
        ["mii_class", "Make in India class"],
        ["annual_turnover", "Annual turnover", "money"],
        ["years_in_operation", "Years in operation", "int"],
        ["past_government_contracts", "Past government contracts", "int"],
        ["product_categories", "Product categories"],
        ["vendor_risk_classification", "Source risk class"],
        ["registration_status", "Registration"],
      ]),
      notes: [str(vendor.identifier_note)].filter(Boolean),
    }),
  );

  const evidence = card
    ? [
        { indicator: "Average on-time delivery", evidence: `${card.avg_on_time ?? "n/a"}% across vendor_performance assessments` },
        { indicator: "Average quality rejection", evidence: `${card.avg_rejection ?? "n/a"}% across vendor_performance assessments` },
        { indicator: "Average SLA compliance", evidence: `${card.avg_sla ?? "n/a"}%` },
        { indicator: "Late milestones", evidence: `${card.late_milestones} milestones delivered late or still open past plan` },
        { indicator: "Payment disputes", evidence: `${card.disputes}` },
        { indicator: "Penalties and LD", evidence: `₹${Math.round(num(card.penalties)).toLocaleString("en-IN")} excluding waived` },
        { indicator: "Bids submitted", evidence: `${card.bids}, of which ${card.incomplete_docs} incomplete, withdrawn or with missing documents` },
        { indicator: "Technical disqualifications", evidence: `${card.disqualified_bids}` },
      ]
    : [];
  sections.push(
    section("indicators", "Risk indicators and the evidence behind them", {
      description: flags.length ? `Triggered: ${flags.join("; ")}` : "No indicator thresholds were triggered by the recorded data.",
      tables: [table("Evidence", [{ key: "indicator", label: "Measure" }, { key: "evidence", label: "Recorded evidence" }], evidence)],
      notes: ["Thresholds: on-time below 70%, rejection above 10%, SLA below 80%, 3+ late milestones, any dispute, 3+ disqualifications. They prompt review; they do not establish fault."],
    }),
  );
  sections.push(
    section("performance", "Performance assessments", {
      tables: [
        table("Assessments", [
          { key: "contract_number", label: "Contract" },
          { key: "assessment_date", label: "Date", fmt: "date" },
          { key: "on_time_delivery_pct", label: "On-time %", fmt: "pct" },
          { key: "quality_rejection_pct", label: "Rejection %", fmt: "pct" },
          { key: "sla_compliance_pct", label: "SLA %", fmt: "pct" },
          { key: "payment_disputes", label: "Disputes", fmt: "int" },
          { key: "overall_score", label: "Score", fmt: "num" },
          { key: "rating", label: "Rating", fmt: "badge" },
          { key: "remarks", label: "Remarks" },
        ], q("SELECT * FROM vendor_performance WHERE vendor_id = ? ORDER BY assessment_date DESC", [vendorId])),
      ],
    }),
  );
  sections.push(
    section("contracts", "Contracts", {
      tables: [
        table("Contracts", [
          { key: "contract_number", label: "Contract" },
          { key: "category_name", label: "Category" },
          { key: "start_date", label: "Start", fmt: "date" },
          { key: "end_date", label: "End", fmt: "date" },
          { key: "contract_value", label: "Value", fmt: "money" },
          { key: "status", label: "Status", fmt: "badge" },
        ], q(
          `SELECT cm.contract_number, p.case_id, p.category_name, cm.start_date, cm.end_date, cm.contract_value, cm.status
           FROM contract_master cm JOIN v_po p ON p.po_number = cm.po_number WHERE cm.vendor_id = ? ORDER BY cm.start_date DESC`,
          [vendorId],
        ), { caseKey: "case_id" }),
        table("Late or open-past-plan milestones", [
          { key: "po_number", label: "PO" },
          { key: "milestone_type", label: "Type" },
          { key: "planned_date", label: "Planned", fmt: "date" },
          { key: "actual_date", label: "Actual", fmt: "date" },
          { key: "delay_days", label: "Delay", fmt: "days" },
          { key: "status", label: "Status", fmt: "badge" },
        ], q(
          `SELECT p.case_id, m.po_number, m.milestone_type, m.planned_date, m.actual_date, m.delay_days, m.status
           FROM delivery_milestones m JOIN v_po p ON p.po_number = m.po_number
           WHERE p.vendor_id = ? AND (m.delay_days > 0 OR (m.actual_date IS NULL AND m.planned_date < {ASOF}))
           ORDER BY m.delay_days DESC LIMIT 30`,
          [vendorId],
        ), { caseKey: "case_id" }),
        table("Penalties and liquidated damages", [
          { key: "penalty_type", label: "Type" },
          { key: "delay_days", label: "Delay", fmt: "days" },
          { key: "penalty_amount", label: "Amount", fmt: "money" },
          { key: "status", label: "Status", fmt: "badge" },
          { key: "computed_basis", label: "Basis" },
        ], q(
          `SELECT p.case_id, pr.* FROM penalty_register pr JOIN v_po p ON p.po_number = pr.po_number WHERE p.vendor_id = ? ORDER BY pr.penalty_amount DESC`,
          [vendorId],
        ), { caseKey: "case_id" }),
      ],
    }),
  );
  sections.push(
    section("bids", "Bidding history", {
      tables: [
        table("Bids", [
          { key: "tender_id", label: "Tender" },
          { key: "submitted_at", label: "Submitted" },
          { key: "submission_status", label: "Submission", fmt: "badge" },
          { key: "technical_result", label: "Technical", fmt: "badge" },
          { key: "quoted_total", label: "Quoted", fmt: "money" },
          { key: "rank_status", label: "Rank", fmt: "badge" },
          { key: "disqualification_reason", label: "Reason recorded" },
        ], q(
          `SELECT s.tender_id, t.case_id, s.submitted_at, s.submission_status, cs.technical_result, cs.quoted_total, cs.status AS rank_status, te.disqualification_reason
           FROM bidder_submissions s JOIN tender_master t ON t.tender_id = s.tender_id
           LEFT JOIN comparative_statements cs ON cs.submission_id = s.submission_id
           LEFT JOIN technical_evaluations te ON te.submission_id = s.submission_id
           WHERE s.vendor_id = ? ORDER BY s.submitted_at DESC LIMIT 60`,
          [vendorId],
        ), { caseKey: "case_id" }),
      ],
    }),
  );

  const documents = q(
    `SELECT d.* FROM document_metadata d
     WHERE d.document_id IN (SELECT document_id FROM document_entity_links WHERE entity_type = 'vendor' AND entity_id = ?)
     ORDER BY d.created_date DESC LIMIT 40`,
    [vendorId],
  ).map(toDocument);

  const riskClass = str(vendor.vendor_risk_classification);
  return {
    kind: "vendor",
    id: vendorId,
    title: str(vendor.company_name),
    subtitle: `${vendorId} · ${str(vendor.state)} · ${str(vendor.msme_class)}`,
    badges: [
      { label: `${riskClass} source risk class`, tone: toneFor(riskClass) },
      { label: str(vendor.registration_status), tone: str(vendor.registration_status) === "Active" ? "good" : "warn" },
      ...(flags.length ? [{ label: `${flags.length} indicator${flags.length > 1 ? "s" : ""}`, tone: "warn" as Tone }] : []),
    ],
    sections: sections.filter((s): s is DetailSection => s !== null),
    documents,
  };
}

export type { DataTable };
