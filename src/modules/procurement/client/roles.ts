export type ViewId =
  | "overview"
  | "tenders"
  | "evaluation"
  | "finance"
  | "workflow"
  | "contracts"
  | "delivery"
  | "vendors"
  | "audit"
  | "cases"
  | "documents"
  | "tattva"
  | "admin";

export interface NavItem {
  id: ViewId;
  label: string;
  group: "Intelligence" | "Records" | "Assistant" | "Administration";
  caption: string;
}

export const NAV: NavItem[] = [
  { id: "overview", label: "Executive overview", group: "Intelligence", caption: "Portfolio position" },
  { id: "tenders", label: "Tender intelligence", group: "Intelligence", caption: "Discovery & documents" },
  { id: "evaluation", label: "Bid evaluation", group: "Intelligence", caption: "Compliance & comparison" },
  { id: "finance", label: "Financial intelligence", group: "Intelligence", caption: "Spend & benchmarks" },
  { id: "workflow", label: "Workflow & approvals", group: "Intelligence", caption: "Turnaround & bottlenecks" },
  { id: "contracts", label: "PO & contracts", group: "Intelligence", caption: "Expiry, warranty, penalties" },
  { id: "delivery", label: "Delivery & inspection", group: "Intelligence", caption: "Receipts, quality, payables" },
  { id: "vendors", label: "Vendor intelligence", group: "Intelligence", caption: "Evidence-backed scorecards" },
  { id: "audit", label: "Audit & compliance", group: "Intelligence", caption: "Exceptions & actions" },
  { id: "cases", label: "Procurement register", group: "Records", caption: "Every case, drill-down" },
  { id: "documents", label: "Document library", group: "Records", caption: "Source PDFs" },
  { id: "tattva", label: "TattvaAI", group: "Assistant", caption: "Ask the data" },
  { id: "admin", label: "Administration", group: "Administration", caption: "Audit log, users, AI, sources" },
];

/** Landing view preference; the first one the signed-in user is allowed to open wins. */
export const LANDING_ORDER: ViewId[] = ["overview", "tenders", "evaluation", "finance", "cases", "admin"];
