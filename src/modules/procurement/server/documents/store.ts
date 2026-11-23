import { mkdirSync } from "node:fs";
import path from "node:path";
import { EXTRACTOR_VERSION, type ManifestRow, type ProcessedDocument } from "./types";

/** Minimal typings for node:sqlite (loaded via getBuiltinModule so bundlers never try to resolve it). */
export interface SqliteStatement {
  all(...params: unknown[]): unknown[];
  get(...params: unknown[]): unknown;
  run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
  iterate(...params: unknown[]): IterableIterator<unknown>;
}
export interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
}

export interface DocumentIndex {
  db: SqliteDatabase;
  path: string;
  readOnly: boolean;
  close(): void;
}

export const DEFAULT_DB_PATH = ".data/documents.db";

export function resolveDbPath(explicit?: string): string {
  return path.resolve(explicit ?? process.env.PROCUREMENT_DOCS_DB ?? DEFAULT_DB_PATH);
}

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS documents (
  document_id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL,
  tender_id TEXT,
  po_number TEXT,
  doc_type TEXT NOT NULL,
  title TEXT,
  version INTEGER,
  supersedes_document_id TEXT,
  relative_path TEXT,
  page_count INTEGER,
  sha256 TEXT,
  ocr_status TEXT,
  extraction_status TEXT,
  extracted_at TEXT,
  text_chars INTEGER,
  synthetic INTEGER NOT NULL DEFAULT 1,
  extractor_version TEXT,
  detected_doc_type TEXT,
  title_verified INTEGER,
  doc_date TEXT,
  department TEXT,
  organisation TEXT,
  chunk_count INTEGER,
  table_row_count INTEGER,
  warnings TEXT,
  error TEXT
);
CREATE INDEX IF NOT EXISTS idx_documents_case ON documents(case_id);
CREATE INDEX IF NOT EXISTS idx_documents_tender ON documents(tender_id);
CREATE INDEX IF NOT EXISTS idx_documents_po ON documents(po_number);
CREATE INDEX IF NOT EXISTS idx_documents_type ON documents(doc_type);

CREATE TABLE IF NOT EXISTS pages (
  document_id TEXT NOT NULL,
  page_no INTEGER NOT NULL,
  text TEXT NOT NULL,
  has_text_layer INTEGER NOT NULL,
  PRIMARY KEY (document_id, page_no)
);

CREATE TABLE IF NOT EXISTS chunks (
  chunk_id INTEGER PRIMARY KEY,
  document_id TEXT NOT NULL,
  page_start INTEGER NOT NULL,
  page_end INTEGER NOT NULL,
  chunk_no INTEGER NOT NULL,
  chunk_type TEXT NOT NULL CHECK (chunk_type IN ('text','table')),
  heading TEXT,
  text TEXT NOT NULL,
  table_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_chunks_doc ON chunks(document_id, chunk_no);

CREATE TABLE IF NOT EXISTS table_rows (
  row_id INTEGER PRIMARY KEY,
  document_id TEXT NOT NULL,
  page INTEGER NOT NULL,
  table_no INTEGER NOT NULL,
  section TEXT,
  row_no INTEGER NOT NULL,
  kind TEXT NOT NULL,
  header_json TEXT,
  cells_json TEXT NOT NULL,
  record_json TEXT NOT NULL,
  text TEXT NOT NULL,
  amounts_json TEXT,
  continued INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_table_rows_doc ON table_rows(document_id, row_no);

CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
  text, heading,
  content='chunks', content_rowid='chunk_id',
  tokenize='porter unicode61 remove_diacritics 2'
);
CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
  INSERT INTO chunks_fts(rowid, text, heading) VALUES (new.chunk_id, new.text, new.heading);
END;
CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, text, heading) VALUES ('delete', old.chunk_id, old.text, old.heading);
  DELETE FROM chunk_embeddings WHERE chunk_id = old.chunk_id;
END;

CREATE TABLE IF NOT EXISTS chunk_embeddings (
  chunk_id INTEGER NOT NULL,
  model TEXT NOT NULL,
  dim INTEGER NOT NULL,
  vector BLOB NOT NULL,
  PRIMARY KEY (chunk_id, model)
);

CREATE TABLE IF NOT EXISTS ingest_runs (
  run_id INTEGER PRIMARY KEY,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  extractor_version TEXT,
  options_json TEXT,
  candidates INTEGER,
  ingested INTEGER,
  skipped INTEGER,
  failed INTEGER,
  needs_ocr INTEGER,
  pages INTEGER,
  chunks INTEGER,
  table_rows INTEGER,
  seconds REAL,
  docs_per_second REAL,
  status TEXT,
  failures_json TEXT
);
`;

function loadSqlite(): { DatabaseSync: new (file: string, options?: Record<string, unknown>) => SqliteDatabase } {
  const mod = process.getBuiltinModule?.("node:sqlite");
  if (!mod) throw new Error("node:sqlite is not available in this runtime (Node 22.5+ required)");
  return mod as never;
}

/** Opens (and, unless readOnly, creates + migrates) the document index database. */
export function openDocumentIndex(dbPath?: string, options: { readOnly?: boolean } = {}): DocumentIndex {
  const file = resolveDbPath(dbPath);
  const { DatabaseSync } = loadSqlite();
  const readOnly = options.readOnly === true;
  if (!readOnly) mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file, readOnly ? { readOnly: true } : {});
  if (!readOnly) {
    db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;");
    db.exec(SCHEMA_SQL);
  }
  db.exec("PRAGMA busy_timeout = 5000;");
  return { db, path: file, readOnly, close: () => db.close() };
}

const stmtCache = new WeakMap<SqliteDatabase, Map<string, SqliteStatement>>();
export function prepared(db: SqliteDatabase, sql: string): SqliteStatement {
  let map = stmtCache.get(db);
  if (!map) stmtCache.set(db, (map = new Map()));
  let stmt = map.get(sql);
  if (!stmt) map.set(sql, (stmt = db.prepare(sql)));
  return stmt;
}

export interface StoredDocumentState {
  sha256: string | null;
  extractor_version: string | null;
  extraction_status: string | null;
}

export function storedState(index: DocumentIndex, documentId: string): StoredDocumentState | undefined {
  return prepared(index.db, "SELECT sha256, extractor_version, extraction_status FROM documents WHERE document_id = ?").get(documentId) as StoredDocumentState | undefined;
}

/** A document is up to date when the manifest sha256 and extractor version match and it did not fail. */
export function isUpToDate(index: DocumentIndex, row: ManifestRow): boolean {
  const state = storedState(index, row.document_id);
  return !!state && state.sha256 === row.sha256 && state.extractor_version === EXTRACTOR_VERSION && state.extraction_status !== "failed";
}

/** Replaces everything stored for the document in one transaction. */
export function writeDocument(index: DocumentIndex, doc: ProcessedDocument): void {
  const { db } = index;
  const m = doc.manifest;
  db.exec("BEGIN IMMEDIATE");
  try {
    prepared(db, "DELETE FROM chunks WHERE document_id = ?").run(m.document_id);
    prepared(db, "DELETE FROM pages WHERE document_id = ?").run(m.document_id);
    prepared(db, "DELETE FROM table_rows WHERE document_id = ?").run(m.document_id);
    prepared(db, "DELETE FROM documents WHERE document_id = ?").run(m.document_id);

    prepared(
      db,
      `INSERT INTO documents (document_id, case_id, tender_id, po_number, doc_type, title, version, supersedes_document_id, relative_path, page_count, sha256,
         ocr_status, extraction_status, extracted_at, text_chars, synthetic, extractor_version, detected_doc_type, title_verified, doc_date, department, organisation,
         chunk_count, table_row_count, warnings, error)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      m.document_id,
      m.case_id,
      m.tender_id || null,
      m.po_number || null,
      m.doc_type,
      m.title,
      m.version,
      m.supersedes_document_id || null,
      m.relative_path,
      m.page_count,
      doc.sha256 || m.sha256,
      doc.ocrStatus,
      doc.extractionStatus,
      new Date().toISOString(),
      doc.textChars,
      EXTRACTOR_VERSION,
      doc.classification?.detectedDocType ?? null,
      doc.classification ? (doc.classification.titleMatchesManifest ? 1 : 0) : null,
      doc.metadata?.documentDate ?? null,
      doc.metadata?.department ?? null,
      doc.metadata?.organisation ?? null,
      doc.chunks.length,
      doc.tableRows.length,
      doc.warnings.length ? JSON.stringify(doc.warnings) : null,
      doc.error ?? null,
    );

    const page = prepared(db, "INSERT INTO pages (document_id, page_no, text, has_text_layer) VALUES (?,?,?,?)");
    for (const p of doc.pages) page.run(m.document_id, p.pageNo, p.text, p.hasTextLayer ? 1 : 0);

    const chunk = prepared(
      db,
      "INSERT INTO chunks (document_id, page_start, page_end, chunk_no, chunk_type, heading, text, table_json) VALUES (?,?,?,?,?,?,?,?)",
    );
    for (const c of doc.chunks) chunk.run(m.document_id, c.pageStart, c.pageEnd, c.chunkNo, c.chunkType, c.heading, c.text, c.tableJson);

    const row = prepared(
      db,
      "INSERT INTO table_rows (document_id, page, table_no, section, row_no, kind, header_json, cells_json, record_json, text, amounts_json, continued) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
    );
    for (const r of doc.tableRows) {
      row.run(
        m.document_id,
        r.page,
        r.tableNo,
        r.section,
        r.rowNo,
        r.kind,
        r.header ? JSON.stringify(r.header) : null,
        JSON.stringify(r.cells),
        JSON.stringify(r.record),
        r.text,
        r.amounts.length ? JSON.stringify(r.amounts) : null,
        r.continued ? 1 : 0,
      );
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
