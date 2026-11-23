import { AUDIT_RULES } from "./audit-rules";

export interface DrillQuery {
  title: string;
  sql: string;
  params: Array<string | number>;
}

export const ACTIVE = `current_status NOT IN ('Closed Case','Cancelled','Rejected')`;

const STATIC: Record<string, { title: string; sql: string }> = {
  all: { title: "All procurement cases", sql: `SELECT case_id FROM procurement_cases` },
  active: { title: "Active procurement cases", sql: `SELECT case_id FROM procurement_cases WHERE ${ACTIVE}` },
  overdue_active: {
    title: "Active cases past their SLA",
    sql: `SELECT case_id FROM procurement_cases WHERE ${ACTIVE} AND delay_days > 0`,
  },
  high_risk: {
    title: "High and critical risk cases",
    sql: `SELECT case_id FROM procurement_cases WHERE risk_category IN ('High','Critical')`,
  },
  escalated: {
    title: "Escalated cases",
    sql: `SELECT case_id FROM procurement_cases WHERE escalation_level > 0 AND ${ACTIVE}`,
  },
  open_tenders: {
    title: "Tenders open for bidding",
    sql: `SELECT case_id FROM tender_master WHERE status IN ('Open for Bidding','Extended')`,
  },
  closing_30: {
    title: "Tenders closing within 30 days",
    sql: `SELECT case_id FROM tender_master WHERE status IN ('Open for Bidding','Extended')
          AND substr(bid_end_at,1,10) BETWEEN {ASOF} AND date({ASOF},'+30 day')`,
  },
  under_evaluation: {
    title: "Tenders under evaluation",
    sql: `SELECT case_id FROM tender_master WHERE status = 'Under Evaluation'`,
  },
  with_corrigenda: {
    title: "Tenders amended by corrigendum",
    sql: `SELECT DISTINCT t.case_id FROM tender_master t JOIN tender_corrigenda c ON c.tender_id = t.tender_id`,
  },
  retendered: {
    title: "Re-tendered procurements",
    sql: `SELECT case_id FROM tender_master WHERE status = 'Re-Tendered' OR retender_of IS NOT NULL`,
  },
  single_bid: {
    title: "Tenders with a single bid",
    sql: `SELECT case_id FROM v_tender WHERE bids_received = 1`,
  },
  pending_approvals: {
    title: "Cases awaiting an approval decision",
    sql: `SELECT c.case_id FROM approvals a JOIN procurement_cases c ON c.requisition_id = a.requisition_id WHERE a.decision = 'Pending'`,
  },
  contracts_expiring: {
    title: "Contracts ending within 60 days",
    sql: `SELECT case_id FROM v_po WHERE contract_end_date BETWEEN {ASOF} AND date({ASOF},'+60 day')
          AND contract_status IN ('Active','Extended')`,
  },
  contracts_extended: {
    title: "Extended contracts",
    sql: `SELECT c.case_id FROM contract_master cm JOIN procurement_cases c ON c.contract_number = cm.contract_number WHERE cm.status = 'Extended'`,
  },
  contracts_active: {
    title: "Active and extended contracts",
    sql: `SELECT c.case_id FROM contract_master cm JOIN procurement_cases c ON c.contract_number = cm.contract_number WHERE cm.status IN ('Active','Extended')`,
  },
  penalties: {
    title: "Contracts with penalties or liquidated damages",
    sql: `SELECT DISTINCT p.case_id FROM penalty_register pr JOIN v_po p ON p.po_number = pr.po_number`,
  },
  warranty_expiring: {
    title: "Warranties ending within 90 days",
    sql: `SELECT DISTINCT p.case_id FROM warranty_register w JOIN v_po p ON p.po_number = w.po_number
          WHERE w.warranty_end BETWEEN {ASOF} AND date({ASOF},'+90 day')`,
  },
  late_milestones: {
    title: "Cases with late delivery milestones",
    sql: `SELECT DISTINCT p.case_id FROM delivery_milestones m JOIN v_po p ON p.po_number = m.po_number
          WHERE m.delay_days > 0 OR (m.actual_date IS NULL AND m.planned_date < {ASOF})`,
  },
  partial_delivery: {
    title: "Cases with partial delivery",
    sql: `SELECT DISTINCT p.case_id FROM delivery_milestones m JOIN v_po p ON p.po_number = m.po_number WHERE m.status = 'Partially Delivered'`,
  },
  rejections: {
    title: "Cases with rejected material",
    sql: `SELECT DISTINCT p.case_id FROM inspection_records i JOIN v_po p ON p.po_number = i.po_number WHERE i.qty_rejected > 0`,
  },
  invoices_unverified: {
    title: "Cases with invoices under verification",
    sql: `SELECT DISTINCT case_id FROM v_invoice WHERE verification_status = 'Under verification'`,
  },
  payables: {
    title: "Cases with outstanding invoice balance",
    sql: `SELECT DISTINCT case_id FROM v_invoice WHERE outstanding_amount > 1`,
  },
  payables_overdue: {
    title: "Cases with overdue invoice balance",
    sql: `SELECT DISTINCT case_id FROM v_invoice WHERE outstanding_amount > 1 AND payment_due_date < {ASOF}`,
  },
  disputed_invoices: {
    title: "Cases with disputed invoices",
    sql: `SELECT DISTINCT case_id FROM v_invoice WHERE payment_status = 'Disputed'`,
  },
  open_risks: {
    title: "Cases with an open risk-register item",
    sql: `SELECT DISTINCT case_id FROM procurement_risk_register WHERE status = 'Open'`,
  },
  budget_flag: {
    title: "Cases whose budget certificate needs augmentation",
    sql: `SELECT c.case_id FROM budget_controls b JOIN procurement_cases c ON c.requisition_id = b.requisition_id WHERE b.status = 'Augmentation required'`,
  },
  open_warranty_claims: {
    title: "Cases with unresolved warranty claims",
    sql: `SELECT DISTINCT p.case_id FROM warranty_claims w JOIN v_po p ON p.contract_number = w.contract_number WHERE w.status IN ('Open','In Rectification')`,
  },
  sla_breached: {
    title: "Cases with SLA breaches",
    sql: `SELECT DISTINCT c.case_id FROM sla_performance s JOIN procurement_cases c ON c.contract_number = s.contract_number WHERE s.status = 'Breached'`,
  },
  lowest_disqualified: {
    title: "Tenders where the lowest quote was technically disqualified",
    sql: `WITH m AS (SELECT tender_id, MIN(quoted_total) AS mn FROM financial_evaluations GROUP BY tender_id)
          SELECT DISTINCT t.case_id FROM financial_evaluations f
          JOIN m ON m.tender_id = f.tender_id AND f.quoted_total = m.mn
          JOIN tender_master t ON t.tender_id = f.tender_id
          WHERE f.technically_qualified = 'false'`,
  },
  high_value: {
    title: "High-value procurements (₹1 crore and above)",
    sql: `SELECT case_id FROM procurement_cases WHERE COALESCE(NULLIF(award_value,0), estimated_value) >= 10000000`,
  },
};

const PREFIXED: Record<string, (value: string) => DrillQuery> = {
  stage: (value) => ({
    title: `Stage: ${value}`,
    sql: `SELECT case_id FROM procurement_cases WHERE current_stage_name = ?`,
    params: [value],
  }),
  status: (value) => ({
    title: `Status: ${value}`,
    sql: `SELECT case_id FROM procurement_cases WHERE current_status = ?`,
    params: [value],
  }),
  dept: (value) => ({
    title: `Department: ${value}`,
    sql: `SELECT case_id FROM v_case WHERE department_name = ?`,
    params: [value],
  }),
  group: (value) => ({
    title: `Category group: ${value}`,
    sql: `SELECT case_id FROM v_case WHERE category_group = ?`,
    params: [value],
  }),
  category: (value) => ({
    title: `Category: ${value}`,
    sql: `SELECT case_id FROM v_case WHERE category_name = ?`,
    params: [value],
  }),
  vendor: (value) => ({
    title: `Vendor: ${value}`,
    sql: `SELECT case_id FROM v_case WHERE vendor_id = ? OR vendor_name = ?`,
    params: [value, value],
  }),
  month: (value) => ({
    title: `Procurements started in ${value}`,
    sql: `SELECT case_id FROM procurement_cases WHERE substr(started_date,1,7) = ?`,
    params: [value],
  }),
  risk: (value) => ({
    title: `Risk category: ${value}`,
    sql: `SELECT case_id FROM procurement_cases WHERE risk_category = ?`,
    params: [value],
  }),
  approval: (value) => ({
    title: `Approval stage: ${value}`,
    sql: `SELECT c.case_id FROM approvals a JOIN procurement_cases c ON c.requisition_id = a.requisition_id
          WHERE a.stage = ? AND a.decision IN ('Returned','Resubmitted','Pending')`,
    params: [value],
  }),
  audit: (value) => {
    const rule = AUDIT_RULES.find((item) => item.id === value);
    return {
      title: rule ? `${rule.id}: ${rule.title}` : `Audit rule ${value}`,
      sql: rule ? `SELECT case_id FROM (${rule.sql})` : `SELECT case_id FROM procurement_cases WHERE 1 = 0`,
      params: [],
    };
  },
  scenario: (value) => ({
    title: `Scenario: ${value}`,
    sql: `SELECT case_id FROM procurement_cases WHERE scenario = ?`,
    params: [value],
  }),
  inspection: (value) => ({
    title: `Inspection result: ${value}`,
    sql: `SELECT DISTINCT p.case_id FROM inspection_records i JOIN v_po p ON p.po_number = i.po_number WHERE i.result = ?`,
    params: [value],
  }),
  ageing: (value) => ({
    title: `Payables ageing: ${value}`,
    sql: `SELECT DISTINCT i.case_id FROM outstanding_payments o JOIN v_invoice i ON i.invoice_id = o.invoice_id WHERE o.ageing_bucket = ?`,
    params: [value],
  }),
};

export function resolveDrill(key: string): DrillQuery | null {
  const fixed = STATIC[key];
  if (fixed) return { ...fixed, params: [] };
  const separator = key.indexOf(":");
  if (separator < 0) return null;
  const prefix = key.slice(0, separator);
  const value = key.slice(separator + 1);
  return PREFIXED[prefix]?.(value) ?? null;
}
