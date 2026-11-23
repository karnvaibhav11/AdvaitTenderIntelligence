import type { RecordRow } from "../../shared/types";

/**
 * Evidence ledger. Every record, document page or rule a tool returns is
 * registered here and given an id (E1, E2, ...). The model may cite only these
 * ids; the server checks each citation in the final answer against the ledger,
 * so a citation can never point at something that was not actually retrieved.
 */

export type EvidenceKind = "record" | "document" | "rule" | "table";

export interface EvidenceInput {
  kind: EvidenceKind;
  /** case | vendor | tender | po | contract | document | rule | table */
  type: string;
  id: string;
  label: string;
  page?: number;
  documentId?: string;
  caseId?: string;
  vendorId?: string;
  quote?: string;
}

export interface Evidence extends EvidenceInput {
  evidenceId: string;
}

export interface Section {
  title: string;
  columns: string[];
  rows: RecordRow[];
  /** Optional per-column display format hints for the UI. */
  formats?: Record<string, "money" | "int" | "num" | "pct" | "date" | "days" | "badge">;
}

export interface ToolOutput {
  summary: string;
  sections: Section[];
  evidence?: EvidenceInput[];
  notes?: string[];
}

export interface StoredResult {
  resultId: string;
  tool: string;
  args: unknown;
  summary: string;
  sections: Section[];
  evidenceIds: string[];
  notes: string[];
}

export class EvidenceLedger {
  private readonly evidence = new Map<string, Evidence>();
  private readonly keys = new Map<string, string>();
  private readonly results = new Map<string, StoredResult>();

  constructor(private readonly turn = 1) {}

  cite(input: EvidenceInput): string {
    const key = `${input.kind}:${input.type}:${input.id}:${input.page ?? ""}`;
    const existing = this.keys.get(key);
    if (existing) return existing;
    const evidenceId = `E${this.keys.size + 1}`;
    this.keys.set(key, evidenceId);
    this.evidence.set(evidenceId, { ...input, evidenceId });
    return evidenceId;
  }

  /** Records for the first rows of a section so the model can cite what it was shown. */
  citeRows(section: Section, limit = 12): string[] {
    const ids: string[] = [];
    for (const row of section.rows.slice(0, limit)) {
      if (typeof row.case_id === "string") ids.push(this.cite({ kind: "record", type: "case", id: row.case_id, label: `Case ${row.case_id.replace("ADV-DEMO-", "")}`, caseId: row.case_id }));
      if (typeof row.vendor_id === "string") ids.push(this.cite({ kind: "record", type: "vendor", id: row.vendor_id, label: typeof row.vendor_name === "string" ? row.vendor_name : typeof row.company_name === "string" ? row.company_name : row.vendor_id, vendorId: row.vendor_id }));
    }
    return ids;
  }

  store(tool: string, args: unknown, output: ToolOutput): StoredResult {
    const resultId = `R${this.results.size + 1}`;
    const evidenceIds = new Set<string>();
    for (const item of output.evidence ?? []) evidenceIds.add(this.cite(item));
    for (const section of output.sections) for (const id of this.citeRows(section)) evidenceIds.add(id);
    const stored: StoredResult = { resultId, tool, args, summary: output.summary, sections: output.sections, evidenceIds: [...evidenceIds], notes: output.notes ?? [] };
    this.results.set(resultId, stored);
    return stored;
  }

  get(evidenceId: string): Evidence | undefined {
    return this.evidence.get(evidenceId);
  }

  getResult(resultId: string): StoredResult | undefined {
    return this.results.get(resultId);
  }

  allEvidence(): Evidence[] {
    return [...this.evidence.values()];
  }

  allResults(): StoredResult[] {
    return [...this.results.values()];
  }

  get turnNumber(): number {
    return this.turn;
  }
}

/** Compact view of a stored result for the model (never more than it needs). */
export function forModel(result: StoredResult, rowLimit = 40): unknown {
  return {
    result_id: result.resultId,
    summary: result.summary,
    evidence_ids: result.evidenceIds,
    notes: result.notes,
    sections: result.sections.map((section) => ({
      title: section.title,
      columns: section.columns,
      row_count: section.rows.length,
      rows: section.rows.slice(0, rowLimit),
      truncated: section.rows.length > rowLimit,
    })),
  };
}
