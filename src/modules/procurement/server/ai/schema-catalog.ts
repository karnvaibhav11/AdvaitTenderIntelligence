/**
 * The only tables the model may query directly. Each is a view over the
 * row-level-secured base tables, so department/area scope and data
 * permissions apply automatically. Sensitive columns (tax identifiers,
 * addresses, e-mail addresses, file hashes, dataset scenario labels) are
 * deliberately not exposed.
 */
export interface AiView {
  name: string;
  description: string;
  sql: string;
}

export const AI_VIEWS: AiView[] = [
  {
    name: "ai_cases",
    description: "One row per procurement case (requirement through closure) with current stage, status, value, delay and risk.",
    sql: `SELECT case_id, requisition_id, tender_id, po_number, contract_number, title, department_id, department_name AS department,
            category_id, category_name AS category, category_group, procurement_type, criticality, priority,
            current_stage_name AS stage, current_status AS status, estimated_value, award_value, started_date, due_date,
            delay_days, escalation_level, risk_score, risk_category, risk_factors, vendor_id, vendor_name, next_action, area_id, mine_id
          FROM v_case`,
  },
  {
    name: "ai_tenders",
    description: "Tender register: publication, deadlines, extensions, version, status, estimate and bids received. A case may have more than one tender (re-tender).",
    sql: `SELECT tender_id, case_id, title, department_id, department_name AS department, category_name AS category, category_group,
            bid_type, evaluation_method, publish_date, bid_end_at, original_bid_end_at, bid_opening_at, extension_count, current_version,
            status, estimated_value, emd_amount, epbg_required, delivery_days, bids_received, retender_of, cancellation_reason,
            min_avg_turnover, experience_years, offer_validity_days, buyer_officer_id
          FROM v_tender`,
  },
  {
    name: "ai_corrigenda",
    description: "Corrigenda (amendments) issued against tenders, with version numbers and any revised bid end date.",
    sql: `SELECT corrigendum_id, tender_id, version_from, version_to, issued_date, change_type, description, new_bid_end_at FROM tender_corrigenda`,
  },
  {
    name: "ai_eligibility",
    description: "Eligibility criteria per tender (type, parameter, threshold, mandatory flag, evidence required).",
    sql: `SELECT criterion_id, tender_id, criterion_type, parameter, threshold_value, mandatory, evidence_required FROM tender_eligibility_criteria`,
  },
  {
    name: "ai_bids",
    description: "One row per bid submission with technical result, quoted total and rank. Quote and rank columns are empty for users without financial-bid access.",
    sql: `SELECT s.submission_id, s.tender_id, s.vendor_id, v.company_name AS vendor_name, s.submitted_at, s.submission_status,
            s.documents_complete, s.emd_status, s.oem_status, te.result AS technical_result, te.total_score, te.cutoff_score,
            te.disqualification_reason, cs.quoted_total, fe.quoted_vs_estimate_pct, cs.status AS rank_status
          FROM bidder_submissions s
          LEFT JOIN vendor_master v ON v.vendor_id = s.vendor_id
          LEFT JOIN technical_evaluations te ON te.submission_id = s.submission_id
          LEFT JOIN comparative_statements cs ON cs.submission_id = s.submission_id
          LEFT JOIN financial_evaluations fe ON fe.submission_id = s.submission_id`,
  },
  {
    name: "ai_approvals",
    description: "Approval workflow steps per requisition/case: stage, approver, dates, decision and recorded delay.",
    sql: `SELECT a.approval_id, c.case_id, a.requisition_id, a.step_no, a.stage, a.approver_officer_id, o.officer_name AS approver_name,
            a.submitted_date, a.decision, a.decision_date, a.delay_days, a.remarks
          FROM approvals a JOIN procurement_cases c ON c.requisition_id = a.requisition_id
          LEFT JOIN employee_officer_master o ON o.officer_id = a.approver_officer_id`,
  },
  {
    name: "ai_pos",
    description: "Purchase orders with vendor, value (incl. tax), delivery date and terms.",
    sql: `SELECT po_number, case_id, tender_id, award_id, vendor_id, vendor_name, department_id, department_name AS department,
            category_name AS category, po_date, total_value, expected_delivery_date, payment_terms, payment_days, warranty_months, status
          FROM v_po`,
  },
  {
    name: "ai_po_lines",
    description: "Purchase order line items: item, quantity, unit price (pre-GST) and totals.",
    sql: `SELECT po_line_id, po_number, item_id, description, quantity, uom, unit_price, taxable_value, gst_pct, tax_value, line_total FROM purchase_order_line_items`,
  },
  {
    name: "ai_contracts",
    description: "Contracts with validity dates, value, status and number of recorded amendments.",
    sql: `SELECT cm.contract_number, p.case_id, cm.po_number, cm.tender_id, cm.vendor_id, p.vendor_name, p.department_id, p.department_name AS department,
            cm.start_date, cm.end_date, cm.original_end_date, cm.contract_value, cm.status,
            (SELECT COUNT(*) FROM contract_variations cv WHERE cv.contract_number = cm.contract_number) AS amendments
          FROM contract_master cm JOIN v_po p ON p.po_number = cm.po_number`,
  },
  {
    name: "ai_amendments",
    description: "Contract amendments (time extensions and value changes) with approval date and reason.",
    sql: `SELECT variation_id, contract_number, variation_type, approved_date, previous_end_date, new_end_date, value_change, reason, approved_by FROM contract_variations`,
  },
  {
    name: "ai_milestones",
    description: "Delivery and service milestones per PO: planned vs actual date and quantity, status, delay days.",
    sql: `SELECT m.milestone_id, m.po_number, p.case_id, p.vendor_id, p.vendor_name, p.department_name AS department, m.milestone_no, m.milestone_type,
            m.planned_date, m.planned_qty, m.actual_date, m.actual_qty, m.status, m.delay_days
          FROM delivery_milestones m JOIN v_po p ON p.po_number = m.po_number`,
  },
  {
    name: "ai_grn",
    description: "Goods receipts (GRN) per PO: received quantity, date, condition and store.",
    sql: `SELECT r.receipt_id, g.grn_id, r.po_number, p.case_id, r.receipt_date, r.qty_received, r.condition, g.store_location
          FROM delivery_receipts r LEFT JOIN goods_receipt_notes g ON g.receipt_id = r.receipt_id JOIN v_po p ON p.po_number = r.po_number`,
  },
  {
    name: "ai_inspections",
    description: "Inspection results per receipt: inspected, accepted and rejected quantity and rejection reason.",
    sql: `SELECT i.inspection_id, i.po_number, p.case_id, p.vendor_id, p.vendor_name, i.receipt_id, i.inspection_date, i.inspection_type,
            i.qty_inspected, i.qty_accepted, i.qty_rejected, i.result, i.rejection_reason
          FROM inspection_records i JOIN v_po p ON p.po_number = i.po_number`,
  },
  {
    name: "ai_acceptance",
    description: "Acceptance certificates: accepted quantity per inspection.",
    sql: `SELECT acceptance_id, po_number, inspection_id, certificate_type, accepted_qty, issue_date, status FROM acceptance_certificates`,
  },
  {
    name: "ai_invoices",
    description: "Invoices with accepted quantity, amounts, verification and payment status and outstanding balance. Requires payments access.",
    sql: `SELECT invoice_id, case_id, po_number, vendor_id, vendor_name, department_name AS department, invoice_date, submission_date, accepted_qty,
            taxable_value, gst_value, total_amount, deduction, net_payable, verification_status, payment_status, payment_due_date,
            payment_date, amount_paid, outstanding_amount, acceptance_id
          FROM v_invoice`,
  },
  {
    name: "ai_payments",
    description: "Payment transactions against invoices (fictional references). Requires payments access.",
    sql: `SELECT p.payment_ref, p.invoice_id, p.po_number, p.vendor_id, p.amount, p.payment_date, p.payment_status, p.payment_mode, p.tds_amount, p.outstanding_after
          FROM payment_register p`,
  },
  {
    name: "ai_vendors",
    description: "Vendor master (fictional vendors): class, turnover, experience, source risk classification and registration status. Tax identifiers are not exposed.",
    sql: `SELECT vendor_id, company_name, state, msme_class, is_startup, is_oem, annual_turnover, years_in_operation, past_government_contracts,
            vendor_risk_classification, registration_status FROM vendor_master`,
  },
  {
    name: "ai_vendor_performance",
    description: "Periodic vendor performance assessments per contract: on-time %, quality rejection %, SLA %, payment disputes, score and rating.",
    sql: `SELECT perf_id, vendor_id, contract_number, assessment_date, on_time_delivery_pct, quality_rejection_pct, sla_compliance_pct, payment_disputes, overall_score, rating, remarks FROM vendor_performance`,
  },
  {
    name: "ai_penalties",
    description: "Penalties and liquidated damages levied against contracts.",
    sql: `SELECT penalty_id, contract_number, po_number, penalty_type, delay_days, penalty_amount, status, computed_basis, levy_date FROM penalty_register`,
  },
  {
    name: "ai_warranties",
    description: "Warranty register with coverage period and status.",
    sql: `SELECT warranty_id, contract_number, po_number, vendor_id, warranty_start, warranty_end, months, coverage, status FROM warranty_register`,
  },
  {
    name: "ai_risks",
    description: "Open and closed items in the procurement risk register (type, severity, owner, exposure, recommended action).",
    sql: `SELECT risk_id, case_id, risk_type, severity, department_id, contract_number, business_impact, owner_officer_id, recommended_action, exposure_amount, raised_date, status FROM procurement_risk_register`,
  },
  {
    name: "ai_budgets",
    description: "Budget certificates per requisition: approved budget, committed, requested and available. Requires budget access.",
    sql: `SELECT b.budget_control_id, c.case_id, b.requisition_id, b.financial_year, b.budget_head, b.approved_budget, b.committed_before,
            b.requested_amount, b.available_after, b.status, c.department_id
          FROM budget_controls b JOIN procurement_cases c ON c.requisition_id = b.requisition_id`,
  },
  {
    name: "ai_status_events",
    description: "Chronological status-change trail per case, entity and officer.",
    sql: `SELECT e.audit_id, e.case_id, e.entity_type, e.entity_id, e.from_status, e.to_status, e.event_at, e.actor_officer_id, o.officer_name AS actor_name
          FROM procurement_audit_events e LEFT JOIN employee_officer_master o ON o.officer_id = e.actor_officer_id`,
  },
  {
    name: "ai_documents",
    description: "Register of source documents (type, title, version, date, page count) linked to cases, tenders and POs.",
    sql: `SELECT document_id, case_id, doc_type, stage_name, title, version, created_date, supersedes_document_id, tender_id, po_number, page_count FROM document_metadata`,
  },
  {
    name: "ai_departments",
    description: "Departments.",
    sql: `SELECT department_id, department_name, approval_authority_level FROM department_master`,
  },
  {
    name: "ai_categories",
    description: "Procurement categories and groups.",
    sql: `SELECT category_id, category_name, category_group, procurement_type, typical_delivery_days FROM procurement_category_master`,
  },
  {
    name: "ai_officers",
    description: "Officers (fictional): name, designation, department and approval level.",
    sql: `SELECT officer_id, officer_name, designation, department_id, area_id, approval_level FROM employee_officer_master`,
  },
  {
    name: "ai_operational_links",
    description: "Links from procurement cases to operational records (breakdown work orders, assets) for critical-spares context.",
    sql: `SELECT link_id, case_id, link_type, asset_type, work_order_id, work_order_status, note FROM procurement_operational_links`,
  },
];

export const AI_VIEW_NAMES = AI_VIEWS.map((view) => view.name);
