/**
 * Shared types and component interfaces for the document ingestion + retrieval
 * pipeline. Every stage sits behind an interface so it can be replaced
 * (e.g. a tesseract OcrEngine, another PDF extractor, a different embedder).
 */

export const EXTRACTOR_VERSION = "docpipe-1.0.0";

/** One row of data/document_metadata.csv (the manifest). */
export interface ManifestRow {
  document_id: string;
  case_id: string;
  doc_type: string;
  stage_name: string;
  title: string;
  version: number;
  created_date: string;
  supersedes_document_id: string;
  tender_id: string;
  po_number: string;
  relative_path: string;
  page_count: number;
  file_size_bytes: number;
  sha256: string;
}

// ---------------------------------------------------------------------------
// Validation

export interface FileValidation {
  ok: boolean;
  /** Machine-readable reason when !ok: missing_file | too_small | too_large | not_pdf | size_mismatch | sha256_mismatch | unreadable */
  reason?: string;
  message?: string;
  bytes?: Uint8Array;
  sha256?: string;
  size?: number;
}

// ---------------------------------------------------------------------------
// Positioned text

/** A PDF.js text run with page coordinates (origin bottom-left, points). */
export interface TextItem {
  text: string;
  x: number;
  y: number;
  width: number;
  /** Font size in points (0 for pure spacer runs). */
  size: number;
}

export interface RawPage {
  pageNo: number;
  width: number;
  height: number;
  items: TextItem[];
}

export interface PageExtractor {
  readonly name: string;
  extractPages(bytes: Uint8Array): Promise<RawPage[]>;
}

// ---------------------------------------------------------------------------
// Layout

export interface Cell {
  x0: number;
  x1: number;
  y: number;
  size: number;
  text: string;
}

export interface Line {
  pageNo: number;
  y: number;
  size: number;
  cells: Cell[];
  text: string;
}

export interface Amount {
  raw: string;
  value: number;
  unit: "INR" | "percent" | "months" | "days" | "weeks" | "years" | "nos" | "other";
  currency?: "INR";
}

/** A table row emitted as a structured record. */
export interface TableRowRecord {
  /** 'kv' = two-column label/value block, 'grid' = table with a header row. */
  kind: "kv" | "grid";
  /** Page on which the row starts (rows never span pages). */
  page: number;
  tableNo: number;
  section: string;
  rowNo: number;
  header: string[] | null;
  cells: string[];
  /** header[i] -> cells[i] for grid rows; { label: value } for kv rows. */
  record: Record<string, string>;
  /** ' | ' joined text line. */
  text: string;
  amounts: Amount[];
  /** True when the table continued from a previous page (repeated header skipped). */
  continued: boolean;
}

export type BlockType = "text" | "table";

export interface TextBlock {
  type: "text";
  page: number;
  section: string;
  text: string;
}

export interface TableBlock {
  type: "table";
  page: number;
  section: string;
  rows: TableRowRecord[];
}

export type Block = TextBlock | TableBlock;

export interface PageText {
  pageNo: number;
  /** Reading-order body text (headers, footers and watermark removed). */
  text: string;
  hasTextLayer: boolean;
  /** 'text_layer' or the OcrEngine name. */
  source: string;
  headerLines: string[];
  footerLines: string[];
}

export interface LayoutResult {
  pages: PageText[];
  blocks: Block[];
  title: string | null;
}

export interface LayoutAnalyzer {
  readonly name: string;
  analyze(rawPages: RawPage[]): LayoutResult;
}

// ---------------------------------------------------------------------------
// Classification + metadata

export interface Classification {
  docType: string;
  detectedDocType: string | null;
  titleOnPage: string | null;
  titleMatchesManifest: boolean;
  typeMatchesManifest: boolean;
  warnings: string[];
}

export interface DocumentMetadata {
  documentNumber: string | null;
  caseIds: string[];
  tenderIds: string[];
  poNumbers: string[];
  version: number | null;
  documentDate: string | null;
  dates: string[];
  department: string | null;
  organisation: string | null;
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Chunks

export interface ChunkDraft {
  chunkNo: number;
  pageStart: number;
  pageEnd: number;
  chunkType: BlockType;
  heading: string;
  text: string;
  tableJson: string | null;
}

export interface Chunker {
  readonly name: string;
  chunk(blocks: Block[], opts?: { title?: string | null }): ChunkDraft[];
}

// ---------------------------------------------------------------------------
// OCR

export type OcrStatus = "ocr_not_configured" | "ok" | "failed";

export interface OcrPageRequest {
  documentId: string;
  pageNo: number;
  /** Original PDF bytes so an engine can rasterise the page itself. */
  pdfBytes: Uint8Array;
}

export interface OcrPageResult {
  status: OcrStatus;
  text: string;
  confidence?: number;
  error?: string;
}

export interface OcrEngine {
  readonly name: string;
  recognizePage(request: OcrPageRequest): Promise<OcrPageResult>;
}

/** Default engine: reports honestly that no OCR is available. */
export class NoOcrEngine implements OcrEngine {
  readonly name = "none";
  async recognizePage(): Promise<OcrPageResult> {
    return { status: "ocr_not_configured", text: "" };
  }
}

// ---------------------------------------------------------------------------
// Embeddings

export interface EmbeddingProvider {
  model: string;
  embed(texts: string[]): Promise<number[][]>;
}

// ---------------------------------------------------------------------------
// Pipeline output

export type ExtractionStatus = "ok" | "needs_ocr" | "failed";
export type DocOcrStatus = "not_needed" | "ocr_not_configured" | "ocr_done" | "ocr_failed";

export interface ProcessedDocument {
  manifest: ManifestRow;
  sha256: string;
  extractionStatus: ExtractionStatus;
  ocrStatus: DocOcrStatus;
  pages: PageText[];
  chunks: ChunkDraft[];
  tableRows: TableRowRecord[];
  classification: Classification | null;
  metadata: DocumentMetadata | null;
  textChars: number;
  warnings: string[];
  /** Set when extractionStatus === 'failed' */
  error?: string;
}
