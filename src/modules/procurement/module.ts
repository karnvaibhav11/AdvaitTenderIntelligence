import type { WorkspaceRegistration } from "./shared/platform-contracts";

/**
 * Registration descriptor the AdvaitSI console reads to expose this product:
 * a product-selection card, a route and the API it talks to. Nothing is
 * registered automatically; the host imports this and wires it into its own
 * navigation.
 */
export const tenderIntelligenceModule: WorkspaceRegistration = {
  id: "tender-intelligence",
  label: "Tender & Procurement Intelligence",
  route: "/console/tender-intelligence",
  card: {
    title: "Tender & Procurement Intelligence",
    description:
      "The complete procurement lifecycle in one place: tenders, bid evaluation, approvals, purchase orders, contracts, delivery, invoices and audit, with a TattvaAI analyst that cites its evidence.",
    icon: "document",
  },
  apiBasePath: "/api/procurement",
  requiredPermission: "view:tattva",
};
