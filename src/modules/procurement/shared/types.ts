/**
 * Wire contracts between the procurement API and the React workspace.
 * A host application can implement `ProcurementApi` over its own backend
 * and keep every UI component unchanged.
 */

export type Fmt =
  | "text"
  | "money"
  | "int"
  | "num"
  | "pct"
  | "date"
  | "days"
  | "badge";

export type Tone = "neutral" | "good" | "warn" | "bad";

export type RecordRow = Record<string, string | number | boolean | null>;

export interface Column {
  key: string;
  label: string;
  fmt?: Fmt;
}

export interface DataTable {
  title?: string;
  subtitle?: string;
  columns: Column[];
  rows: RecordRow[];
  /** Row keys that make a row clickable (case, vendor or document id). */
  caseKey?: string;
  vendorKey?: string;
  documentKey?: string;
  total?: number;
}

export interface Kpi {
  label: string;
  value: number | string;
  fmt?: Fmt;
  hint?: string;
  tone?: Tone;
  /** Drill key understood by the case register (`drill` filter). */
  drill?: string;
}

export interface ChartDatum {
  label: string;
  value: number;
  secondary?: number;
  drill?: string;
}

export interface Chart {
  title: string;
  subtitle?: string;
  kind: "bars" | "columns";
  fmt?: Fmt;
  primaryLabel?: string;
  secondaryLabel?: string;
  data: ChartDatum[];
}

export interface ModuleView {
  id: string;
  title: string;
  summary: string;
  asOf: string;
  kpis: Kpi[];
  charts: Chart[];
  tables: DataTable[];
  notes: string[];
}

export interface CaseSummary {
  caseId: string;
  tenderId: string | null;
  title: string;
  department: string;
  category: string;
  stage: string;
  status: string;
  priority: string;
  riskCategory: string;
  riskScore: number;
  estimatedValue: number;
  awardValue: number;
  delayDays: number;
  vendorName: string | null;
  nextAction: string;
  startedDate: string;
}

export interface CaseFilters {
  q?: string;
  stage?: string;
  status?: string;
  risk?: string;
  department?: string;
  category?: string;
  scenario?: string;
  drill?: string;
  sort?: string;
  limit?: number;
  offset?: number;
}

export interface CaseList {
  total: number;
  rows: CaseSummary[];
  facets: {
    stages: string[];
    statuses: string[];
    risks: string[];
    departments: Array<{ id: string; name: string }>;
    categories: Array<{ id: string; name: string }>;
    scenarios: string[];
  };
  drillTitle?: string;
}

export interface DetailField {
  label: string;
  value: string | number | boolean | null;
  fmt?: Fmt;
}

export interface DetailSection {
  id: string;
  title: string;
  description?: string;
  fields?: DetailField[];
  tables?: DataTable[];
  matrix?: {
    title: string;
    columns: string[];
    rows: Array<{ label: string; cells: Array<{ text: string; tone?: Tone }> }>;
  };
  notes?: string[];
}

export interface DocumentRef {
  documentId: string;
  docType: string;
  title: string;
  stage: string;
  version: number;
  pages: number;
  createdDate: string;
  caseId: string;
  available: boolean;
}

export interface EntityDetail {
  kind: "case" | "vendor";
  id: string;
  title: string;
  subtitle: string;
  badges: Array<{ label: string; tone?: Tone }>;
  sections: DetailSection[];
  documents: DocumentRef[];
}

export interface DocumentList {
  total: number;
  rows: DocumentRef[];
  docTypes: Array<{ id: string; count: number }>;
}

export interface AiArtifact {
  artifactId: string;
  resultId: string;
  title: string;
  columns: string[];
  rows: RecordRow[];
  formats?: Record<string, Fmt>;
  total: number;
}

export interface AiCitation {
  evidenceId: string;
  kind: "record" | "document" | "rule" | "table";
  type: string;
  id: string;
  label: string;
  page?: number;
  documentId?: string;
  caseId?: string;
  vendorId?: string;
  quote?: string;
  /** True when the answer text actually cites this evidence. */
  cited: boolean;
}

export interface AiToolTrace {
  name: string;
  args: unknown;
  summary: string;
  resultId?: string;
  rows: number;
  ms: number;
  error?: string;
}

export interface AiUsage {
  inputTokens: number;
  outputTokens: number;
  toolCalls: number;
  rounds: number;
  latencyMs: number;
  estimatedCostUsd: number | null;
}

export interface AiAnswer {
  answerId: string;
  conversationId: string;
  text: string;
  artifacts: AiArtifact[];
  citations: AiCitation[];
  toolTrace: AiToolTrace[];
  warnings: string[];
  usage: AiUsage;
  model: string;
  asOf: string;
}

export type AiEvent =
  | { type: "meta"; conversationId: string; model: string; tools: string[] }
  | { type: "tool_start"; name: string; args: unknown }
  | { type: "tool_result"; name: string; summary: string; ms: number; rows: number; error?: string }
  | { type: "delta"; text: string }
  | { type: "reset_text" }
  | { type: "final"; answer: AiAnswer }
  | { type: "error"; code: string; message: string };

export interface ConversationSummary {
  conversationId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

export interface StoredMessage {
  messageId: number;
  role: "user" | "assistant";
  content: string;
  payload: AiAnswer | null;
  createdAt: string;
}

export interface SessionUser {
  id: string;
  username: string;
  name: string;
  role: string;
  roleLabel: string;
  designation: string;
  departmentId: string | null;
  scopeSummary: string;
  permissions: string[];
  views: string[];
}

export interface DatasetInfo {
  synthetic: true;
  label: string;
  asOf: string;
  tables: number;
  cases: number;
  documents: number;
  documentsOnDisk: boolean;
  disclaimer: string;
}

/** Everything the workspace needs from a backend. */
export interface ProcurementApi {
  info(): Promise<DatasetInfo>;
  module(id: string): Promise<ModuleView>;
  cases(filters: CaseFilters): Promise<CaseList>;
  caseDetail(caseId: string): Promise<EntityDetail>;
  vendorDetail(vendorId: string): Promise<EntityDetail>;
  documents(params: {
    q?: string;
    type?: string;
    limit?: number;
    offset?: number;
  }): Promise<DocumentList>;
  documentUrl(documentId: string): string;
  me(): Promise<SessionUser | null>;
  login(username: string, password: string): Promise<SessionUser>;
  logout(): Promise<void>;
  loginHints(): Promise<Array<{ username: string; name: string; role: string; designation: string }>>;
  conversations(): Promise<ConversationSummary[]>;
  messages(conversationId: string): Promise<StoredMessage[]>;
  /** Streams one agent turn; resolves with the final answer. */
  ask(
    question: string,
    options: { conversationId?: string; caseId?: string; onEvent?: (event: AiEvent) => void; signal?: AbortSignal },
  ): Promise<AiAnswer>;
  admin(path: string): Promise<unknown>;
}

export const MODULE_IDS = [
  "overview",
  "tenders",
  "evaluation",
  "finance",
  "workflow",
  "contracts",
  "delivery",
  "vendors",
  "audit",
] as const;

export type ModuleId = (typeof MODULE_IDS)[number];
