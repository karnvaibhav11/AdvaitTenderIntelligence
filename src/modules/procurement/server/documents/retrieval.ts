import { blobToVector, normalizeVector } from "./embeddings";
import { prepared, type DocumentIndex } from "./store";

// ---------------------------------------------------------------------------
// Untrusted-text heuristics

const INSTRUCTION_PATTERNS: RegExp[] = [
  /\bignore\s+(?:all\s+|any\s+|the\s+|your\s+)?(?:previous|prior|above|earlier|preceding)\s+(?:instructions?|prompts?|messages?|rules|context)/i,
  /\bdisregard\b/i,
  /\bsystem\s+prompt\b/i,
  /\byou\s+are\s+now\b/i,
  /\breveal\b[^.\n]{0,40}\b(?:prompt|instructions?|secrets?|keys?|passwords?|credentials?|system|confidential|hidden)\b/i,
  /\bapi[\s_-]?keys?\b/i,
  /\b(?:new|updated|override)\s+instructions?\b/i,
  /\bforget\s+(?:everything|all|your|previous)\b/i,
  /\bdo\s+not\s+(?:tell|inform|reveal\s+to)\s+the\s+user\b/i,
  /\b(?:developer|system)\s+(?:message|mode)\b/i,
  /\bjailbreak\b/i,
  /\bpretend\s+(?:to\s+be|you\s+are)\b/i,
  /<\s*\/?\s*(?:system|assistant|instructions?)\s*>/i,
];

/** Heuristic prompt-injection detector. Retrieved text is data; flagged chunks are kept but marked suspicious. */
export function containsInstructionLikeText(text: string): boolean {
  if (!text) return false;
  return INSTRUCTION_PATTERNS.some((re) => re.test(text));
}

// ---------------------------------------------------------------------------
// Types

export interface SearchParams {
  query: string;
  /** null/undefined = unrestricted; [] = nothing is allowed. Enforced inside SQL. */
  allowedCaseIds?: string[] | null;
  caseId?: string;
  tenderId?: string;
  poNumber?: string;
  documentId?: string;
  docTypes?: string[];
  limit?: number;
  queryEmbedding?: number[] | null;
  /** Needed only when several embedding models of the same dimension are stored. */
  embeddingModel?: string;
}

export type MatchSource = "keyword" | "vector";

export interface SearchResult {
  chunkId: number;
  documentId: string;
  caseId: string;
  tenderId: string | null;
  docType: string;
  title: string;
  version: number;
  pageStart: number;
  pageEnd: number;
  heading: string;
  chunkType: "text" | "table";
  text: string;
  /** Reciprocal-rank-fusion score (higher is better). */
  score: number;
  matchedBy: MatchSource[];
  /** Raw BM25 strength (-bm25, higher is better) when matched by keyword. */
  keywordScore?: number;
  /** Cosine similarity when matched by vector. */
  vectorScore?: number;
  /** True when the text looks like it contains prompt-injection instructions. */
  suspicious: boolean;
}

export interface Evidence {
  evidenceId: string;
  documentId: string;
  page: number;
  quote: string;
}

export const MAX_RESULT_TEXT = 2000;
const RRF_K = 60;
const CANDIDATES = 100;
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 100;

// ---------------------------------------------------------------------------
// Query sanitisation

const STOPWORDS = new Set(["a", "an", "the", "of", "and", "or", "to", "in", "on", "for", "is", "are", "was", "be", "by", "with", "as", "at", "it", "this", "that", "what", "which", "who", "how", "me", "my", "do", "does", "from", "not", "near"]);

/**
 * Turns arbitrary user text into a safe FTS5 MATCH expression: only letter/digit
 * tokens survive, each is double-quoted (so AND/OR/NEAR/* are literals), and the
 * terms are OR-ed with an extra exact-phrase term for short multi-word queries.
 * Returns null when nothing searchable remains.
 */
export function buildFtsQuery(query: string): string | null {
  const all = (query.normalize("NFKC").toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).slice(0, 40);
  const tokens = [...new Set(all.filter((t) => !STOPWORDS.has(t) || all.length <= 2))].slice(0, 24);
  if (!tokens.length) return null;
  const quote = (t: string) => `"${t.replace(/"/g, '""')}"`;
  const terms = tokens.map(quote);
  const phrase = all.length >= 2 && all.length <= 8 ? [`"${all.join(" ")}"`] : [];
  return [...phrase, ...terms].join(" OR ");
}

// ---------------------------------------------------------------------------
// Permission + filters (all applied in SQL)

function buildFilter(p: Pick<SearchParams, "allowedCaseIds" | "caseId" | "tenderId" | "poNumber" | "documentId" | "docTypes">): { sql: string; params: unknown[] } {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (p.allowedCaseIds !== undefined && p.allowedCaseIds !== null) {
    // One JSON parameter keeps the statement shape constant for any list size.
    clauses.push("d.case_id IN (SELECT value FROM json_each(?))");
    params.push(JSON.stringify(p.allowedCaseIds));
  }
  if (p.caseId) (clauses.push("d.case_id = ?"), params.push(p.caseId));
  if (p.tenderId) (clauses.push("d.tender_id = ?"), params.push(p.tenderId));
  if (p.poNumber) (clauses.push("d.po_number = ?"), params.push(p.poNumber));
  if (p.documentId) (clauses.push("d.document_id = ?"), params.push(p.documentId));
  if (p.docTypes?.length) (clauses.push("d.doc_type IN (SELECT value FROM json_each(?))"), params.push(JSON.stringify(p.docTypes)));
  return { sql: clauses.length ? ` AND ${clauses.join(" AND ")}` : "", params };
}

// ---------------------------------------------------------------------------
// Search

interface ChunkRow {
  chunk_id: number;
  document_id: string;
  case_id: string;
  tender_id: string | null;
  doc_type: string;
  title: string;
  version: number;
  page_start: number;
  page_end: number;
  heading: string | null;
  chunk_type: "text" | "table";
  text: string;
}

const CHUNK_COLUMNS = "c.chunk_id, c.document_id, d.case_id, d.tender_id, d.doc_type, d.title, d.version, c.page_start, c.page_end, c.heading, c.chunk_type, c.text";

function toResult(row: ChunkRow, score: number, matchedBy: MatchSource[], extra: Partial<SearchResult> = {}): SearchResult {
  const text = row.text.trim().slice(0, MAX_RESULT_TEXT);
  return {
    chunkId: Number(row.chunk_id),
    documentId: row.document_id,
    caseId: row.case_id,
    tenderId: row.tender_id,
    docType: row.doc_type,
    title: row.title,
    version: Number(row.version),
    pageStart: Number(row.page_start),
    pageEnd: Number(row.page_end),
    heading: row.heading ?? "",
    chunkType: row.chunk_type,
    text,
    score,
    matchedBy,
    suspicious: containsInstructionLikeText(row.text),
    ...extra,
  };
}

function keywordCandidates(index: DocumentIndex, params: SearchParams, depth: number): Array<{ chunkId: number; strength: number }> {
  const match = buildFtsQuery(params.query);
  if (!match) return [];
  const filter = buildFilter(params);
  const sql = `SELECT c.chunk_id AS chunk_id, bm25(chunks_fts, 1.0, 2.5) AS bm
    FROM chunks_fts JOIN chunks c ON c.chunk_id = chunks_fts.rowid JOIN documents d ON d.document_id = c.document_id
    WHERE chunks_fts MATCH ?${filter.sql}
    ORDER BY bm, c.chunk_id LIMIT ?`;
  const rows = prepared(index.db, sql).all(match, ...filter.params, depth) as Array<{ chunk_id: number; bm: number }>;
  return rows.map((r) => ({ chunkId: Number(r.chunk_id), strength: -r.bm }));
}

function resolveModel(index: DocumentIndex, dim: number, requested?: string): string | null {
  if (requested) return requested;
  const models = prepared(index.db, "SELECT DISTINCT model FROM chunk_embeddings WHERE dim = ?").all(dim) as Array<{ model: string }>;
  if (!models.length) return null;
  if (models.length > 1) throw new Error(`Several embedding models with dimension ${dim} are stored (${models.map((m) => m.model).join(", ")}); pass embeddingModel`);
  return models[0].model;
}

function vectorCandidates(index: DocumentIndex, params: SearchParams, depth: number): Array<{ chunkId: number; similarity: number }> {
  const raw = params.queryEmbedding;
  if (!raw || !raw.length) return [];
  const query = normalizeVector(raw);
  if (!query.some((x) => x !== 0)) return [];
  const model = resolveModel(index, query.length, params.embeddingModel);
  if (!model) return [];
  const filter = buildFilter(params);
  const sql = `SELECT e.chunk_id AS chunk_id, e.vector AS vector
    FROM chunk_embeddings e JOIN chunks c ON c.chunk_id = e.chunk_id JOIN documents d ON d.document_id = c.document_id
    WHERE e.model = ? AND e.dim = ?${filter.sql}`;
  const top: Array<{ chunkId: number; similarity: number }> = [];
  for (const row of prepared(index.db, sql).iterate(model, query.length, ...filter.params) as IterableIterator<{ chunk_id: number; vector: Uint8Array }>) {
    const vec = blobToVector(row.vector);
    let dot = 0;
    for (let i = 0; i < query.length; i++) dot += query[i] * vec[i];
    if (top.length < depth || dot > top[top.length - 1].similarity) {
      top.push({ chunkId: Number(row.chunk_id), similarity: dot });
      top.sort((a, b) => b.similarity - a.similarity || a.chunkId - b.chunkId);
      if (top.length > depth) top.pop();
    }
  }
  return top;
}

function fetchChunks(index: DocumentIndex, ids: number[]): Map<number, ChunkRow> {
  const out = new Map<number, ChunkRow>();
  if (!ids.length) return out;
  const rows = prepared(index.db, `SELECT ${CHUNK_COLUMNS} FROM chunks c JOIN documents d ON d.document_id = c.document_id WHERE c.chunk_id IN (SELECT value FROM json_each(?))`).all(JSON.stringify(ids)) as unknown as ChunkRow[];
  for (const r of rows) out.set(Number(r.chunk_id), r);
  return out;
}

/**
 * Hybrid retrieval: FTS5/BM25 keyword ranking fused (reciprocal rank fusion) with
 * cosine similarity over stored embeddings when `queryEmbedding` is supplied.
 * Permission (`allowedCaseIds`) and metadata filters are part of every SQL
 * statement, so disallowed chunks are never ranked, counted or returned.
 */
export function searchChunks(index: DocumentIndex, params: SearchParams): SearchResult[] {
  if (params.allowedCaseIds && params.allowedCaseIds.length === 0) return [];
  const limit = Math.min(Math.max(Math.floor(params.limit ?? DEFAULT_LIMIT), 1), MAX_LIMIT);
  const depth = Math.max(CANDIDATES, limit * 5);

  const keyword = keywordCandidates(index, params, depth);
  const vector = vectorCandidates(index, params, depth);

  const fused = new Map<number, { score: number; matchedBy: MatchSource[]; keywordScore?: number; vectorScore?: number }>();
  const bump = (id: number, source: MatchSource, rank: number, extra: { keywordScore?: number; vectorScore?: number }) => {
    const cur = fused.get(id) ?? { score: 0, matchedBy: [] as MatchSource[] };
    cur.score += 1 / (RRF_K + rank + 1);
    cur.matchedBy.push(source);
    Object.assign(cur, extra);
    fused.set(id, cur);
  };
  keyword.forEach((k, rank) => bump(k.chunkId, "keyword", rank, { keywordScore: k.strength }));
  vector.forEach((v, rank) => bump(v.chunkId, "vector", rank, { vectorScore: v.similarity }));

  const ranked = [...fused.entries()].sort((a, b) => b[1].score - a[1].score || a[0] - b[0]).slice(0, limit);
  const rows = fetchChunks(index, ranked.map(([id]) => id));
  const out: SearchResult[] = [];
  for (const [id, info] of ranked) {
    const row = rows.get(id);
    if (row) out.push(toResult(row, info.score, info.matchedBy, { keywordScore: info.keywordScore, vectorScore: info.vectorScore }));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Evidence

export function buildEvidence(result: Pick<SearchResult, "documentId" | "pageStart" | "chunkId" | "text">, options: { page?: number; quote?: string } = {}): Evidence {
  const page = options.page ?? result.pageStart;
  const flat = (options.quote ?? result.text).replace(/\s+/g, " ").trim();
  const quote = flat.length <= 240 ? flat : `${flat.slice(0, 239).trimEnd()}…`;
  return { evidenceId: `DOC:${result.documentId}:p${page}:c${result.chunkId}`, documentId: result.documentId, page, quote };
}

// ---------------------------------------------------------------------------
// Documents + pages

export interface DocumentInfo {
  documentId: string;
  caseId: string;
  tenderId: string | null;
  poNumber: string | null;
  docType: string;
  title: string;
  version: number;
  supersedesDocumentId: string | null;
  pageCount: number;
  extractionStatus: string;
  ocrStatus: string;
  synthetic: boolean;
}

interface DocRow {
  document_id: string;
  case_id: string;
  tender_id: string | null;
  po_number: string | null;
  doc_type: string;
  title: string;
  version: number;
  supersedes_document_id: string | null;
  page_count: number;
  extraction_status: string;
  ocr_status: string;
  synthetic: number;
}

const toInfo = (r: DocRow): DocumentInfo => ({
  documentId: r.document_id,
  caseId: r.case_id,
  tenderId: r.tender_id,
  poNumber: r.po_number,
  docType: r.doc_type,
  title: r.title,
  version: Number(r.version),
  supersedesDocumentId: r.supersedes_document_id,
  pageCount: Number(r.page_count),
  extractionStatus: r.extraction_status,
  ocrStatus: r.ocr_status,
  synthetic: Number(r.synthetic) === 1,
});

/** Returns null when the document does not exist OR is not permitted (indistinguishable on purpose). */
export function getDocument(index: DocumentIndex, documentId: string, options: { allowedCaseIds?: string[] | null } = {}): DocumentInfo | null {
  const filter = buildFilter({ allowedCaseIds: options.allowedCaseIds });
  const row = prepared(index.db, `SELECT d.* FROM documents d WHERE d.document_id = ?${filter.sql}`).get(documentId, ...filter.params) as DocRow | undefined;
  return row ? toInfo(row) : null;
}

export interface DocumentPages {
  document: DocumentInfo;
  pages: Array<{ pageNo: number; text: string; hasTextLayer: boolean }>;
}

export function getDocumentPages(index: DocumentIndex, documentId: string, options: { allowedCaseIds?: string[] | null } = {}): DocumentPages | null {
  const document = getDocument(index, documentId, options);
  if (!document) return null;
  const pages = prepared(index.db, "SELECT page_no, text, has_text_layer FROM pages WHERE document_id = ? ORDER BY page_no").all(documentId) as Array<{ page_no: number; text: string; has_text_layer: number }>;
  return { document, pages: pages.map((p) => ({ pageNo: Number(p.page_no), text: p.text, hasTextLayer: Number(p.has_text_layer) === 1 })) };
}

/** Full text with `[page N]` markers; null when missing or not permitted. */
export function getDocumentText(index: DocumentIndex, documentId: string, options: { allowedCaseIds?: string[] | null } = {}): string | null {
  const doc = getDocumentPages(index, documentId, options);
  return doc ? doc.pages.map((p) => `[page ${p.pageNo}]\n${p.text}`).join("\n\n") : null;
}

/** Tender documents (BID versions + corrigenda) of the same tender as `documentId`/`tenderId`, oldest first. */
export function listTenderVersions(index: DocumentIndex, params: { documentId?: string; tenderId?: string; allowedCaseIds?: string[] | null }): DocumentInfo[] {
  let tenderId = params.tenderId;
  if (!tenderId && params.documentId) tenderId = getDocument(index, params.documentId, params)?.tenderId ?? undefined;
  if (!tenderId) return [];
  const filter = buildFilter({ allowedCaseIds: params.allowedCaseIds, tenderId, docTypes: ["BID", "COR"] });
  const rows = prepared(index.db, `SELECT d.* FROM documents d WHERE 1=1${filter.sql} ORDER BY d.doc_type, d.version, d.document_id`).all(...filter.params) as unknown as DocRow[];
  return rows.map(toInfo);
}

// ---------------------------------------------------------------------------
// Clause lookup

interface ClauseTopic {
  /** Terms that identify the clause itself. */
  primary: string[];
  /** Extra recall terms. */
  related: string[];
}

export const CLAUSE_TOPICS: Record<string, ClauseTopic> = {
  "liquidated damages": { primary: ["liquidated damages", "ld"], related: ["delay", "penalty", "per week", "capped"] },
  emd: { primary: ["emd", "earnest money", "earnest money deposit", "bid security"], related: ["exempt", "refund"] },
  warranty: { primary: ["warranty"], related: ["guarantee", "defect liability", "months from acceptance"] },
  "payment terms": { primary: ["payment terms", "payment"], related: ["within days", "acceptance certificate", "invoice"] },
  eligibility: { primary: ["eligibility", "eligibility criteria"], related: ["turnover", "experience", "mandatory", "registration", "integrity"] },
  "performance security": { primary: ["performance security", "epbg", "pbg"], related: ["bank guarantee"] },
  delivery: { primary: ["delivery", "delivery period"], related: ["consignee", "contract period"] },
  sla: { primary: ["sla", "service level agreement"], related: ["breach", "penalised"] },
  inspection: { primary: ["inspection"], related: ["consignee receipt", "acceptance"] },
  "bid deadline": { primary: ["bid end date", "bid end date/time", "bid submission"], related: ["deadline", "extended", "opening date"] },
};

const TOPIC_ALIASES: Record<string, string> = {
  ld: "liquidated damages",
  "liquidated damage": "liquidated damages",
  "earnest money deposit": "emd",
  "earnest money": "emd",
  guarantee: "warranty",
  payment: "payment terms",
  eligible: "eligibility",
  "eligibility criteria": "eligibility",
  epbg: "performance security",
  pbg: "performance security",
  deadline: "bid deadline",
  "bid end date": "bid deadline",
  "service level agreement": "sla",
};

export interface ClauseMatch extends SearchResult {
  /** Exact table rows (with their own page numbers) or paragraphs that mention the topic. */
  hits: Array<{ page: number; text: string }>;
  evidence: Evidence;
}

export interface ClauseResult {
  topic: string;
  matches: ClauseMatch[];
  /** Distinct pages on which the clause text was found, ascending. */
  pages: number[];
}

function topicTerms(topic: string): { key: string; primary: string[]; related: string[] } {
  const norm = topic.toLowerCase().replace(/\s+/g, " ").trim();
  const key = CLAUSE_TOPICS[norm] ? norm : TOPIC_ALIASES[norm] && CLAUSE_TOPICS[TOPIC_ALIASES[norm]] ? TOPIC_ALIASES[norm] : "";
  if (key) return { key, ...CLAUSE_TOPICS[key] };
  return { key: norm, primary: [norm], related: [] };
}

function parseTableRows(tableJson: string | null): Array<{ page: number; text: string; section: string }> {
  if (!tableJson) return [];
  try {
    const parsed = JSON.parse(tableJson) as { rows?: Array<{ page: number; section?: string; cells: string[] }> };
    return (parsed.rows ?? []).map((r) => ({ page: r.page, text: r.cells.join(" | "), section: r.section ?? "" }));
  } catch {
    return [];
  }
}

const hasTerm = (text: string, terms: string[]) => {
  const lower = text.toLowerCase();
  return terms.some((t) => (t.length <= 3 ? new RegExp(`\\b${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(lower) : lower.includes(t)));
};

/** Best chunks (with exact row/paragraph pages) for a clause topic inside one document or one tender. */
export function findClause(
  index: DocumentIndex,
  params: { documentId?: string; tenderId?: string; topic: string; allowedCaseIds?: string[] | null; limit?: number },
): ClauseResult {
  const { primary, related } = topicTerms(params.topic);
  const empty: ClauseResult = { topic: params.topic, matches: [], pages: [] };
  if (!params.documentId && !params.tenderId) return empty;
  const limit = Math.min(Math.max(params.limit ?? 5, 1), 25);
  const results = searchChunks(index, {
    query: [...primary, ...related].join(" "),
    documentId: params.documentId,
    tenderId: params.tenderId,
    allowedCaseIds: params.allowedCaseIds,
    limit: 50,
  });

  const matches: ClauseMatch[] = [];
  for (const r of results) {
    const hits: Array<{ page: number; text: string }> = [];
    const stored = prepared(index.db, "SELECT table_json FROM chunks WHERE chunk_id = ?").get(r.chunkId) as { table_json: string | null } | undefined;
    const rowList = parseTableRows(stored?.table_json ?? null);
    if (rowList.length) hits.push(...rowList.filter((row) => hasTerm(row.text, primary) || hasTerm(row.section, primary)).map(({ page, text }) => ({ page, text })));
    else if (hasTerm(r.text, primary)) hits.push({ page: r.pageStart, text: r.text });
    const headingHit = !rowList.length && hasTerm(r.heading, primary);
    if (!hits.length && !headingHit) continue;
    const first = hits[0];
    matches.push({ ...r, hits, evidence: buildEvidence(r, first ? { page: first.page, quote: first.text } : {}), score: r.score + (hits.length ? 1 : 0) + (headingHit ? 0.5 : 0) });
  }
  matches.sort((a, b) => b.score - a.score || a.chunkId - b.chunkId);
  const top = matches.slice(0, limit);
  const pages = [...new Set(top.flatMap((m) => (m.hits.length ? m.hits.map((h) => h.page) : [m.pageStart])))].sort((a, b) => a - b);
  return { topic: params.topic, matches: top, pages };
}

// ---------------------------------------------------------------------------
// Version comparison

export interface DiffSide {
  text: string;
  page: number;
  section: string;
}

export interface FieldChange {
  name: string;
  before: string;
  after: string;
}

export interface DocumentChange {
  type: "added" | "removed" | "changed" | "corrigendum_note";
  section: string;
  label: string;
  before: DiffSide | null;
  after: DiffSide | null;
  fields: FieldChange[];
}

export interface VersionComparison {
  ok: true;
  relation: "supersedes" | "corrigendum" | "same_case";
  documentA: DocumentInfo;
  documentB: DocumentInfo;
  changes: DocumentChange[];
  counts: { added: number; removed: number; changed: number; notes: number };
  summary: string;
}

export interface VersionComparisonError {
  ok: false;
  /** not_found covers both missing and not-permitted documents. */
  error: "not_found" | "different_cases";
  message: string;
}

interface Unit {
  section: string;
  key: string;
  text: string;
  page: number;
  kind: "row" | "para";
  cells: string[];
  header: string[] | null;
  docKind: "kv" | "grid" | "text";
}

const IGNORED_SECTIONS = new Set(["document control", "document information"]);
const GENERATED_LINE = /generated synthetic|synthetic demonstration data|not an official|^page \d+ \/ \d+$|^created \d{2}-\d{2}-\d{4}/i;

const squash = (s: string) => s.replace(/\s+/g, " ").trim();

function loadUnits(index: DocumentIndex, documentId: string): Unit[] {
  const units: Unit[] = [];
  const rows = prepared(index.db, "SELECT page, section, kind, header_json, cells_json, text FROM table_rows WHERE document_id = ? ORDER BY row_no").all(documentId) as Array<{
    page: number; section: string; kind: "kv" | "grid"; header_json: string | null; cells_json: string; text: string;
  }>;
  for (const r of rows) {
    const section = squash(r.section ?? "");
    if (IGNORED_SECTIONS.has(section.toLowerCase())) continue;
    const text = squash(r.text);
    if (GENERATED_LINE.test(text)) continue;
    const cells = (JSON.parse(r.cells_json) as string[]).map(squash);
    units.push({ section, key: cells[0] ?? "", text, page: Number(r.page), kind: "row", cells, header: r.header_json ? (JSON.parse(r.header_json) as string[]) : null, docKind: r.kind });
  }
  const pages = prepared(index.db, "SELECT page_no, text FROM pages WHERE document_id = ? ORDER BY page_no").all(documentId) as Array<{ page_no: number; text: string }>;
  const paras = prepared(index.db, "SELECT page_start, page_end, heading, text FROM chunks WHERE document_id = ? AND chunk_type = 'text' ORDER BY chunk_no").all(documentId) as Array<{
    page_start: number; page_end: number; heading: string; text: string;
  }>;
  for (const c of paras) {
    const section = squash((c.heading ?? "").split(" > ").pop() ?? "");
    if (IGNORED_SECTIONS.has(section.toLowerCase())) continue;
    for (const raw of c.text.split("\n")) {
      const text = squash(raw);
      if (!text || GENERATED_LINE.test(text)) continue;
      // Resolve the page from the page text so multi-page chunks never get an invented page.
      const page = pages.find((p) => p.page_no >= c.page_start && p.page_no <= c.page_end && p.text.includes(text.slice(0, 60)))?.page_no ?? c.page_start;
      units.push({ section, key: "", text, page: Number(page), kind: "para", cells: [text], header: null, docKind: "text" });
    }
  }
  return units;
}

const tokens = (s: string) => new Set(s.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);
function jaccard(a: string, b: string): number {
  const ta = tokens(a);
  const tb = tokens(b);
  if (!ta.size || !tb.size) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  return inter / (ta.size + tb.size - inter);
}

const side = (u: Unit): DiffSide => ({ text: u.text, page: u.page, section: u.section });

function fieldChanges(a: Unit, b: Unit): FieldChange[] {
  if (a.kind === "para" || b.kind === "para") return [];
  if (a.docKind === "kv" && b.docKind === "kv") return a.cells[1] !== b.cells[1] ? [{ name: a.cells[0], before: a.cells[1] ?? "", after: b.cells[1] ?? "" }] : [];
  const out: FieldChange[] = [];
  const n = Math.max(a.cells.length, b.cells.length);
  for (let i = 0; i < n; i++) {
    if ((a.cells[i] ?? "") !== (b.cells[i] ?? "")) out.push({ name: a.header?.[i] ?? b.header?.[i] ?? `column ${i + 1}`, before: a.cells[i] ?? "", after: b.cells[i] ?? "" });
  }
  return out;
}

function diffUnits(a: Unit[], b: Unit[]): DocumentChange[] {
  const usedA = new Set<number>();
  const usedB = new Set<number>();
  // 1) identical lines in the same section cancel out
  const byText = new Map<string, number[]>();
  b.forEach((u, i) => {
    const k = `${u.section}\u0000${u.text}`;
    byText.set(k, [...(byText.get(k) ?? []), i]);
  });
  a.forEach((u, i) => {
    const queue = byText.get(`${u.section}\u0000${u.text}`);
    const j = queue?.shift();
    if (j !== undefined) (usedA.add(i), usedB.add(j));
  });
  const changes: Array<{ order: number; change: DocumentChange }> = [];
  const pair = (i: number, j: number) => {
    usedA.add(i);
    usedB.add(j);
    const ua = a[i];
    const ub = b[j];
    changes.push({
      order: j,
      change: { type: "changed", section: ub.section || ua.section, label: ub.key || ua.key || ub.section, before: side(ua), after: side(ub), fields: fieldChanges(ua, ub) },
    });
  };
  // 2) same section + same row key
  a.forEach((ua, i) => {
    if (usedA.has(i) || ua.kind !== "row") return;
    const j = b.findIndex((ub, jj) => !usedB.has(jj) && ub.kind === "row" && ub.section === ua.section && ub.key === ua.key);
    if (j >= 0) pair(i, j);
  });
  // 3) best textual similarity inside the same section
  a.forEach((ua, i) => {
    if (usedA.has(i)) return;
    let best = -1;
    let bestScore = 0;
    b.forEach((ub, j) => {
      if (usedB.has(j) || ub.section !== ua.section || ub.kind !== ua.kind) return;
      const s = jaccard(ua.text, ub.text);
      if (s > bestScore) (bestScore = s, (best = j));
    });
    if (best >= 0 && bestScore >= (ua.kind === "para" ? 0.5 : 0.6)) pair(i, best);
  });
  a.forEach((ua, i) => {
    if (!usedA.has(i)) changes.push({ order: Number.MAX_SAFE_INTEGER - a.length + i, change: { type: "removed", section: ua.section, label: ua.key || ua.section, before: side(ua), after: null, fields: [] } });
  });
  b.forEach((ub, j) => {
    if (!usedB.has(j)) changes.push({ order: j, change: { type: "added", section: ub.section, label: ub.key || ub.section, before: null, after: side(ub), fields: [] } });
  });
  return changes.sort((x, y) => x.order - y.order).map((c) => c.change);
}

/** Corrigendum vs base tender: "Revised X" rows are matched to base row X, everything else is reported as a note with its COR page. */
function diffCorrigendum(base: Unit[], cor: Unit[], baseIsA: boolean): DocumentChange[] {
  const out: DocumentChange[] = [];
  const baseKey = (s: string) => squash(s).toLowerCase();
  for (const u of cor) {
    const revised = u.kind === "row" && u.docKind === "kv" ? u.key.match(/^revised\s+(.+)$/i) : null;
    if (revised) {
      const target = base.find((b) => b.kind === "row" && b.docKind === "kv" && baseKey(b.key) === baseKey(revised[1]));
      if (target) {
        const before = baseIsA ? target : u;
        const after = baseIsA ? u : target;
        if (before.cells[1] === after.cells[1]) continue; // "Revised X" repeats the current value: nothing changed
        out.push({
          type: "changed",
          section: target.section,
          label: target.key,
          before: side(before),
          after: side(after),
          fields: [{ name: target.key, before: before.cells[1] ?? "", after: after.cells[1] ?? "" }],
        });
        continue;
      }
    }
    if (base.some((b) => b.text === u.text)) continue; // identity fields repeated from the base (Bid Number, Case ID)
    out.push({ type: "corrigendum_note", section: u.section, label: u.key || u.section, before: null, after: side(u), fields: [] });
  }
  return out;
}

function summarise(a: DocumentInfo, b: DocumentInfo, relation: string, changes: DocumentChange[]): string {
  const describe = (d: DocumentInfo) => `${d.documentId} (${d.docType} v${d.version})`;
  const lines = [`Comparison of ${describe(a)} -> ${describe(b)} [${relation}]: ${changes.length} difference(s).`];
  for (const c of changes) {
    const p = (s: DiffSide | null) => (s ? `p${s.page}` : "");
    if (c.type === "changed") {
      const detail = c.fields.length ? c.fields.map((f) => `${f.name}: "${f.before}" -> "${f.after}"`).join("; ") : `"${c.before?.text}" -> "${c.after?.text}"`;
      lines.push(`- CHANGED [${c.section}] ${detail} (${a.documentId} ${p(c.before)} / ${b.documentId} ${p(c.after)})`);
    } else if (c.type === "added") lines.push(`- ADDED [${c.section}] "${c.after?.text}" (${b.documentId} ${p(c.after)})`);
    else if (c.type === "removed") lines.push(`- REMOVED [${c.section}] "${c.before?.text}" (${a.documentId} ${p(c.before)})`);
    else lines.push(`- CORRIGENDUM [${c.section}] "${c.after?.text}" (${b.documentId} ${p(c.after)})`);
  }
  return lines.join("\n");
}

/**
 * Row/line-level diff of two documents of the same case (tender version n vs n+1, or a tender vs its
 * corrigendum). Headers, footers, generation lines and the Document Control block are ignored.
 * Page numbers come from the stored rows only; a side without a counterpart carries null.
 */
export function compareDocumentVersions(
  index: DocumentIndex,
  params: { documentIdA: string; documentIdB: string; allowedCaseIds?: string[] | null },
): VersionComparison | VersionComparisonError {
  const a = getDocument(index, params.documentIdA, params);
  const b = getDocument(index, params.documentIdB, params);
  if (!a || !b) return { ok: false, error: "not_found", message: "One or both documents were not found or are not accessible." };
  if (a.caseId !== b.caseId) return { ok: false, error: "different_cases", message: "Documents belong to different procurement cases and cannot be compared as versions." };

  const unitsA = loadUnits(index, a.documentId);
  const unitsB = loadUnits(index, b.documentId);
  let relation: VersionComparison["relation"] = "same_case";
  let changes: DocumentChange[];
  if (a.docType === "COR" || b.docType === "COR") {
    relation = "corrigendum";
    const baseIsA = b.docType === "COR";
    changes = baseIsA ? diffCorrigendum(unitsA, unitsB, true) : diffCorrigendum(unitsB, unitsA, false);
  } else {
    if (a.supersedesDocumentId === b.documentId || b.supersedesDocumentId === a.documentId) relation = "supersedes";
    changes = diffUnits(unitsA, unitsB);
  }
  const counts = {
    added: changes.filter((c) => c.type === "added").length,
    removed: changes.filter((c) => c.type === "removed").length,
    changed: changes.filter((c) => c.type === "changed").length,
    notes: changes.filter((c) => c.type === "corrigendum_note").length,
  };
  return { ok: true, relation, documentA: a, documentB: b, changes, counts, summary: summarise(a, b, relation, changes) };
}
