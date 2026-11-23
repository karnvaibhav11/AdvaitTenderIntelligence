import { parse } from "csv-parse/sync";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { ManifestRow } from "./types";

/** Corpus root (directory containing data/ and documents/). */
export function resolveCorpusRoot(): string {
  if (process.env.PROCUREMENT_CORPUS_DIR) return path.resolve(process.env.PROCUREMENT_CORPUS_DIR);
  if (process.env.PROCUREMENT_DATA_DIR) return path.resolve(process.env.PROCUREMENT_DATA_DIR, "..");
  return path.resolve(process.cwd(), "../ADVAITSI_GEM_SYNTHETIC_PROCUREMENT");
}

export function resolveDataDir(): string {
  return process.env.PROCUREMENT_DATA_DIR ? path.resolve(process.env.PROCUREMENT_DATA_DIR) : path.join(resolveCorpusRoot(), "data");
}

/** Directory against which manifest `relative_path` values (e.g. documents/<case>/...) resolve. */
export function resolveDocumentsRoot(): string {
  return process.env.PROCUREMENT_DOCUMENTS_DIR ? path.resolve(process.env.PROCUREMENT_DOCUMENTS_DIR, "..") : resolveCorpusRoot();
}

export function readCsv(file: string): Array<Record<string, string>> {
  return parse(readFileSync(file, "utf8"), { bom: true, columns: true, skip_empty_lines: true, relax_quotes: true }) as Array<Record<string, string>>;
}

export function loadManifest(dataDir = resolveDataDir()): ManifestRow[] {
  return readCsv(path.join(dataDir, "document_metadata.csv")).map((r) => ({
    document_id: r.document_id,
    case_id: r.case_id,
    doc_type: r.doc_type,
    stage_name: r.stage_name,
    title: r.title,
    version: Number(r.version) || 1,
    created_date: r.created_date,
    supersedes_document_id: r.supersedes_document_id ?? "",
    tender_id: r.tender_id ?? "",
    po_number: r.po_number ?? "",
    relative_path: r.relative_path,
    page_count: Number(r.page_count) || 0,
    file_size_bytes: Number(r.file_size_bytes) || 0,
    sha256: (r.sha256 ?? "").toLowerCase(),
  }));
}

/** Deterministic stratified sample covering every doc_type, spread across the corpus. */
export function stratifiedSample(rows: ManifestRow[], total: number): ManifestRow[] {
  const byType = new Map<string, ManifestRow[]>();
  for (const row of [...rows].sort((a, b) => a.document_id.localeCompare(b.document_id))) {
    const list = byType.get(row.doc_type) ?? [];
    list.push(row);
    byType.set(row.doc_type, list);
  }
  const types = [...byType.keys()].sort();
  const perType = Math.max(1, Math.floor(total / types.length));
  const out: ManifestRow[] = [];
  const seen = new Set<string>();
  for (const type of types) {
    const list = byType.get(type)!;
    const step = Math.max(1, Math.floor(list.length / perType));
    for (let i = 0, n = 0; i < list.length && n < perType; i += step, n++) {
      out.push(list[i]);
      seen.add(list[i].document_id);
    }
  }
  for (const row of rows) {
    if (out.length >= total) break;
    if (!seen.has(row.document_id)) {
      out.push(row);
      seen.add(row.document_id);
    }
  }
  return out.slice(0, Math.max(total, 0));
}
