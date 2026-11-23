/**
 * Business definitions used by tools and shown to the model. Keeping them in
 * one place means "delayed", "high value" and "financial year" are defined by
 * configuration, not guessed by the model.
 */
export const BUSINESS_RULES = {
  organisation: "South Eastern Coalfields Limited (synthetic demonstration entity)",
  financialYear: "Indian financial year, 1 April to 31 March (for example FY 2025-26 = 2025-04-01 to 2026-03-31).",
  currency: "INR. Estimated, award and PO values include taxes unless a column says taxable.",
  activeCase: "A procurement case is active unless its status is Closed Case, Cancelled or Rejected.",
  openTender: "A tender is open for bidding when its status is Open for Bidding or Extended.",
  delayedCase: "A case is delayed when it is active and delay_days > 0 (days beyond the stage SLA recorded in the case register).",
  delayedMilestone: "A delivery milestone is late when delay_days > 0, or it has no actual delivery date and its planned date is before the as-of date.",
  highValue: "High value means a purchase order or award value of ₹1,00,00,000 (1 crore) or more.",
  approvalPending: "An approval is pending when its decision is Pending; age is the as-of date minus submission date.",
  approvalDelayed: "Approvals pending more than 14 days are treated as delayed for follow-up.",
  invoiceOverdue: "An invoice is overdue when outstanding_amount > 1 and payment_due_date is before the as-of date.",
  l1: "L1 is the lowest total quote among technically qualified bidders; QCBS tenders rank on the combined technical and financial score.",
  pendingQuantity: "Pending quantity = ordered quantity − accepted quantity on acceptance certificates.",
  estimateVsAward: "Estimated minus awarded value is a difference, not validated savings.",
  riskLanguage: {
    anomaly: "A statistical or pattern deviation that may have a normal explanation.",
    control_exception: "A record that departs from a stated control or rule; needs review and an explanation.",
    risk_indicator: "A signal that raises the likelihood of a problem; not evidence that one occurred.",
    established_violation: "A finding confirmed by an authorised audit process. This system cannot establish one.",
  },
} as const;

export type RiskClass = keyof typeof BUSINESS_RULES.riskLanguage;
