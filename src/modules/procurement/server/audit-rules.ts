/** Rule-based audit exceptions. Each query returns case_id, ref, evidence, amount. */

export interface AuditRule {
  id: string;
  title: string;
  severity: "High" | "Medium" | "Low";
  basis: string;
  sql: string;
}

export const AUDIT_RULES: AuditRule[] = [
  {
    id: "AUD-01",
    title: "PO value differs from approved award value",
    severity: "High",
    basis: "purchase_orders.total_value compared with award_decisions.approved_value (tolerance ₹1)",
    sql: `SELECT p.case_id, p.po_number AS ref,
            'PO value ' || ROUND(p.total_value,2) || ' vs approved award ' || ROUND(a.approved_value,2) AS evidence,
            ABS(p.total_value - a.approved_value) AS amount
          FROM v_po p JOIN award_decisions a ON a.award_id = p.award_id
          WHERE ABS(p.total_value - a.approved_value) > 1`,
  },
  {
    id: "AUD-02",
    title: "Payment exceeds net payable on invoice",
    severity: "High",
    basis: "invoice_register.amount_paid compared with net_payable (tolerance ₹1)",
    sql: `SELECT i.case_id, i.invoice_id AS ref,
            'Paid ' || ROUND(i.amount_paid,2) || ' against net payable ' || ROUND(i.net_payable,2) AS evidence,
            i.amount_paid - i.net_payable AS amount
          FROM v_invoice i WHERE i.amount_paid > i.net_payable + 1`,
  },
  {
    id: "AUD-03",
    title: "Invoiced quantity exceeds accepted quantity",
    severity: "High",
    basis: "invoice_register.accepted_qty compared with acceptance_certificates.accepted_qty for the same acceptance",
    sql: `SELECT i.case_id, i.invoice_id AS ref,
            'Invoice accepted qty ' || i.accepted_qty || ' vs certificate qty ' || ac.accepted_qty AS evidence,
            (i.accepted_qty - ac.accepted_qty) AS amount
          FROM v_invoice i JOIN acceptance_certificates ac ON ac.acceptance_id = i.acceptance_id
          WHERE i.accepted_qty > ac.accepted_qty + 0.0001`,
  },
  {
    id: "AUD-04",
    title: "Goods received over 7 days ago without an inspection record",
    severity: "Medium",
    basis: "delivery_receipts older than 7 days with no matching inspection_records.receipt_id",
    sql: `SELECT p.case_id, r.receipt_id AS ref,
            'Receipt of ' || r.qty_received || ' on ' || r.receipt_date || ' has no inspection record' AS evidence,
            NULL AS amount
          FROM delivery_receipts r JOIN v_po p ON p.po_number = r.po_number
          WHERE r.receipt_id NOT IN (SELECT receipt_id FROM inspection_records WHERE receipt_id IS NOT NULL)
            AND julianday({ASOF}) - julianday(r.receipt_date) > 7`,
  },
  {
    id: "AUD-05",
    title: "Award recommended to a technically disqualified bidder",
    severity: "High",
    basis: "award_decisions.recommended_vendor_id marked Disqualified in comparative_statements for the same tender",
    sql: `SELECT a.case_id, a.award_id AS ref,
            'Vendor ' || a.recommended_vendor_id || ' is Disqualified in the comparative statement' AS evidence,
            a.approved_value AS amount
          FROM award_decisions a JOIN comparative_statements cs
            ON cs.tender_id = a.tender_id AND cs.vendor_id = a.recommended_vendor_id
          WHERE cs.status = 'Disqualified'`,
  },
  {
    id: "AUD-06",
    title: "Material received after contract end date",
    severity: "Medium",
    basis: "delivery_receipts.receipt_date later than contract_master.end_date",
    sql: `SELECT p.case_id, r.receipt_id AS ref,
            'Received ' || r.receipt_date || ' after contract end ' || p.contract_end_date AS evidence,
            NULL AS amount
          FROM delivery_receipts r JOIN v_po p ON p.po_number = r.po_number
          WHERE p.contract_end_date IS NOT NULL AND r.receipt_date > p.contract_end_date`,
  },
  {
    id: "AUD-07",
    title: "Payment dated before invoice verification",
    severity: "High",
    basis: "payment_register.payment_date earlier than invoice_verification.verification_date",
    sql: `SELECT i.case_id, pay.payment_ref AS ref,
            'Paid ' || pay.payment_date || ' but verified ' || iv.verification_date AS evidence,
            pay.amount AS amount
          FROM payment_register pay
          JOIN invoice_verification iv ON iv.invoice_id = pay.invoice_id
          JOIN v_invoice i ON i.invoice_id = pay.invoice_id
          WHERE pay.payment_date < iv.verification_date`,
  },
  {
    id: "AUD-08",
    title: "Approval pending for more than 14 days",
    severity: "Medium",
    basis: "approvals.decision = Pending with days since submission above 14 (as-of date)",
    sql: `SELECT c.case_id, a.approval_id AS ref,
            a.stage || ' pending ' || CAST(julianday({ASOF}) - julianday(a.submitted_date) AS INTEGER) || ' days since ' || a.submitted_date AS evidence,
            c.estimated_value AS amount
          FROM approvals a JOIN procurement_cases c ON c.requisition_id = a.requisition_id
          WHERE a.decision = 'Pending' AND julianday({ASOF}) - julianday(a.submitted_date) > 14`,
  },
  {
    id: "AUD-09",
    title: "Approved award value above estimated value",
    severity: "Medium",
    basis: "award_decisions.approved_value greater than award_decisions.estimated_value",
    sql: `SELECT a.case_id, a.award_id AS ref,
            'Approved ' || ROUND(a.approved_value,2) || ' vs estimate ' || ROUND(a.estimated_value,2) AS evidence,
            a.approved_value - a.estimated_value AS amount
          FROM award_decisions a
          WHERE a.approval_status = 'Approved' AND a.approved_value > a.estimated_value * 1.0001`,
  },
  {
    id: "AUD-10",
    title: "Single-bid award of ₹50 lakh or more",
    severity: "Medium",
    basis: "tenders with one bid received and an approved award value of at least ₹50,00,000",
    sql: `SELECT a.case_id, a.award_id AS ref,
            'One bid received; approved value ' || ROUND(a.approved_value,2) AS evidence,
            a.approved_value AS amount
          FROM award_decisions a JOIN v_tender t ON t.tender_id = a.tender_id
          WHERE t.bids_received = 1 AND a.approval_status = 'Approved' AND a.approved_value >= 5000000`,
  },
  {
    id: "AUD-11",
    title: "Contract extended without a recorded variation",
    severity: "Medium",
    basis: "contract_master.status = Extended with no contract_variations record",
    sql: `SELECT c.case_id, cm.contract_number AS ref,
            'Extended from ' || cm.original_end_date || ' to ' || cm.end_date || ' with no variation record' AS evidence,
            cm.contract_value AS amount
          FROM contract_master cm JOIN procurement_cases c ON c.contract_number = cm.contract_number
          WHERE cm.status = 'Extended'
            AND cm.contract_number NOT IN (SELECT contract_number FROM contract_variations)`,
  },
  {
    id: "AUD-12",
    title: "Invoice payment overdue by more than 30 days",
    severity: "Medium",
    basis: "invoice_register payment_due_date more than 30 days before the as-of date with an outstanding balance",
    sql: `SELECT i.case_id, i.invoice_id AS ref,
            'Due ' || i.payment_due_date || ', outstanding ' || ROUND(i.outstanding_amount,2) AS evidence,
            i.outstanding_amount AS amount
          FROM v_invoice i
          WHERE i.outstanding_amount > 1 AND julianday({ASOF}) - julianday(i.payment_due_date) > 30`,
  },
  {
    id: "AUD-13",
    title: "PO issued while budget certificate flags augmentation",
    severity: "Medium",
    basis: "budget_controls.status = Augmentation required for a requisition that progressed to a purchase order",
    sql: `SELECT c.case_id, b.budget_control_id AS ref,
            b.budget_head || ' available after request ' || ROUND(b.available_after,2) AS evidence,
            b.requested_amount AS amount
          FROM budget_controls b JOIN procurement_cases c ON c.requisition_id = b.requisition_id
          WHERE b.status = 'Augmentation required' AND c.po_number IS NOT NULL`,
  },
  {
    id: "AUD-14",
    title: "Performance security required but not on record",
    severity: "Medium",
    basis: "tender_master.epbg_required = True with a contract but no performance_security record",
    sql: `SELECT c.case_id, cm.contract_number AS ref,
            'ePBG ' || t.epbg_percent || '% required; none registered' AS evidence,
            cm.contract_value AS amount
          FROM contract_master cm
          JOIN tender_master t ON t.tender_id = cm.tender_id
          JOIN procurement_cases c ON c.contract_number = cm.contract_number
          WHERE t.epbg_required = 'true'
            AND cm.contract_number NOT IN (SELECT contract_number FROM performance_security)`,
  },
  {
    id: "AUD-15",
    title: "Purchase order without an approval-trail record",
    severity: "High",
    basis: "cases with a purchase order whose requisition has no row in approvals",
    sql: `SELECT c.case_id, c.po_number AS ref,
            'No approval records for requisition ' || c.requisition_id AS evidence,
            c.award_value AS amount
          FROM procurement_cases c
          WHERE c.po_number IS NOT NULL
            AND c.requisition_id NOT IN (SELECT requisition_id FROM approvals)`,
  },
];
