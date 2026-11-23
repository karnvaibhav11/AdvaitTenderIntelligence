/**
 * Roles, permissions and data scope. Enforced on the backend only: the UI
 * reads the principal to tailor itself but is never trusted to enforce it.
 */

export const VIEW_IDS = [
  "overview",
  "tenders",
  "evaluation",
  "finance",
  "workflow",
  "contracts",
  "delivery",
  "vendors",
  "audit",
  "cases",
  "documents",
  "tattva",
  "admin",
] as const;

export type ViewPermission = `view:${(typeof VIEW_IDS)[number]}`;
export type DataPermission = "data:bids_financial" | "data:payments" | "data:budget";
export type CapabilityPermission = "ai:query" | "ai:sql" | "export:csv" | "admin:audit" | "admin:users";
export type Permission = ViewPermission | DataPermission | CapabilityPermission;

export type RoleId =
  | "cmd"
  | "director"
  | "functional_head"
  | "gm"
  | "area_gm"
  | "procurement_head"
  | "tender_officer"
  | "finance_officer"
  | "technical_evaluator"
  | "auditor"
  | "administrator"
  | "super_admin";

export interface Scope {
  /** Organisation-wide access to procurement records. */
  all: boolean;
  /** Department ids the principal may see when `all` is false. */
  departments: string[];
  /** Area ids; when non-empty, records outside these areas are hidden. */
  areas: string[];
}

export interface Principal {
  id: string;
  username: string;
  name: string;
  role: RoleId;
  designation: string;
  officerId: string | null;
  departmentId: string | null;
  scope: Scope;
  permissions: Permission[];
  provider: string;
}

const v = (...ids: Array<(typeof VIEW_IDS)[number]>): ViewPermission[] => ids.map((id) => `view:${id}` as ViewPermission);

const ALL_DATA: DataPermission[] = ["data:bids_financial", "data:payments", "data:budget"];

export const ROLE_DEFINITIONS: Record<RoleId, { label: string; summary: string; permissions: Permission[] }> = {
  cmd: {
    label: "Chairman-cum-Managing Director",
    summary: "Organisation-wide, exception-first view",
    permissions: [...v("overview", "tenders", "finance", "workflow", "contracts", "delivery", "vendors", "audit", "cases", "documents", "tattva"), ...ALL_DATA, "ai:query", "ai:sql", "export:csv"],
  },
  director: {
    label: "Director",
    summary: "Organisation-wide oversight",
    permissions: [...v("overview", "tenders", "finance", "workflow", "contracts", "delivery", "vendors", "audit", "cases", "documents", "tattva"), ...ALL_DATA, "ai:query", "ai:sql", "export:csv"],
  },
  functional_head: {
    label: "Functional head",
    summary: "Own department's procurement",
    permissions: [...v("overview", "tenders", "finance", "workflow", "contracts", "delivery", "vendors", "cases", "documents", "tattva"), "data:payments", "data:budget", "ai:query", "export:csv"],
  },
  gm: {
    label: "General Manager",
    summary: "Own department's procurement",
    permissions: [...v("overview", "tenders", "finance", "workflow", "contracts", "delivery", "vendors", "cases", "documents", "tattva"), "data:payments", "data:budget", "ai:query", "export:csv"],
  },
  area_gm: {
    label: "Area General Manager",
    summary: "Procurement for the assigned area",
    permissions: [...v("overview", "tenders", "finance", "workflow", "contracts", "delivery", "vendors", "cases", "documents", "tattva"), "data:payments", "ai:query", "export:csv"],
  },
  procurement_head: {
    label: "Procurement head",
    summary: "All departments, full procurement lifecycle",
    permissions: [...v("overview", "tenders", "evaluation", "finance", "workflow", "contracts", "delivery", "vendors", "cases", "documents", "tattva"), ...ALL_DATA, "ai:query", "ai:sql", "export:csv"],
  },
  tender_officer: {
    label: "Tender officer",
    summary: "Tenders, evaluation and contracts in own department",
    permissions: [...v("overview", "tenders", "evaluation", "workflow", "contracts", "delivery", "vendors", "cases", "documents", "tattva"), "data:bids_financial", "ai:query", "export:csv"],
  },
  finance_officer: {
    label: "Finance officer",
    summary: "Budgets, invoices and payments across departments",
    permissions: [...v("overview", "finance", "contracts", "delivery", "audit", "cases", "documents", "tattva"), "data:payments", "data:budget", "data:bids_financial", "ai:query", "export:csv"],
  },
  technical_evaluator: {
    label: "Technical evaluator",
    summary: "Technical compliance; financial bids are not visible",
    permissions: [...v("tenders", "evaluation", "vendors", "cases", "documents", "tattva"), "ai:query"],
  },
  auditor: {
    label: "Internal auditor",
    summary: "Read-only access across departments for audit",
    permissions: [...v("overview", "tenders", "evaluation", "finance", "workflow", "contracts", "delivery", "vendors", "audit", "cases", "documents", "tattva"), ...ALL_DATA, "ai:query", "ai:sql", "export:csv"],
  },
  super_admin: {
    label: "Administrator",
    summary: "Full access to every dashboard, TattvaAI and administration",
    permissions: [...v(...VIEW_IDS), ...ALL_DATA, "ai:query", "ai:sql", "export:csv", "admin:audit", "admin:users"],
  },
  administrator: {
    label: "System administrator",
    summary: "Users, audit log and data sources; no procurement records",
    permissions: [...v("admin"), "admin:audit", "admin:users"],
  },
};

export function hasPermission(principal: Principal, permission: Permission): boolean {
  return principal.permissions.includes(permission);
}

export function assertPermission(principal: Principal, permission: Permission): void {
  if (!hasPermission(principal, permission)) {
    throw new AuthorizationError(`Permission ${permission} is required`);
  }
}

export class AuthorizationError extends Error {
  readonly status = 403;
}

export class AuthenticationError extends Error {
  readonly status = 401;
}

/** Stable key for caches that depend on what a principal can see. */
export function scopeKey(principal: Principal): string {
  const scope = principal.scope.all ? "all" : `${[...principal.scope.departments].sort().join(",")}|${[...principal.scope.areas].sort().join(",")}`;
  const data = principal.permissions.filter((p) => p.startsWith("data:")).sort().join(",");
  return `${scope}#${data}`;
}

/**
 * Segregation of duties: an officer who prepared a transaction may not also
 * approve it. Returns the reason when the combination is not allowed.
 */
export function segregationViolation(preparerId: string | null | undefined, approverId: string | null | undefined): string | null {
  if (preparerId && approverId && preparerId === approverId) {
    return "The same officer prepared and approved this transaction";
  }
  return null;
}
