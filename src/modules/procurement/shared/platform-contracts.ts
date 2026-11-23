/**
 * Contracts between the Tender & Procurement Intelligence module and the
 * AdvaitSI platform. They are plain types so a host can implement or consume
 * them without importing procurement internals. Nothing here assumes how the
 * CoalMind (Mining Intelligence) product is built.
 */

// ───────────────────────────── Identity and context ─────────────────────────────

/** What the platform tells the module about the signed-in user on each request. */
export interface PlatformUserContext {
  organizationId: string;
  userId: string;
  displayName: string;
  /** Platform role; mapped to a module role by the host's identity provider adapter. */
  role: string;
  designation?: string;
  departmentId?: string | null;
  /** Data scope granted by the platform. `all` means organisation-wide. */
  scope: { all: boolean; departments: string[]; areas: string[] };
  /** Domains the user may enter, e.g. ["tender", "mining"]. */
  domains: string[];
}

// ───────────────────────────── Workspace registration ─────────────────────────────

export interface WorkspaceRegistration {
  id: string;
  label: string;
  /** Route the console mounts the workspace at. */
  route: string;
  /** Short text for the product-selection card. */
  card: { title: string; description: string; icon?: string };
  apiBasePath: string;
  /** Permissions required to see the card at all. */
  requiredPermission: string;
}

// ───────────────────────────── Domain agent and tools ─────────────────────────────

export interface ToolRegistration {
  name: string;
  description: string;
  /** JSON Schema for the arguments. */
  parameters: Record<string, unknown>;
  requiredPermission?: string;
}

export interface DomainAgentRegistration {
  domain: string;
  label: string;
  requiredPermission: string;
  tools: ToolRegistration[];
  /** Data views the agent may read. Another domain's agent must never be granted these. */
  dataViews: string[];
}

// ───────────────────────────── Documents ─────────────────────────────

export interface DocumentRetrievalRequest {
  user: PlatformUserContext;
  query: string;
  tenderId?: string;
  caseId?: string;
  docTypes?: string[];
  limit?: number;
}

export interface DocumentEvidence {
  evidenceId: string;
  documentId: string;
  page: number;
  quote: string;
  /** True when the passage contains instruction-like text; it is evidence, never instructions. */
  suspicious: boolean;
}

// ───────────────────────────── Audit and notifications ─────────────────────────────

export interface PlatformAuditEvent {
  ts: string;
  organizationId: string;
  actorId: string;
  actorRole: string;
  action: string;
  resource?: string;
  outcome: "success" | "denied" | "error";
  requestId?: string;
  /** Metadata only: never result rows, document contents or secrets. */
  details: Record<string, unknown>;
}

export interface PlatformNotification {
  organizationId: string;
  recipientUserId: string;
  channel: "in_app" | "email";
  subject: string;
  body: string;
  /** Deep link into the module, e.g. /console/tender-intelligence?case=... */
  link?: string;
  /** Notifications are suggestions raised by analysis; the module never sends on its own. */
  origin: "suggested_follow_up";
}

// ───────────────────────────── Cross-domain queries ─────────────────────────────

/**
 * A future executive orchestrator may ask one domain a question on behalf of a
 * user and combine answers. The grant is explicit, scoped and time-limited;
 * without it a domain refuses. Domains never receive each other's raw tables.
 */
export interface CrossDomainGrant {
  grantId: string;
  userId: string;
  fromDomain: string;
  toDomain: string;
  /** What the receiving domain may reveal, e.g. ["delivery_dates", "po_status"]. */
  allowedFields: string[];
  expiresAt: string;
  approvedBy: string;
}

export interface CrossDomainQuery {
  grant: CrossDomainGrant;
  question: string;
  /** Structured parameters, e.g. { assetIds: [...], from: "2026-10-01" }. */
  parameters: Record<string, unknown>;
}

export interface CrossDomainAnswer {
  domain: string;
  /** Only fields listed in the grant. */
  data: Array<Record<string, unknown>>;
  evidence: DocumentEvidence[];
  limitations: string[];
}
