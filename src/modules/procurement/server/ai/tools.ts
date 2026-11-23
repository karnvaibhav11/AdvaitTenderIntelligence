import type { RecordRow } from "../../shared/types";
import { AUDIT_RULES } from "../audit-rules";
import { getStore } from "../db";
import { q, runAuditRules, scalar, vendorScorecards, vendorFlags } from "../modules";
import { type Permission, type Principal, hasPermission } from "../platform/rbac";
import { BUSINESS_RULES, type RiskClass } from "./business-rules";
import { type EvidenceInput, type Section, type ToolOutput } from "./ledger";
import { AI_VIEWS } from "./schema-catalog";
import { SqlRejected, runAgentSql } from "./sql-guard";

export interface ToolContext {
  principal: Principal;
  asOf: string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  /** Permission the caller must hold; tools the principal lacks are not offered to the model. */
  requires?: Permission;
  handler(args: Record<string, unknown>, ctx: ToolContext): ToolOutput | Promise<ToolOutput>;
}

// ───────────────────────────── Helpers ─────────────────────────────

export const str = (value: unknown): string | undefined => (typeof value === "string" && value.trim() ? value.trim() : undefined);
const numArg = (value: unknown): number | undefined => {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(n) ? n : undefined;
};
export const limitOf = (value: unknown, fallback = 25, max = 200) => Math.min(Math.max(Math.trunc(numArg(value) ?? fallback), 1), max);

export function section(title: string, rows: RecordRow[], formats?: Section["formats"]): Section {
  return { title, columns: rows[0] ? Object.keys(rows[0]) : [], rows, formats };
}

export const caseEvidence = (caseId: string): EvidenceInput => ({ kind: "record", type: "case", id: caseId, label: `Case ${caseId.replace("ADV-DEMO-", "")}`, caseId });

export function resolveCase(idOrText: string): { caseId: string; tenderId: string | null; requisitionId: string; poNumber: string | null; contractNumber: string | null } | null {
  const id = idOrText.trim().toUpperCase();
  const short = /^(?:TND|TENDER|CASE|PO|CON)[-\s#:]*0*(\d{1,6})$/.exec(id);
  const row = q(
    `SELECT case_id, tender_id, requisition_id, po_number, contract_number FROM ai_cases
     WHERE case_id = ? OR tender_id = ? OR po_number = ? OR contract_number = ? OR requisition_id = ?
        OR (? IS NOT NULL AND case_id LIKE '%-' || substr('000000' || ?, -6, 6))
     LIMIT 1`,
    [id, id, id, id, id, short ? short[1] : null, short ? short[1] : null],
  )[0];
  if (!row) {
    const tender = q("SELECT case_id FROM ai_tenders WHERE tender_id = ? LIMIT 1", [id])[0];
    if (!tender) return null;
    return resolveCase(String(tender.case_id));
  }
  return {
    caseId: String(row.case_id),
    tenderId: row.tender_id ? String(row.tender_id) : null,
    requisitionId: String(row.requisition_id),
    poNumber: row.po_number ? String(row.po_number) : null,
    contractNumber: row.contract_number ? String(row.contract_number) : null,
  };
}

export function notFound(id: string): ToolOutput {
  return { summary: `No record matching "${id}" is visible to this user. Nothing was inferred.`, sections: [], notes: ["The identifier may not exist or may be outside the user's department/area scope."] };
}

const ACTIVE = `status NOT IN ('Closed Case','Cancelled','Rejected')`;

/** Run a query with a row limit and also report the true total, so summaries never confuse "shown" with "found". */
function page(sql: string, params: Array<string | number | null>, limit: number): { rows: RecordRow[]; total: number } {
  const total = scalar(`SELECT COUNT(*) FROM (${sql})`, params);
  return { rows: q(`${sql} LIMIT ${limit}`, params), total };
}

const shown = (rows: number, total: number) => (total > rows ? ` Showing the first ${rows} of ${total}.` : "");

// ───────────────────────────── Tools ─────────────────────────────

const searchTenders: ToolDefinition = {
  name: "search_tenders",
  description:
    "Search and filter tenders. Use for questions about open, closing, delayed, single-bid, corrigendum-heavy, pending-evaluation or high-value tenders, by department/category/value. Returns tender_id, case_id, status, estimate, bid end date, bids received, corrigenda count and case delay.",
  parameters: {
    type: "object",
    properties: {
      text: { type: "string", description: "Free text matched against title, category, department and tender id" },
      status: { type: "string", description: "Exact tender status, e.g. 'Open for Bidding', 'Under Evaluation', 'Awarded', 'Cancelled', 'Re-Tendered', 'Extended'" },
      department: { type: "string", description: "Department name fragment" },
      category: { type: "string", description: "Category or category-group fragment" },
      closing_within_days: { type: "integer", description: "Only open tenders whose bid end date falls within this many days after the as-of date" },
      min_value: { type: "number", description: "Minimum estimated value in INR" },
      max_value: { type: "number", description: "Maximum estimated value in INR" },
      single_bid_only: { type: "boolean" },
      min_corrigenda: { type: "integer", description: "Minimum number of corrigenda" },
      delayed_only: { type: "boolean", description: "Only tenders whose procurement case is active and past its SLA (delay_days > 0)" },
      sort: { type: "string", enum: ["closing", "value", "delay", "corrigenda"] },
      limit: { type: "integer" },
    },
  },
  handler(args, ctx) {
    const where: string[] = [];
    const params: Array<string | number> = [];
    const text = str(args.text);
    if (text) {
      const like = `%${text.toLowerCase()}%`;
      where.push("(LOWER(t.title) LIKE ? OR LOWER(t.category) LIKE ? OR LOWER(t.department) LIKE ? OR LOWER(t.tender_id) LIKE ?)");
      params.push(like, like, like, like);
    }
    if (str(args.status)) {
      where.push("LOWER(t.status) = LOWER(?)");
      params.push(str(args.status)!);
    }
    if (str(args.department)) {
      where.push("LOWER(t.department) LIKE ?");
      params.push(`%${str(args.department)!.toLowerCase()}%`);
    }
    if (str(args.category)) {
      where.push("(LOWER(t.category) LIKE ? OR LOWER(t.category_group) LIKE ?)");
      params.push(`%${str(args.category)!.toLowerCase()}%`, `%${str(args.category)!.toLowerCase()}%`);
    }
    const closing = numArg(args.closing_within_days);
    if (closing !== undefined) {
      where.push(`t.status IN ('Open for Bidding','Extended') AND substr(t.bid_end_at,1,10) BETWEEN {ASOF} AND date({ASOF}, '+' || ? || ' day')`);
      params.push(Math.trunc(closing));
    }
    if (numArg(args.min_value) !== undefined) {
      where.push("t.estimated_value >= ?");
      params.push(numArg(args.min_value)!);
    }
    if (numArg(args.max_value) !== undefined) {
      where.push("t.estimated_value <= ?");
      params.push(numArg(args.max_value)!);
    }
    if (args.single_bid_only === true) where.push("t.bids_received = 1");
    if (numArg(args.min_corrigenda) !== undefined) {
      where.push("(SELECT COUNT(*) FROM ai_corrigenda x WHERE x.tender_id = t.tender_id) >= ?");
      params.push(numArg(args.min_corrigenda)!);
    }
    if (args.delayed_only === true) where.push(`c.delay_days > 0 AND c.${ACTIVE}`);
    const order = { closing: "t.bid_end_at", value: "t.estimated_value DESC", delay: "c.delay_days DESC", corrigenda: "corrigenda DESC" }[str(args.sort) ?? "closing"] ?? "t.bid_end_at";
    const rows = q(
      `SELECT t.tender_id, t.case_id, t.title, t.department, t.category, t.status, t.estimated_value, substr(t.bid_end_at,1,16) AS bid_end,
              t.bids_received, t.extension_count, t.current_version,
              (SELECT COUNT(*) FROM ai_corrigenda x WHERE x.tender_id = t.tender_id) AS corrigenda,
              c.stage AS case_stage, c.status AS case_status, c.delay_days
       FROM ai_tenders t LEFT JOIN ai_cases c ON c.case_id = t.case_id
       ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY ${order} LIMIT ${limitOf(args.limit)}`,
      params,
    );
    const total = scalar(`SELECT COUNT(*) FROM ai_tenders t LEFT JOIN ai_cases c ON c.case_id = t.case_id ${where.length ? "WHERE " + where.join(" AND ") : ""}`, params);
    return {
      summary: `${total} tender(s) match as of ${ctx.asOf}; showing ${rows.length}.`,
      sections: [section("Matching tenders", rows, { estimated_value: "money", delay_days: "days" })],
      notes: total > rows.length ? [`Only the first ${rows.length} of ${total} are shown; narrow the filters for the rest.`] : [],
    };
  },
};

const getTenderDetails: ToolDefinition = {
  name: "get_tender_details",
  description: "Full details of one tender or procurement case: tender conditions, eligibility criteria, terms, corrigenda, clarifications, line items, award, PO and contract. Accepts a case id, tender id, PO or contract number, or a short reference like TND-000123.",
  parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  handler(args, ctx) {
    const id = str(args.id) ?? "";
    const found = resolveCase(id);
    if (!found) return notFound(id);
    const tenderRows = q("SELECT * FROM ai_tenders WHERE case_id = ? ORDER BY publish_date", [found.caseId]);
    const tender = tenderRows[tenderRows.length - 1];
    const tid = tender ? String(tender.tender_id) : "";
    const caseRow = q("SELECT * FROM ai_cases WHERE case_id = ?", [found.caseId]);
    const sections: Section[] = [
      section("Case", caseRow, { estimated_value: "money", award_value: "money", delay_days: "days" }),
      section("Tenders for this case", tenderRows, { estimated_value: "money" }),
      section("Eligibility criteria", q("SELECT criterion_type, parameter, threshold_value, mandatory, evidence_required FROM ai_eligibility WHERE tender_id = ?", [tid])),
      section("Terms and conditions", q("SELECT term_type, clause_no, term_text FROM tender_terms WHERE tender_id = ? ORDER BY term_id", [tid])),
      section("Corrigenda", q("SELECT version_from, version_to, issued_date, change_type, description, new_bid_end_at FROM ai_corrigenda WHERE tender_id = ? ORDER BY issued_date", [tid])),
      section("Clarifications", q("SELECT clarification_type, asked_at, question, answer, status FROM tender_clarifications WHERE tender_id = ? ORDER BY asked_at", [tid])),
      section("Line items", q("SELECT line_no, description, quantity, uom, estimated_unit_price, estimated_line_value FROM tender_line_items WHERE tender_id = ? ORDER BY line_no", [tid]), { estimated_unit_price: "money", estimated_line_value: "money" }),
      section("Award", q("SELECT award_id, evaluation_basis, recommended_vendor_id AS vendor_id, recommended_date, approval_date, approval_status, approved_value FROM award_decisions WHERE case_id = ?", [found.caseId]), { approved_value: "money" }),
      section("Purchase order", q("SELECT po_number, vendor_id, vendor_name, po_date, total_value, expected_delivery_date, payment_terms, warranty_months FROM ai_pos WHERE case_id = ?", [found.caseId]), { total_value: "money" }),
      section("Contract", q("SELECT contract_number, start_date, end_date, original_end_date, contract_value, status, amendments FROM ai_contracts WHERE case_id = ?", [found.caseId]), { contract_value: "money" }),
    ].filter((s) => s.rows.length > 0);
    const docs = q("SELECT document_id, doc_type, title, version, page_count FROM ai_documents WHERE case_id = ? ORDER BY stage_name, created_date", [found.caseId]);
    const evidence: EvidenceInput[] = [caseEvidence(found.caseId), ...docs.slice(0, 6).map((d) => ({ kind: "document" as const, type: "document", id: String(d.document_id), label: `${d.title} (${d.doc_type})`, documentId: String(d.document_id), caseId: found.caseId, page: 1 }))];
    return { summary: `Details for case ${found.caseId} as of ${ctx.asOf}.`, sections: [...sections, section("Registered documents", docs)], evidence };
  },
};

const getTenderTimeline: ToolDefinition = {
  name: "get_tender_timeline",
  description:
    "Reconstruct the lifecycle of a procurement case and identify evidence-supported delay contributors: milestone dates and gaps, approval steps and pending approvals, tender extensions and corrigenda, bid document deficiencies, late deliveries, rejections, invoice/payment status. Use for 'why is this delayed' and lifecycle summaries.",
  parameters: { type: "object", properties: { id: { type: "string", description: "Case id, tender id, PO/contract number or TND-nnnnnn" } }, required: ["id"] },
  handler(args, ctx) {
    const found = resolveCase(str(args.id) ?? "");
    if (!found) return notFound(str(args.id) ?? "");
    const c = q("SELECT * FROM ai_cases WHERE case_id = ?", [found.caseId])[0];
    const req = q("SELECT requisition_date FROM requisitions WHERE case_id = ?", [found.caseId])[0];
    const tender = q("SELECT tender_id, publish_date, original_bid_end_at, bid_end_at, bid_opening_at, extension_count, status FROM ai_tenders WHERE case_id = ? ORDER BY publish_date DESC LIMIT 1", [found.caseId])[0];
    const award = q("SELECT recommended_date, approval_date, approval_status FROM award_decisions WHERE case_id = ?", [found.caseId])[0];
    const po = found.poNumber ? q("SELECT po_date, expected_delivery_date FROM ai_pos WHERE po_number = ?", [found.poNumber])[0] : undefined;
    const contract = found.contractNumber ? q("SELECT start_date, end_date FROM ai_contracts WHERE contract_number = ?", [found.contractNumber])[0] : undefined;
    const firstReceipt = found.poNumber ? q("SELECT MIN(receipt_date) AS d FROM ai_grn WHERE po_number = ?", [found.poNumber])[0] : undefined;
    const firstInvoice = found.poNumber ? q("SELECT MIN(invoice_date) AS d FROM ai_invoices WHERE po_number = ?", [found.poNumber])[0] : undefined;
    const lastPayment = found.poNumber ? q("SELECT MAX(payment_date) AS d FROM ai_payments WHERE po_number = ?", [found.poNumber])[0] : undefined;

    const events: Array<[string, unknown]> = [
      ["Requisition raised", req?.requisition_date],
      ["Tender published", tender?.publish_date],
      ["Bid submission closed", tender ? String(tender.bid_end_at).slice(0, 10) : null],
      ["Bids opened", tender ? String(tender.bid_opening_at).slice(0, 10) : null],
      ["Award recommended", award?.recommended_date],
      ["Award approved", award?.approval_date],
      ["Purchase order issued", po?.po_date],
      ["Contract start", contract?.start_date],
      ["First goods receipt", firstReceipt?.d],
      ["First invoice", firstInvoice?.d],
      ["Last payment", lastPayment?.d],
    ];
    let previous: string | null = null;
    const milestones = events
      .filter(([, date]) => typeof date === "string" && date)
      .map(([event, date]) => {
        const d = String(date);
        const gap = previous ? Math.round((Date.parse(d) - Date.parse(previous)) / 86_400_000) : null;
        previous = d;
        return { event, date: d, days_since_previous: gap };
      });

    const approvals = q("SELECT step_no, stage, approver_name, submitted_date, decision, decision_date, delay_days, remarks FROM ai_approvals WHERE case_id = ? ORDER BY step_no, submitted_date", [found.caseId]);
    const contributors: RecordRow[] = [];
    for (const a of approvals) {
      if (a.decision === "Pending") {
        const age = Math.round((Date.parse(ctx.asOf) - Date.parse(String(a.submitted_date))) / 86_400_000);
        contributors.push({ contributor: "Approval pending", detail: `${a.stage} approval has been pending ${age} days (submitted ${a.submitted_date}, approver ${a.approver_name ?? "unassigned"})`, days: age, source: "approvals" });
      } else if (Number(a.delay_days) > 0) {
        contributors.push({ contributor: "Approval delay", detail: `${a.stage} recorded ${a.delay_days} days of delay (${a.decision})`, days: Number(a.delay_days), source: "approvals" });
      }
      if (a.decision === "Returned" || a.decision === "Rejected") {
        contributors.push({ contributor: `Approval ${String(a.decision).toLowerCase()}`, detail: `${a.stage}: ${a.remarks ?? "no remarks recorded"}`, days: null, source: "approvals" });
      }
    }
    if (tender && Number(tender.extension_count) > 0) {
      const slip = Math.round((Date.parse(String(tender.bid_end_at)) - Date.parse(String(tender.original_bid_end_at))) / 86_400_000);
      contributors.push({ contributor: "Bid deadline extended", detail: `${tender.extension_count} extension(s); bid end moved ${slip} days from ${String(tender.original_bid_end_at).slice(0, 10)}`, days: slip, source: "tender register" });
    }
    const corrigenda = scalar("SELECT COUNT(*) FROM ai_corrigenda WHERE tender_id = ?", [tender ? String(tender.tender_id) : ""]);
    if (corrigenda > 0) contributors.push({ contributor: "Corrigenda issued", detail: `${corrigenda} corrigendum/corrigenda amended the tender`, days: null, source: "ai_corrigenda" });
    const deficits = tender
      ? q("SELECT COUNT(*) AS n FROM bidder_document_checklist WHERE tender_id = ? AND validity <> 'Valid'", [String(tender.tender_id)])[0]
      : undefined;
    if (deficits && Number(deficits.n) > 0) contributors.push({ contributor: "Bid document deficiencies", detail: `${deficits.n} missing or expired bidder document(s) were recorded`, days: null, source: "bidder_document_checklist" });
    if (found.poNumber) {
      const late = q("SELECT milestone_no, milestone_type, planned_date, actual_date, status, delay_days FROM ai_milestones WHERE po_number = ? AND (delay_days > 0 OR (actual_date IS NULL AND planned_date < {ASOF})) ORDER BY planned_date", [found.poNumber]);
      for (const m of late) contributors.push({ contributor: "Late delivery milestone", detail: `Milestone ${m.milestone_no} (${m.milestone_type}) planned ${m.planned_date}, ${m.actual_date ? `delivered ${m.actual_date}` : "not delivered"}; ${m.status}`, days: Number(m.delay_days) || null, source: "delivery_milestones" });
      const rej = q("SELECT SUM(qty_rejected) AS n FROM ai_inspections WHERE po_number = ?", [found.poNumber])[0];
      if (rej && Number(rej.n) > 0) contributors.push({ contributor: "Material rejected at inspection", detail: `${rej.n} unit(s) rejected; replacement/balance quantity pending`, days: null, source: "inspection_records" });
    }
    if (c && Number(c.delay_days) > 0 && !/closed|cancel|reject/i.test(String(c.status))) {
      contributors.push({ contributor: "Case past SLA", detail: `Case register shows ${c.delay_days} days past the SLA at stage "${c.stage}"; next action: ${c.next_action}`, days: Number(c.delay_days), source: "procurement_cases" });
    }
    const risks = q("SELECT risk_type, severity, recommended_action, exposure_amount FROM ai_risks WHERE case_id = ? AND status = 'Open'", [found.caseId]);

    return {
      summary: `Lifecycle of case ${found.caseId} (status ${c?.status}, stage ${c?.stage}; ${found.poNumber ? `PO ${found.poNumber}` : "no PO yet"}${found.contractNumber ? `, contract ${found.contractNumber}` : ""}${c?.vendor_name ? `, vendor ${c.vendor_name}` : ""}; ${Number(c?.delay_days) > 0 ? `${c?.delay_days} days past SLA` : "within SLA"}) with ${contributors.length} evidence-supported attention item(s).`,
      sections: [section("Milestones", milestones), section("Approval steps", approvals), section("Attention items and delay contributors", contributors), section("Open risk-register items", risks, { exposure_amount: "money" })].filter((s) => s.rows.length > 0),
      evidence: [caseEvidence(found.caseId)],
      notes: ["Delay contributors are listed only where a record supports them. A contributor's presence does not prove it caused the overall delay."],
    };
  },
};

const compareVendorBids: ToolDefinition = {
  name: "compare_vendor_bids",
  description: "Comparative statement for a tender: every bidder's technical result, score, quoted total, deviation from estimate, rank, document gaps and unmet eligibility criteria, with the L1 bidder identified. Quote columns are empty if the user has no financial-bid access.",
  parameters: { type: "object", properties: { tender_id: { type: "string", description: "Tender id, case id or TND-nnnnnn" } }, required: ["tender_id"] },
  handler(args) {
    const id = str(args.tender_id) ?? "";
    const found = resolveCase(id);
    if (!found) return notFound(id);
    const tenders = q("SELECT tender_id, estimated_value, evaluation_method, status FROM ai_tenders WHERE case_id = ? ORDER BY publish_date DESC", [found.caseId]);
    const tender = tenders[0];
    if (!tender) return notFound(id);
    const tid = String(tender.tender_id);
    const bids = q(
      `SELECT b.vendor_id, b.vendor_name, b.technical_result, b.total_score, b.cutoff_score, b.quoted_total, b.quoted_vs_estimate_pct, b.rank_status,
              b.submission_status, b.documents_complete, b.disqualification_reason,
              (SELECT COUNT(*) FROM bidder_document_checklist d WHERE d.submission_id = b.submission_id AND d.validity <> 'Valid') AS document_gaps
       FROM ai_bids b WHERE b.tender_id = ? ORDER BY CASE WHEN b.rank_status = 'Disqualified' THEN 99 WHEN b.rank_status IS NULL THEN 98 ELSE CAST(substr(b.rank_status,2) AS INTEGER) END, b.quoted_total`,
      [tid],
    );
    const unmet = q(
      `SELECT v.company_name AS vendor_name, e.vendor_id, ec.parameter, e.required_value, e.bidder_value, e.remarks
       FROM bidder_eligibility e JOIN tender_eligibility_criteria ec ON ec.criterion_id = e.criterion_id JOIN vendor_master v ON v.vendor_id = e.vendor_id
       WHERE e.tender_id = ? AND e.met = 'false'`,
      [tid],
    );
    const missing = q(
      `SELECT v.company_name AS vendor_name, s.vendor_id, d.document_name, d.validity, d.remarks
       FROM bidder_document_checklist d JOIN bidder_submissions s ON s.submission_id = d.submission_id JOIN vendor_master v ON v.vendor_id = s.vendor_id
       WHERE d.tender_id = ? AND d.validity <> 'Valid'`,
      [tid],
    );
    const qualified = bids.filter((b) => b.technical_result === "Technically Qualified" && typeof b.quoted_total === "number");
    const l1 = qualified.length ? qualified.reduce((a, b) => (Number(b.quoted_total) < Number(a.quoted_total) ? b : a)) : undefined;
    const cheapest = bids.filter((b) => typeof b.quoted_total === "number").reduce<RecordRow | undefined>((a, b) => (!a || Number(b.quoted_total) < Number(a.quoted_total) ? b : a), undefined);
    const financialVisible = bids.some((b) => typeof b.quoted_total === "number");
    const flags: RecordRow[] = [];
    for (const b of bids) {
      if (typeof b.quoted_vs_estimate_pct === "number" && Math.abs(b.quoted_vs_estimate_pct) > 30) flags.push({ vendor_name: b.vendor_name, vendor_id: b.vendor_id, flag: "Large deviation from estimate", detail: `${b.quoted_vs_estimate_pct}% versus estimate`, class: "anomaly" });
    }
    if (cheapest && cheapest.technical_result === "Technically Disqualified") flags.push({ vendor_name: cheapest.vendor_name, vendor_id: cheapest.vendor_id, flag: "Lowest quote was technically disqualified", detail: String(cheapest.disqualification_reason ?? "reason not recorded"), class: "anomaly" });
    if (bids.filter((b) => b.submission_status === "Submitted").length === 1) flags.push({ vendor_name: null, vendor_id: null, flag: "Single bid", detail: "Only one submitted bid", class: "risk_indicator" });
    return {
      summary: !financialVisible
        ? `Technical comparison for tender ${tid}: ${bids.length} bid(s). Financial bids are not visible to this user, so no price comparison or L1 can be given.`
        : `Tender ${tid} (${tender.evaluation_method}, status ${tender.status}): ${bids.length} bid(s), ${qualified.length} technically qualified. ${l1 ? `L1 among qualified bidders is ${l1.vendor_name} at ${l1.quoted_total}.` : "No qualified quote is available."}`,
      sections: [section("Comparative statement", bids, { quoted_total: "money", quoted_vs_estimate_pct: "pct" }), section("Eligibility criteria not met", unmet), section("Missing or expired documents", missing), section("Flags for human review", flags)].filter((s) => s.rows.length > 0),
      evidence: [caseEvidence(found.caseId)],
      notes: ["Decision support only: this system never disqualifies bidders or selects an award. L1 = lowest quote among technically qualified bidders; QCBS tenders rank on combined score."],
    };
  },
};

const getVendorPerformance: ToolDefinition = {
  name: "get_vendor_performance",
  description:
    "Vendor scorecards: contracts and value, on-time delivery %, quality rejection %, SLA %, late milestones, disputes, penalties, bid history, disqualifications and indicator flags with evidence. Look up by vendor id/name, rank vendors by contract value (top_n), list vendors with repeated delays (min_late_milestones) or incomplete documentation (min_incomplete_docs).",
  parameters: {
    type: "object",
    properties: {
      vendor: { type: "string", description: "Vendor id or name fragment" },
      top_n_by_contract_value: { type: "integer", description: "Return the N vendors with highest contract value" },
      min_late_milestones: { type: "integer", description: "Only vendors with at least this many late milestones" },
      min_incomplete_docs: { type: "integer", description: "Only vendors with at least this many incomplete/withdrawn/missing-document bids" },
      limit: { type: "integer" },
    },
  },
  handler(args) {
    let cards = vendorScorecards();
    const vendor = str(args.vendor)?.toLowerCase();
    if (vendor) cards = cards.filter((c) => String(c.vendor_id).toLowerCase() === vendor || String(c.company_name).toLowerCase().includes(vendor));
    if (numArg(args.min_late_milestones) !== undefined) cards = cards.filter((c) => Number(c.late_milestones) >= numArg(args.min_late_milestones)!);
    if (numArg(args.min_incomplete_docs) !== undefined) cards = cards.filter((c) => Number(c.incomplete_docs) >= numArg(args.min_incomplete_docs)!);
    if (numArg(args.top_n_by_contract_value) !== undefined) cards = [...cards].sort((a, b) => Number(b.contract_value) - Number(a.contract_value)).slice(0, limitOf(args.top_n_by_contract_value, 5, 50));
    const rows = cards.slice(0, limitOf(args.limit, 25, 100)).map((c) => ({
      vendor_id: c.vendor_id,
      vendor_name: c.company_name,
      source_risk_class: c.risk_class,
      contracts: c.contracts,
      contract_value: c.contract_value,
      avg_on_time_pct: c.avg_on_time,
      avg_quality_rejection_pct: c.avg_rejection,
      avg_sla_pct: c.avg_sla,
      avg_score: c.avg_score,
      late_milestones: c.late_milestones,
      payment_disputes: c.disputes,
      penalties_inr: c.penalties,
      bids: c.bids,
      incomplete_or_missing_doc_bids: c.incomplete_docs,
      technical_disqualifications: c.disqualified_bids,
      indicators: vendorFlags(c).join("; ") || "None triggered",
    }));
    return {
      summary: `${cards.length} vendor(s) match; showing ${rows.length}.`,
      sections: [section("Vendor scorecards", rows, { contract_value: "money", penalties_inr: "money", avg_on_time_pct: "pct", avg_quality_rejection_pct: "pct", avg_sla_pct: "pct" })],
      notes: ["Indicators summarise recorded events (thresholds: on-time < 70%, rejection > 10%, SLA < 80%, 3+ late milestones, any dispute, 3+ disqualifications). They prompt review and do not establish misconduct."],
    };
  },
};

const getPendingApprovals: ToolDefinition = {
  name: "get_pending_approvals",
  description: "Approvals awaiting a decision with age in days, stage, approver and case value. Filter by department, approval stage (Technical Review, Finance / Budget Review, Procurement Department, Department Head, Competent Authority) or minimum age. Also returns total value waiting for approval.",
  parameters: { type: "object", properties: { department: { type: "string" }, stage: { type: "string" }, older_than_days: { type: "integer" }, limit: { type: "integer" } } },
  handler(args, ctx) {
    const where = ["a.decision = 'Pending'"];
    const params: Array<string | number> = [];
    if (str(args.department)) {
      where.push("LOWER(c.department) LIKE ?");
      params.push(`%${str(args.department)!.toLowerCase()}%`);
    }
    if (str(args.stage)) {
      where.push("LOWER(a.stage) LIKE ?");
      params.push(`%${str(args.stage)!.toLowerCase()}%`);
    }
    if (numArg(args.older_than_days) !== undefined) {
      where.push("julianday({ASOF}) - julianday(a.submitted_date) > ?");
      params.push(numArg(args.older_than_days)!);
    }
    const rows = q(
      `SELECT a.approval_id, a.case_id, c.title, c.department, a.stage, a.approver_name, a.submitted_date,
              CAST(julianday({ASOF}) - julianday(a.submitted_date) AS INTEGER) AS age_days,
              COALESCE(NULLIF(c.award_value,0), c.estimated_value) AS case_value, c.status AS case_status
       FROM ai_approvals a JOIN ai_cases c ON c.case_id = a.case_id WHERE ${where.join(" AND ")} ORDER BY age_days DESC LIMIT ${limitOf(args.limit, 50)}`,
      params,
    );
    const totals = q(`SELECT COUNT(DISTINCT a.case_id) AS cases, SUM(COALESCE(NULLIF(c.award_value,0), c.estimated_value)) AS value FROM ai_approvals a JOIN ai_cases c ON c.case_id = a.case_id WHERE ${where.join(" AND ")}`, params)[0];
    return {
      summary: `${totals.cases} case(s) with a pending approval as of ${ctx.asOf}, total case value ${Math.round(Number(totals.value) || 0)} INR.`,
      sections: [section("Pending approvals", rows, { case_value: "money", age_days: "days" })],
      notes: [BUSINESS_RULES.approvalDelayed],
    };
  },
};

const getContractDeliveryStatus: ToolDefinition = {
  name: "get_contract_delivery_status",
  description:
    "Contract, PO and delivery status. Modes: 'detail' (one id), 'expiring' (contracts ending within N days), 'pending_delivery' (ordered quantity not yet accepted above a percentage), 'late_milestones', 'multiple_amendments', 'rejections', 'at_risk' (active contracts with late milestones or pending quantity and a near end date).",
  parameters: {
    type: "object",
    properties: {
      mode: { type: "string", enum: ["detail", "expiring", "pending_delivery", "late_milestones", "multiple_amendments", "rejections", "at_risk"] },
      id: { type: "string", description: "Case, tender, PO or contract id for detail mode" },
      expiring_within_days: { type: "integer" },
      pending_pct_gt: { type: "number", description: "Minimum share of ordered quantity not accepted, in percent" },
      min_amendments: { type: "integer" },
      department: { type: "string" },
      vendor: { type: "string" },
      limit: { type: "integer" },
    },
    required: ["mode"],
  },
  handler(args, ctx) {
    const mode = str(args.mode) ?? "detail";
    const limit = limitOf(args.limit, 40);
    const filters: string[] = [];
    const params: Array<string | number> = [];
    if (str(args.department)) {
      filters.push("LOWER(p.department) LIKE ?");
      params.push(`%${str(args.department)!.toLowerCase()}%`);
    }
    if (str(args.vendor)) {
      filters.push("(LOWER(p.vendor_name) LIKE ? OR p.vendor_id = ?)");
      params.push(`%${str(args.vendor)!.toLowerCase()}%`, str(args.vendor)!.toUpperCase());
    }
    const extra = filters.length ? " AND " + filters.join(" AND ") : "";
    const pendingCte = `WITH ordered AS (SELECT po_number, SUM(quantity) AS q FROM ai_po_lines GROUP BY po_number),
                              acc AS (SELECT po_number, SUM(accepted_qty) AS a FROM ai_acceptance GROUP BY po_number)`;
    if (mode === "detail") {
      const found = resolveCase(str(args.id) ?? "");
      if (!found) return notFound(str(args.id) ?? "");
      if (!found.poNumber) return { summary: `Case ${found.caseId} has no purchase order yet.`, sections: [], evidence: [caseEvidence(found.caseId)] };
      const lines = q(`${pendingCte} SELECT ROUND(o.q,2) AS ordered_qty, ROUND(COALESCE(a.a,0),2) AS accepted_qty, ROUND(o.q - COALESCE(a.a,0),2) AS pending_qty, ROUND((o.q - COALESCE(a.a,0))*100.0/o.q,1) AS pending_pct FROM ordered o LEFT JOIN acc a ON a.po_number = o.po_number WHERE o.po_number = ?`, [found.poNumber]);
      return {
        summary: `Delivery status of ${found.poNumber}: ${lines[0] ? `${lines[0].accepted_qty} of ${lines[0].ordered_qty} accepted (${lines[0].pending_pct}% pending)` : "no quantity data"}.`,
        sections: [
          section("Contract", q("SELECT * FROM ai_contracts WHERE po_number = ?", [found.poNumber]), { contract_value: "money" }),
          section("Quantity position", lines),
          section("Milestones", q("SELECT milestone_no, milestone_type, planned_date, planned_qty, actual_date, actual_qty, status, delay_days FROM ai_milestones WHERE po_number = ? ORDER BY milestone_no", [found.poNumber])),
          section("Goods receipts", q("SELECT receipt_id, grn_id, receipt_date, qty_received, condition FROM ai_grn WHERE po_number = ? ORDER BY receipt_date", [found.poNumber])),
          section("Inspections", q("SELECT inspection_id, inspection_date, qty_inspected, qty_accepted, qty_rejected, result, rejection_reason FROM ai_inspections WHERE po_number = ? ORDER BY inspection_date", [found.poNumber])),
          section("Amendments", q("SELECT variation_type, approved_date, previous_end_date, new_end_date, reason FROM ai_amendments WHERE contract_number = ?", [found.contractNumber ?? ""])),
        ].filter((s) => s.rows.length > 0),
        evidence: [caseEvidence(found.caseId)],
      };
    }
    if (mode === "expiring") {
      const days = Math.trunc(numArg(args.expiring_within_days) ?? 60);
      const { rows, total } = page(
        `SELECT p.contract_number, p.case_id, p.vendor_id, p.vendor_name, p.department, p.end_date, CAST(julianday(p.end_date) - julianday({ASOF}) AS INTEGER) AS days_left, p.contract_value, p.status, p.amendments
         FROM ai_contracts p WHERE p.status IN ('Active','Extended') AND p.end_date BETWEEN {ASOF} AND date({ASOF}, '+' || ? || ' day')${extra} ORDER BY p.end_date`,
        [days, ...params],
        limit,
      );
      return { summary: `${total} active/extended contract(s) end within ${days} days of ${ctx.asOf}.${shown(rows.length, total)}`, sections: [section("Contracts expiring", rows, { contract_value: "money", days_left: "days" })] };
    }
    if (mode === "pending_delivery" || mode === "at_risk") {
      const threshold = numArg(args.pending_pct_gt) ?? (mode === "at_risk" ? 0 : 20);
      const { rows, total } = page(
        `${pendingCte}
         SELECT p.contract_number, p.case_id, p.vendor_id, p.vendor_name, p.department, ROUND(o.q,2) AS ordered_qty, ROUND(COALESCE(a.a,0),2) AS accepted_qty,
                ROUND(o.q - COALESCE(a.a,0),2) AS pending_qty, ROUND((o.q - COALESCE(a.a,0))*100.0/o.q,1) AS pending_pct, p.end_date, p.status,
                (SELECT COUNT(*) FROM ai_milestones m WHERE m.po_number = p.po_number AND (m.delay_days > 0 OR (m.actual_date IS NULL AND m.planned_date < {ASOF}))) AS late_milestones
         FROM ai_contracts p JOIN ordered o ON o.po_number = p.po_number LEFT JOIN acc a ON a.po_number = p.po_number
         WHERE p.status IN ('Active','Extended') AND (o.q - COALESCE(a.a,0))*100.0/o.q > ?${extra}
         ${mode === "at_risk" ? "AND (late_milestones > 0 OR p.end_date <= date({ASOF}, '+90 day'))" : ""}
         ORDER BY pending_pct DESC, o.q DESC`,
        [threshold, ...params],
        limit,
      );
      return {
        summary: `${total} active/extended contract(s) with more than ${threshold}% of ordered quantity not yet accepted${mode === "at_risk" ? " and either a late milestone or an end date within 90 days" : ""}.${shown(rows.length, total)}`,
        sections: [section("Contracts", rows, { pending_pct: "pct" })],
        notes: [BUSINESS_RULES.pendingQuantity],
      };
    }
    if (mode === "late_milestones") {
      const { rows, total } = page(
        `SELECT m.milestone_id, m.case_id, m.po_number, m.vendor_id, m.vendor_name, m.department, m.milestone_type, m.planned_date, m.actual_date,
                CASE WHEN m.actual_date IS NOT NULL THEN m.delay_days ELSE CAST(julianday({ASOF}) - julianday(m.planned_date) AS INTEGER) END AS days_late, m.status
         FROM ai_milestones m WHERE (m.delay_days > 0 OR (m.actual_date IS NULL AND m.planned_date < {ASOF}))${extra.replaceAll("p.", "m.")} ORDER BY days_late DESC`,
        params,
        limit,
      );
      return { summary: `${total} late delivery milestone(s), longest first.${shown(rows.length, total)}`, sections: [section("Late milestones", rows, { days_late: "days" })], notes: [BUSINESS_RULES.delayedMilestone] };
    }
    if (mode === "multiple_amendments") {
      const min = Math.trunc(numArg(args.min_amendments) ?? 2);
      const { rows, total } = page(`SELECT p.contract_number, p.case_id, p.vendor_id, p.vendor_name, p.department, p.original_end_date, p.end_date, p.contract_value, p.amendments FROM ai_contracts p WHERE p.amendments >= ?${extra} ORDER BY p.amendments DESC`, [min, ...params], limit);
      return { summary: `${total} contract(s) have ${min} or more recorded amendments.${shown(rows.length, total)}`, sections: [section("Contracts with amendments", rows, { contract_value: "money" })] };
    }
    const { rows, total } = page(
      `SELECT i.inspection_id, i.case_id, i.po_number, i.vendor_id, i.vendor_name, i.inspection_date, i.qty_inspected, i.qty_rejected, i.rejection_reason
       FROM ai_inspections i WHERE i.qty_rejected > 0${extra.replaceAll("p.department", "(SELECT department FROM ai_pos x WHERE x.po_number = i.po_number)").replaceAll("p.", "i.")} ORDER BY i.inspection_date DESC`,
      params,
      limit,
    );
    return { summary: `${total} inspection(s) with rejected material (latest first).${shown(rows.length, total)}`, sections: [section("Rejections", rows)] };
  },
};

const getInvoicePaymentStatus: ToolDefinition = {
  name: "get_invoice_payment_status",
  description:
    "Invoice and payment intelligence. Modes: 'overdue' (past due with outstanding balance), 'outstanding_by_department', 'unreconciled_with_grn' (invoiced quantity above goods received or accepted), 'duplicate_indicators' (same vendor, PO and amount), 'pending_verification', 'detail' (one case/PO). Requires payments access.",
  requires: "data:payments",
  parameters: { type: "object", properties: { mode: { type: "string", enum: ["overdue", "outstanding_by_department", "unreconciled_with_grn", "duplicate_indicators", "pending_verification", "detail"] }, id: { type: "string" }, department: { type: "string" }, min_days_overdue: { type: "integer" }, limit: { type: "integer" } }, required: ["mode"] },
  handler(args, ctx) {
    const mode = str(args.mode) ?? "overdue";
    const limit = limitOf(args.limit, 40);
    const dept = str(args.department);
    const deptSql = dept ? " AND LOWER(i.department) LIKE ?" : "";
    const deptParams = dept ? [`%${dept.toLowerCase()}%`] : [];
    if (mode === "overdue") {
      const min = Math.trunc(numArg(args.min_days_overdue) ?? 0);
      const base = `SELECT i.invoice_id, i.case_id, i.po_number, i.vendor_id, i.vendor_name, i.department, i.payment_due_date, i.net_payable, i.amount_paid, i.outstanding_amount,
                CAST(julianday({ASOF}) - julianday(i.payment_due_date) AS INTEGER) AS days_overdue, i.payment_status, i.verification_status
         FROM ai_invoices i WHERE i.outstanding_amount > 1 AND i.payment_due_date < {ASOF} AND julianday({ASOF}) - julianday(i.payment_due_date) >= ?${deptSql} ORDER BY i.outstanding_amount DESC`;
      const { rows, total: count } = page(base, [min, ...deptParams], limit);
      const total = scalar(`SELECT COALESCE(SUM(outstanding_amount),0) FROM ai_invoices i WHERE i.outstanding_amount > 1 AND i.payment_due_date < {ASOF} AND julianday({ASOF}) - julianday(i.payment_due_date) >= ?${deptSql}`, [min, ...deptParams]);
      return { summary: `${count} overdue invoice(s) with ${Math.round(total)} INR outstanding in total as of ${ctx.asOf}.${shown(rows.length, count)}`, sections: [section("Overdue invoices", rows, { outstanding_amount: "money", net_payable: "money", amount_paid: "money", days_overdue: "days" })], notes: [BUSINESS_RULES.invoiceOverdue] };
    }
    if (mode === "outstanding_by_department") {
      const rows = q(`SELECT i.department, COUNT(*) AS invoices, SUM(i.outstanding_amount) AS outstanding, SUM(CASE WHEN i.payment_due_date < {ASOF} THEN i.outstanding_amount ELSE 0 END) AS overdue_outstanding FROM ai_invoices i WHERE i.outstanding_amount > 1${deptSql} GROUP BY i.department ORDER BY outstanding DESC`, deptParams);
      return { summary: `Outstanding invoice balance by department as of ${ctx.asOf}; total ${Math.round(rows.reduce((s, r) => s + Number(r.outstanding), 0))} INR.`, sections: [section("Outstanding by department", rows, { outstanding: "money", overdue_outstanding: "money" })] };
    }
    if (mode === "unreconciled_with_grn") {
      const rows = q(
        `WITH inv AS (SELECT po_number, SUM(accepted_qty) AS invoiced, COUNT(*) AS invoices FROM ai_invoices GROUP BY po_number),
              grn AS (SELECT po_number, SUM(qty_received) AS received FROM ai_grn GROUP BY po_number),
              acc AS (SELECT po_number, SUM(accepted_qty) AS accepted FROM ai_acceptance GROUP BY po_number)
         SELECT p.po_number, p.case_id, p.vendor_id, p.vendor_name, p.department, inv.invoices, ROUND(inv.invoiced,3) AS invoiced_qty, ROUND(COALESCE(grn.received,0),3) AS grn_received_qty,
                ROUND(COALESCE(acc.accepted,0),3) AS accepted_qty, ROUND(inv.invoiced - COALESCE(grn.received,0),3) AS excess_over_grn, ROUND(inv.invoiced - COALESCE(acc.accepted,0),3) AS excess_over_accepted
         FROM inv JOIN ai_pos p ON p.po_number = inv.po_number LEFT JOIN grn ON grn.po_number = inv.po_number LEFT JOIN acc ON acc.po_number = inv.po_number
         WHERE inv.invoiced > COALESCE(grn.received,0) + 0.001 OR inv.invoiced > COALESCE(acc.accepted,0) + 0.001 ORDER BY excess_over_accepted DESC LIMIT ${limit}`,
      );
      return {
        summary: rows.length ? `${rows.length} PO(s) have invoiced quantity above goods received or accepted quantity.` : "No PO has invoiced quantity above goods received or accepted quantity; invoices reconcile with GRNs and acceptance certificates.",
        sections: [section("Invoice vs GRN/acceptance", rows)],
        notes: ["Reconciliation compares total invoiced accepted_qty per PO with total GRN received quantity and total accepted quantity. A negative result is specific to the loaded data."],
      };
    }
    if (mode === "duplicate_indicators") {
      const { rows, total: groups } = page(`SELECT i.vendor_id, i.vendor_name, i.po_number, i.case_id, ROUND(i.total_amount,2) AS total_amount, COUNT(*) AS invoices, GROUP_CONCAT(i.invoice_id) AS invoice_ids, GROUP_CONCAT(i.invoice_date) AS invoice_dates FROM ai_invoices i GROUP BY i.vendor_id, i.po_number, ROUND(i.total_amount,2) HAVING COUNT(*) > 1 ORDER BY invoices DESC, total_amount DESC`, [], limit);
      return {
        summary: groups ? `${groups} group(s) of invoices share vendor, PO and amount. These are risk indicators for manual review, not confirmed duplicates.${shown(rows.length, groups)}` : "No invoices share the same vendor, PO and total amount; no duplicate-invoice indicator was found.",
        sections: [section("Possible duplicate invoices", rows, { total_amount: "money" })],
      };
    }
    if (mode === "pending_verification") {
      const rows = q(`SELECT i.invoice_id, i.case_id, i.po_number, i.vendor_name, i.department, i.invoice_date, i.net_payable, i.verification_status, i.payment_due_date FROM ai_invoices i WHERE i.verification_status <> 'Verified'${deptSql} ORDER BY i.net_payable DESC LIMIT ${limit}`, deptParams);
      return { summary: `${rows.length} invoice(s) are not yet verified.`, sections: [section("Invoices pending verification", rows, { net_payable: "money" })] };
    }
    const found = resolveCase(str(args.id) ?? "");
    if (!found?.poNumber) return notFound(str(args.id) ?? "");
    const totals = q("SELECT COUNT(*) AS invoices, COALESCE(SUM(total_amount),0) AS invoiced, COALESCE(SUM(net_payable),0) AS net_payable, COALESCE(SUM(amount_paid),0) AS paid, COALESCE(SUM(outstanding_amount),0) AS outstanding FROM ai_invoices WHERE po_number = ?", [found.poNumber])[0];
    return {
      summary: `Invoices and payments for ${found.poNumber}: ${totals.invoices} invoice(s), invoiced ${totals.invoiced}, net payable ${totals.net_payable}, paid ${totals.paid}, outstanding ${totals.outstanding} INR.`,
      sections: [
        section("Invoices", q("SELECT invoice_id, invoice_date, accepted_qty, total_amount, deduction, net_payable, amount_paid, outstanding_amount, verification_status, payment_status, payment_due_date FROM ai_invoices WHERE po_number = ? ORDER BY invoice_date", [found.poNumber]), { total_amount: "money", net_payable: "money", amount_paid: "money", outstanding_amount: "money" }),
        section("Payments", q("SELECT payment_ref, invoice_id, payment_date, amount, payment_status, tds_amount FROM ai_payments WHERE po_number = ? ORDER BY payment_date", [found.poNumber]), { amount: "money" }),
      ].filter((s) => s.rows.length > 0),
      evidence: [caseEvidence(found.caseId)],
    };
  },
};

const getProcurementBudget: ToolDefinition = {
  name: "get_procurement_budget",
  description: "Budget certificates versus commitments: approved budget, committed before, requested amount and available after, grouped by financial year, budget head or department, plus purchase order value committed. Requires budget access.",
  requires: "data:budget",
  parameters: { type: "object", properties: { financial_year: { type: "string", description: "e.g. 2025-26" }, group_by: { type: "string", enum: ["financial_year", "budget_head", "department"] }, department: { type: "string" } } },
  handler(args) {
    const group = ({ financial_year: "b.financial_year", budget_head: "b.budget_head", department: "d.department_name" } as Record<string, string>)[str(args.group_by) ?? "financial_year"] ?? "b.financial_year";
    const where: string[] = [];
    const params: Array<string> = [];
    if (str(args.financial_year)) {
      where.push("b.financial_year = ?");
      params.push(str(args.financial_year)!);
    }
    if (str(args.department)) {
      where.push("LOWER(d.department_name) LIKE ?");
      params.push(`%${str(args.department)!.toLowerCase()}%`);
    }
    const rows = q(
      `SELECT ${group} AS grouping, COUNT(*) AS budget_certificates, SUM(b.approved_budget) AS approved_budget, SUM(b.committed_before) AS committed_before,
              SUM(b.requested_amount) AS requested_amount, SUM(b.committed_before + b.requested_amount) AS committed_incl_request,
              ROUND(100.0 * SUM(b.committed_before + b.requested_amount) / SUM(b.approved_budget), 1) AS utilisation_pct,
              SUM(CASE WHEN b.status = 'Augmentation required' THEN 1 ELSE 0 END) AS augmentation_flags
       FROM ai_budgets b JOIN ai_departments d ON d.department_id = b.department_id ${where.length ? "WHERE " + where.join(" AND ") : ""} GROUP BY ${group} ORDER BY ${group}`,
      params,
    );
    const po = q("SELECT SUM(total_value) AS po_value FROM ai_pos")[0];
    return {
      summary: `Budget position grouped by ${str(args.group_by) ?? "financial_year"}. Purchase orders issued total ${Math.round(Number(po.po_value) || 0)} INR (all years).`,
      sections: [section("Budget vs committed", rows, { approved_budget: "money", committed_before: "money", requested_amount: "money", committed_incl_request: "money", utilisation_pct: "pct" })],
      notes: ["Each budget certificate is tied to a requisition's own budget head line; utilisation = (committed before + requested) ÷ approved budget across the certificates in the group."],
    };
  },
};

const RISK_CLASS: Record<string, RiskClass> = {
  "AUD-01": "control_exception", "AUD-02": "control_exception", "AUD-03": "control_exception", "AUD-04": "control_exception", "AUD-05": "control_exception",
  "AUD-06": "control_exception", "AUD-07": "control_exception", "AUD-08": "control_exception", "AUD-09": "risk_indicator", "AUD-10": "risk_indicator",
  "AUD-11": "control_exception", "AUD-12": "risk_indicator", "AUD-13": "control_exception", "AUD-14": "control_exception", "AUD-15": "control_exception",
};

function additionalIndicators(): RecordRow[] {
  const out: RecordRow[] = [];
  const push = (rows: RecordRow[], id: string, cls: RiskClass, title: string, detail: (r: RecordRow) => string, amount?: (r: RecordRow) => unknown) => {
    for (const r of rows) out.push({ indicator_id: id, class: cls, title, case_id: r.case_id ?? null, ref: r.ref ?? null, detail: detail(r), amount: (amount ? amount(r) : null) as RecordRow[string] });
  };
  push(q(`SELECT case_id, tender_id AS ref, CAST(julianday(substr(bid_end_at,1,10)) - julianday(publish_date) AS INTEGER) AS days FROM ai_tenders WHERE status <> 'Cancelled' AND julianday(substr(bid_end_at,1,10)) - julianday(publish_date) < 7`),
    "IND-01", "risk_indicator", "Short bid submission window", (r) => `Only ${r.days} day(s) between publication and bid end`);
  push(q(`SELECT case_id, tender_id AS ref, COUNT(*) AS n FROM ai_tenders t JOIN ai_corrigenda c USING (tender_id) GROUP BY tender_id, case_id HAVING COUNT(*) >= 2`),
    "IND-02", "risk_indicator", "Repeated corrigenda", (r) => `${r.n} corrigenda issued against the tender`);
  push(q(`SELECT t.case_id, t.tender_id AS ref, t.estimated_value AS amount FROM ai_tenders t WHERE t.bids_received = 1 AND t.status IN ('Awarded','Under Evaluation') AND t.estimated_value >= 5000000`),
    "IND-03", "risk_indicator", "Single bid on a tender of ₹50 lakh or more", () => "One bid received", (r) => r.amount);
  push(q(`SELECT t.case_id, b.submission_id AS ref, b.quoted_vs_estimate_pct AS pct FROM ai_bids b JOIN ai_tenders t ON t.tender_id = b.tender_id WHERE ABS(COALESCE(b.quoted_vs_estimate_pct,0)) > 30`),
    "IND-04", "anomaly", "Bid deviates more than 30% from estimate", (r) => `${r.pct}% against the tender estimate`);
  push(q(`WITH m AS (SELECT tender_id, MIN(quoted_total) AS mn FROM ai_bids WHERE quoted_total IS NOT NULL GROUP BY tender_id)
          SELECT t.case_id, b.submission_id AS ref FROM ai_bids b JOIN m ON m.tender_id = b.tender_id AND b.quoted_total = m.mn JOIN ai_tenders t ON t.tender_id = b.tender_id WHERE b.technical_result = 'Technically Disqualified'`),
    "IND-05", "anomaly", "Lowest quote was technically disqualified", () => "The cheapest bid failed technical evaluation (reason is in the comparative statement)");
  push(q(`SELECT a.case_id, a.approval_id AS ref, o.officer_name AS name FROM ai_approvals a JOIN requisitions r ON r.requisition_id = a.requisition_id LEFT JOIN ai_officers o ON o.officer_id = a.approver_officer_id WHERE a.approver_officer_id = r.requesting_officer_id AND a.decision = 'Approved'`),
    "IND-06", "control_exception", "Segregation of duties: requester also approved", (r) => `${r.name ?? "The requesting officer"} requested the requirement and approved a workflow step on it`);
  push(q(`SELECT c.case_id, c.contract_number AS ref, c.amendments FROM ai_contracts c WHERE c.amendments >= 2`),
    "IND-07", "risk_indicator", "Contract extended repeatedly", (r) => `${r.amendments} amendments recorded`);
  push(q(`SELECT i.case_id, i.invoice_id AS ref, i.total_amount AS amount, COUNT(*) OVER (PARTITION BY i.vendor_id, i.po_number, ROUND(i.total_amount,2)) AS n FROM ai_invoices i`).filter((r) => Number(r.n) > 1),
    "IND-08", "risk_indicator", "Possible duplicate invoice", () => "Same vendor, PO and amount as another invoice", (r) => r.amount);
  return out;
}

const getRiskIndicators: ToolDefinition = {
  name: "get_procurement_risk_indicators",
  description:
    "Rule-based risk and control findings with their classification: control_exception (departs from a stated control), risk_indicator (raises likelihood of a problem), anomaly (statistical deviation). Optionally limited to a case/tender/PO/contract or a department. Includes audit rules AUD-01..AUD-15 and indicators IND-01..IND-08 (short windows, repeated corrigenda, single bids, price deviation, lowest quote disqualified, requester-also-approved, repeated extensions, duplicate invoices). None of these is an established violation.",
  parameters: { type: "object", properties: { id: { type: "string" }, classes: { type: "array", items: { type: "string", enum: ["control_exception", "risk_indicator", "anomaly"] } }, department: { type: "string" }, limit: { type: "integer" } } },
  handler(args) {
    const found = str(args.id) ? resolveCase(str(args.id)!) : null;
    if (str(args.id) && !found) return notFound(str(args.id)!);
    const audit = runAuditRules().flatMap(({ rule, rows }) => rows.map((r) => ({ indicator_id: rule.id, class: RISK_CLASS[rule.id] ?? "control_exception", title: rule.title, case_id: r.case_id, ref: r.ref, detail: r.evidence, amount: r.amount })));
    let all: RecordRow[] = [...audit, ...additionalIndicators()];
    const wanted = Array.isArray(args.classes) ? (args.classes as string[]) : null;
    if (wanted?.length) all = all.filter((r) => wanted.includes(String(r.class)));
    if (found) all = all.filter((r) => r.case_id === found.caseId);
    if (str(args.department)) {
      const ids = new Set(q("SELECT case_id FROM ai_cases WHERE LOWER(department) LIKE ?", [`%${str(args.department)!.toLowerCase()}%`]).map((r) => String(r.case_id)));
      all = all.filter((r) => ids.has(String(r.case_id)));
    }
    const counts = new Map<string, number>();
    for (const r of all) counts.set(`${r.indicator_id} ${r.title}`, (counts.get(`${r.indicator_id} ${r.title}`) ?? 0) + 1);
    const summaryRows: RecordRow[] = [...counts.entries()].map(([k, n]) => ({ indicator: k, class: all.find((r) => `${r.indicator_id} ${r.title}` === k)?.class ?? null, findings: n })).sort((a, b) => Number(b.findings) - Number(a.findings));
    const rank: Record<string, number> = { control_exception: 0, risk_indicator: 1, anomaly: 2 };
    const detail = [...all].sort((a, b) => (rank[String(a.class)] ?? 9) - (rank[String(b.class)] ?? 9) || Number(b.amount ?? 0) - Number(a.amount ?? 0)).slice(0, limitOf(args.limit, 60, 200));
    return {
      summary: `${all.length} finding(s) across ${summaryRows.length} rule(s). Classifications: ${["control_exception", "risk_indicator", "anomaly"].map((k) => `${all.filter((r) => r.class === k).length} ${k.replace("_", " ")}`).join(", ")}.`,
      sections: [section("Findings by rule", summaryRows), section("Findings (largest first)", detail, { amount: "money" })].filter((s) => s.rows.length > 0),
      evidence: [{ kind: "rule", type: "rule", id: "audit-rules", label: `Audit rules ${AUDIT_RULES[0].id}–${AUDIT_RULES[AUDIT_RULES.length - 1].id} and indicators IND-01–IND-08` }],
      notes: [
        `Classification guide — anomaly: ${BUSINESS_RULES.riskLanguage.anomaly} control exception: ${BUSINESS_RULES.riskLanguage.control_exception} risk indicator: ${BUSINESS_RULES.riskLanguage.risk_indicator} established violation: ${BUSINESS_RULES.riskLanguage.established_violation}`,
        "IND-06 fires often in this synthetic data; treat its frequency as a possible data-generation artefact before reading anything into individual cases.",
      ],
    };
  },
};

const getCycleTimes: ToolDefinition = {
  name: "get_cycle_times",
  description: "Procurement cycle time in days (requisition to tender publication, publication to award approval, award to PO, and total requisition to PO) averaged by department, category group or financial year of requisition. Only cases that reached the stage are counted.",
  parameters: { type: "object", properties: { group_by: { type: "string", enum: ["department", "category_group", "financial_year"] } } },
  handler(args) {
    const group = ({ department: "c.department", category_group: "c.category_group", financial_year: "(CASE WHEN CAST(substr(r.requisition_date,6,2) AS INTEGER) >= 4 THEN substr(r.requisition_date,1,4) || '-' || substr(CAST(CAST(substr(r.requisition_date,1,4) AS INTEGER)+1 AS TEXT),3,2) ELSE CAST(CAST(substr(r.requisition_date,1,4) AS INTEGER)-1 AS TEXT) || '-' || substr(r.requisition_date,3,2) END)" } as Record<string, string>)[str(args.group_by) ?? "department"] ?? "c.department";
    const rows = q(
      `SELECT ${group} AS grouping, COUNT(*) AS cases_with_po,
              ROUND(AVG(julianday(t.publish_date) - julianday(r.requisition_date)),1) AS requisition_to_publication_days,
              ROUND(AVG(julianday(a.approval_date) - julianday(t.publish_date)),1) AS publication_to_award_days,
              ROUND(AVG(julianday(p.po_date) - julianday(a.approval_date)),1) AS award_to_po_days,
              ROUND(AVG(julianday(p.po_date) - julianday(r.requisition_date)),1) AS total_requisition_to_po_days
       FROM ai_cases c JOIN requisitions r ON r.case_id = c.case_id
       JOIN ai_tenders t ON t.tender_id = c.tender_id JOIN award_decisions a ON a.case_id = c.case_id JOIN ai_pos p ON p.case_id = c.case_id
       WHERE a.approval_date IS NOT NULL GROUP BY ${group} ORDER BY total_requisition_to_po_days DESC`,
    );
    return {
      summary: `Average procurement cycle time by ${str(args.group_by) ?? "department"}; ${rows.length} group(s).`,
      sections: [section("Cycle time (days)", rows)],
      notes: ["Averages cover only cases with an approved award and a PO. Cases still in progress or cancelled are excluded, which understates delays for slow groups."],
    };
  },
};

const getBottleneckAnalysis: ToolDefinition = {
  name: "get_bottleneck_analysis",
  description: "Where procurement slows down and why: approval-stage delay contribution, tender deadline extensions and corrigenda, late deliveries, rejection rates and cases past SLA by stage, optionally for one department. Use for bottleneck and root-cause questions.",
  parameters: { type: "object", properties: { department: { type: "string" } } },
  handler(args) {
    const dept = str(args.department);
    const dp = dept ? [`%${dept.toLowerCase()}%`] : [];
    const caseDept = dept ? " AND LOWER(c.department) LIKE ?" : "";
    const approvals = q(
      `SELECT a.stage, COUNT(*) AS steps, ROUND(AVG(CASE WHEN a.decision_date IS NOT NULL THEN julianday(a.decision_date) - julianday(a.submitted_date) END),1) AS avg_turnaround_days,
              SUM(a.delay_days) AS total_delay_days, SUM(CASE WHEN a.decision IN ('Returned','Rejected') THEN 1 ELSE 0 END) AS returned_or_rejected, SUM(CASE WHEN a.decision = 'Pending' THEN 1 ELSE 0 END) AS pending
       FROM ai_approvals a JOIN ai_cases c ON c.case_id = a.case_id WHERE 1=1${caseDept} GROUP BY a.stage ORDER BY total_delay_days DESC`, dp);
    const stages = q(`SELECT c.stage, COUNT(*) AS active_cases_past_sla, ROUND(AVG(c.delay_days),1) AS avg_days_past_sla FROM ai_cases c WHERE c.${ACTIVE} AND c.delay_days > 0${caseDept} GROUP BY c.stage ORDER BY active_cases_past_sla DESC`, dp);
    const tenderSlip = q(`SELECT COUNT(*) AS tenders, SUM(CASE WHEN t.extension_count > 0 THEN 1 ELSE 0 END) AS extended, SUM(CASE WHEN EXISTS (SELECT 1 FROM ai_corrigenda x WHERE x.tender_id = t.tender_id) THEN 1 ELSE 0 END) AS with_corrigenda FROM ai_tenders t JOIN ai_cases c ON c.case_id = t.case_id WHERE 1=1${caseDept}`, dp);
    const delivery = q(`SELECT COUNT(*) AS milestones, SUM(CASE WHEN m.delay_days > 0 OR (m.actual_date IS NULL AND m.planned_date < {ASOF}) THEN 1 ELSE 0 END) AS late, ROUND(AVG(CASE WHEN m.delay_days > 0 THEN m.delay_days END),1) AS avg_days_late FROM ai_milestones m JOIN ai_cases c ON c.case_id = m.case_id WHERE 1=1${caseDept}`, dp);
    const total = approvals.reduce((s, r) => s + Number(r.total_delay_days), 0);
    return {
      summary: `Bottleneck analysis${dept ? ` for ${dept}` : ""}: ${approvals[0] ? `${approvals[0].stage} contributes the most recorded approval delay (${approvals[0].total_delay_days} of ${total} days, ${total ? ((Number(approvals[0].total_delay_days) / total) * 100).toFixed(1) : 0}%)` : "no approval data"}.`,
      sections: [section("Approval stages by delay contribution", approvals), section("Active cases past SLA by current stage", stages), section("Tender slippage", tenderSlip), section("Delivery lateness", delivery)].filter((s) => s.rows.length > 0),
      notes: ["Contribution is the sum of recorded delay days; the data records how late a step was, not why."],
    };
  },
};

const getOperationalImpact: ToolDefinition = {
  name: "get_operational_impact",
  description: "Procurement cases tied to operational records (breakdown work orders, assets) whose procurement or delivery is delayed, ranked by criticality. This uses only procurement-side links; equipment downtime data from Mining Intelligence is NOT accessed, so impact on production cannot be quantified here.",
  parameters: { type: "object", properties: { critical_only: { type: "boolean" }, limit: { type: "integer" } } },
  handler(args) {
    const { rows, total } = page(
      `SELECT c.case_id, c.title, c.department, c.criticality, c.status, c.stage, c.delay_days, c.vendor_name, c.next_action,
              l.link_type, l.asset_type, l.work_order_id, l.work_order_status,
              (SELECT COUNT(*) FROM ai_milestones m WHERE m.case_id = c.case_id AND (m.delay_days > 0 OR (m.actual_date IS NULL AND m.planned_date < {ASOF}))) AS late_milestones
       FROM ai_operational_links l JOIN ai_cases c ON c.case_id = l.case_id
       WHERE c.${ACTIVE} AND (c.delay_days > 0 OR EXISTS (SELECT 1 FROM ai_milestones m WHERE m.case_id = c.case_id AND (m.delay_days > 0 OR (m.actual_date IS NULL AND m.planned_date < {ASOF}))))
         ${args.critical_only === true ? "AND c.criticality = 'Critical'" : ""}
       ORDER BY CASE c.criticality WHEN 'Critical' THEN 0 WHEN 'High' THEN 1 ELSE 2 END, c.delay_days DESC`,
      [],
      limitOf(args.limit, 30, 200),
    );
    return {
      summary: `${total} delayed procurement(s) are linked to operational records (work orders/assets).${shown(rows.length, total)}`,
      sections: [section("Delayed procurements linked to operations", rows, { delay_days: "days" })],
      notes: ["Cross-domain limit: asset downtime, production and availability data live in Mining Intelligence and are not accessible from this domain. Impact on equipment availability can be indicated (work order waiting for spares) but not measured."],
    };
  },
};

const getPortfolioOverview: ToolDefinition = {
  name: "get_portfolio_overview",
  description: "Portfolio position grouped by department, stage, status or category group: case counts, active and delayed cases, estimated value, awarded value and cases waiting for approval. Use for 'current procurement status across all departments' and similar executive questions.",
  parameters: { type: "object", properties: { group_by: { type: "string", enum: ["department", "stage", "status", "category_group"] } } },
  handler(args) {
    const key = ({ department: "c.department", stage: "c.stage", status: "c.status", category_group: "c.category_group" } as Record<string, string>)[str(args.group_by) ?? "department"] ?? "c.department";
    const rows = q(
      `SELECT ${key} AS grouping, COUNT(*) AS cases, SUM(CASE WHEN c.${ACTIVE} THEN 1 ELSE 0 END) AS active,
              SUM(CASE WHEN c.${ACTIVE} AND c.delay_days > 0 THEN 1 ELSE 0 END) AS delayed, SUM(c.estimated_value) AS estimated_value, SUM(c.award_value) AS award_value,
              SUM(CASE WHEN EXISTS (SELECT 1 FROM ai_approvals a WHERE a.case_id = c.case_id AND a.decision = 'Pending') THEN 1 ELSE 0 END) AS awaiting_approval,
              SUM(CASE WHEN c.risk_category IN ('High','Critical') THEN 1 ELSE 0 END) AS high_risk
       FROM ai_cases c GROUP BY ${key} ORDER BY cases DESC`,
    );
    const t = rows.reduce<{ cases: number; active: number; delayed: number }>((a, r) => ({ cases: a.cases + Number(r.cases), active: a.active + Number(r.active), delayed: a.delayed + Number(r.delayed) }), { cases: 0, active: 0, delayed: 0 });
    return { summary: `${t.cases} case(s): ${t.active} active, ${t.delayed} active cases past SLA.`, sections: [section("Portfolio", rows, { estimated_value: "money", award_value: "money" })], notes: [BUSINESS_RULES.activeCase, BUSINESS_RULES.delayedCase] };
  },
};

const runAnalyticalQuery: ToolDefinition = {
  name: "run_analytical_query",
  description:
    "Escape hatch for questions the other tools cannot answer: run ONE read-only SQLite SELECT over the permitted ai_* views (call describe_data_model first). Max 3 relations, every JOIN needs an equality ON, no comma joins, rows capped at 200. Prefer the business tools; state the purpose. Dates are ISO text; use {ASOF} for the as-of date.",
  requires: "ai:sql",
  parameters: { type: "object", properties: { purpose: { type: "string", description: "What this query is meant to establish" }, sql: { type: "string" } }, required: ["purpose", "sql"] },
  handler(args) {
    const sql = str(args.sql);
    if (!sql) throw new SqlRejected("sql is required");
    const result = runAgentSql(sql.replaceAll("{ASOF}", `'${getStore().asOf}'`));
    return {
      summary: `${result.rows.length} row(s)${result.truncated ? " (truncated at 200)" : ""} from ${result.relations.join(", ")}. Purpose: ${str(args.purpose) ?? "not stated"}.`,
      sections: [{ title: "Query result", columns: result.columns, rows: result.rows }],
      evidence: [{ kind: "table", type: "query", id: result.relations.join("+"), label: `SQL over ${result.relations.join(", ")}` }],
      notes: [`SQL executed (read-only, row-level scoped): ${sql.replace(/\s+/g, " ").slice(0, 600)}`],
    };
  },
};

const describeDataModel: ToolDefinition = {
  name: "describe_data_model",
  description: "List the ai_* views the user may query, with a description and column names. Call before run_analytical_query.",
  parameters: { type: "object", properties: { view: { type: "string", description: "Optional single view name" } } },
  handler(args) {
    const only = str(args.view)?.toLowerCase();
    const store = getStore();
    const rows = AI_VIEWS.filter((v) => !only || v.name === only).map((v) => ({
      view: v.name,
      description: v.description,
      columns: store.query<{ name: string; type: string }>(`SELECT name, type FROM pragma_table_info('${v.name}')`).map((c) => c.name).join(", "),
    }));
    return { summary: `${rows.length} view(s) available. Row-level security limits each to the user's department/area scope.`, sections: [section("Views", rows)], notes: ["Booleans are lowercase text 'true'/'false'. Dates are ISO text. Money is INR."] };
  },
};

const getBusinessRules: ToolDefinition = {
  name: "get_business_rules",
  description: "The configured definitions of terms such as active, delayed, high value, overdue, L1, financial year, and the four risk classifications. Call when a question depends on a definition.",
  parameters: { type: "object", properties: {} },
  handler(_args, ctx) {
    const { riskLanguage, ...rest } = BUSINESS_RULES;
    return {
      summary: `Business definitions in force (as-of date ${ctx.asOf}).`,
      sections: [section("Definitions", [...Object.entries(rest).map(([term, definition]) => ({ term, definition: String(definition) })), ...Object.entries(riskLanguage).map(([term, definition]) => ({ term: `risk class: ${term}`, definition }))])],
    };
  },
};

export const CORE_TOOLS: ToolDefinition[] = [
  getPortfolioOverview,
  searchTenders,
  getTenderDetails,
  getTenderTimeline,
  compareVendorBids,
  getVendorPerformance,
  getPendingApprovals,
  getContractDeliveryStatus,
  getInvoicePaymentStatus,
  getProcurementBudget,
  getRiskIndicators,
  getCycleTimes,
  getBottleneckAnalysis,
  getOperationalImpact,
  runAnalyticalQuery,
  describeDataModel,
  getBusinessRules,
];

export function toolsFor(principal: Principal, all: ToolDefinition[]): ToolDefinition[] {
  return all.filter((tool) => !tool.requires || hasPermission(principal, tool.requires));
}
