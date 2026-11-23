import { SectionChunker } from "./chunker";
import { classifyDocument, extractMetadata } from "./classify";
import { GeometryLayoutAnalyzer } from "./layout";
import { PdfJsPageExtractor } from "./pdf-extract";
import { isUpToDate, openDocumentIndex, prepared, writeDocument, type DocumentIndex } from "./store";
import { validateFile } from "./validate";
import {
  EXTRACTOR_VERSION,
  NoOcrEngine,
  type Block,
  type Chunker,
  type DocOcrStatus,
  type ExtractionStatus,
  type LayoutAnalyzer,
  type ManifestRow,
  type OcrEngine,
  type PageExtractor,
  type ProcessedDocument,
  type TableRowRecord,
} from "./types";

export interface PipelineComponents {
  extractor: PageExtractor;
  layout: LayoutAnalyzer;
  chunker: Chunker;
  ocr: OcrEngine;
  /** Directory against which manifest relative_path resolves. */
  documentsRoot?: string;
}

export function defaultComponents(overrides: Partial<PipelineComponents> = {}): PipelineComponents {
  return { extractor: new PdfJsPageExtractor(), layout: new GeometryLayoutAnalyzer(), chunker: new SectionChunker(), ocr: new NoOcrEngine(), ...overrides };
}

function failed(manifest: ManifestRow, reason: string, message: string, sha256 = ""): ProcessedDocument {
  return {
    manifest,
    sha256,
    extractionStatus: "failed",
    ocrStatus: "not_needed",
    pages: [],
    chunks: [],
    tableRows: [],
    classification: null,
    metadata: null,
    textChars: 0,
    warnings: [`${reason}: ${message}`],
    error: `${reason}: ${message}`,
  };
}

/** validation -> extraction -> layout/tables -> (OCR) -> classification -> metadata -> chunking. Pure: no DB access. */
export async function processDocument(manifest: ManifestRow, components: PipelineComponents = defaultComponents()): Promise<ProcessedDocument> {
  const validation = await validateFile(manifest, components.documentsRoot);
  if (!validation.ok || !validation.bytes || !validation.sha256) return failed(manifest, validation.reason ?? "invalid", validation.message ?? "", validation.sha256);

  let rawPages;
  try {
    rawPages = await components.extractor.extractPages(validation.bytes);
  } catch (error) {
    return failed(manifest, "extract_error", error instanceof Error ? error.message : String(error), validation.sha256);
  }
  if (!rawPages.length) return failed(manifest, "no_pages", "PDF has no pages", validation.sha256);

  const warnings: string[] = [];
  let layout;
  try {
    layout = components.layout.analyze(rawPages);
  } catch (error) {
    return failed(manifest, "layout_error", error instanceof Error ? error.message : String(error), validation.sha256);
  }
  if (manifest.page_count && manifest.page_count !== rawPages.length) warnings.push(`page count ${rawPages.length} differs from manifest ${manifest.page_count}`);

  // Pages without a text layer go to the OCR engine; the default engine reports ocr_not_configured.
  const blocks: Block[] = [...layout.blocks];
  const noText = layout.pages.filter((p) => !p.hasTextLayer);
  let ocrStatus: DocOcrStatus = "not_needed";
  let extractionStatus: ExtractionStatus = "ok";
  if (noText.length) {
    let okCount = 0;
    let unconfigured = 0;
    for (const page of noText) {
      const result = await components.ocr.recognizePage({ documentId: manifest.document_id, pageNo: page.pageNo, pdfBytes: validation.bytes });
      if (result.status === "ok" && result.text.trim()) {
        okCount++;
        page.text = result.text.trim();
        page.source = components.ocr.name;
        blocks.push({ type: "text", page: page.pageNo, section: "OCR text", text: page.text });
      } else if (result.status === "ocr_not_configured") unconfigured++;
    }
    if (okCount === noText.length) ocrStatus = "ocr_done";
    else {
      extractionStatus = "needs_ocr";
      ocrStatus = unconfigured ? "ocr_not_configured" : "ocr_failed";
      warnings.push(`pages without text layer: ${noText.filter((p) => p.source === "text_layer").map((p) => p.pageNo).join(",")}`);
    }
  }

  // Stable sort keeps reading order; only needed when OCR text blocks were appended.
  if (noText.length) blocks.sort((a, b) => a.page - b.page);
  const classification = classifyDocument(manifest, layout);
  const metadata = extractMetadata(manifest, layout);
  warnings.push(...classification.warnings, ...metadata.warnings);

  const chunks = components.chunker.chunk(blocks, { title: layout.title });
  const tableRows: TableRowRecord[] = blocks.flatMap((b) => (b.type === "table" ? b.rows : []));
  const textChars = layout.pages.reduce((n, p) => n + p.text.length, 0);

  return {
    manifest,
    sha256: validation.sha256,
    extractionStatus,
    ocrStatus,
    pages: layout.pages,
    chunks,
    tableRows,
    classification,
    metadata,
    textChars,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Corpus ingestion

export interface IngestOptions {
  dbPath?: string;
  limit?: number;
  force?: boolean;
  concurrency?: number;
  components?: PipelineComponents;
  /** Only ingest these document ids (still in manifest order). */
  only?: Set<string>;
  onProgress?: (state: IngestProgress) => void;
}

export interface IngestProgress {
  done: number;
  total: number;
  ingested: number;
  skipped: number;
  failed: number;
  elapsedSeconds: number;
}

export interface IngestSummary {
  runId: number;
  candidates: number;
  ingested: number;
  skipped: number;
  failed: number;
  needsOcr: number;
  pages: number;
  chunks: number;
  tableRows: number;
  seconds: number;
  docsPerSecond: number;
  failures: Array<{ documentId: string; reason: string }>;
  failureReasons: Record<string, number>;
}

/**
 * Idempotent, resumable ingestion. Documents are processed with bounded
 * concurrency but committed in manifest order, so chunk ids are deterministic
 * for a given manifest order. Documents whose sha256 + extractor version are
 * already stored (and did not fail) are skipped unless `force` is set.
 */
export async function ingestDocuments(manifest: ManifestRow[], options: IngestOptions = {}): Promise<IngestSummary & { index: DocumentIndex }> {
  const index = openDocumentIndex(options.dbPath);
  const components = options.components ?? defaultComponents();
  const concurrency = Math.max(1, options.concurrency ?? 8);
  let rows = options.only ? manifest.filter((r) => options.only!.has(r.document_id)) : manifest;
  if (options.limit !== undefined && options.limit >= 0) rows = rows.slice(0, options.limit);

  const startedAt = new Date();
  const t0 = performance.now();
  const runId = Number(
    prepared(index.db, "INSERT INTO ingest_runs (started_at, extractor_version, options_json, candidates, status) VALUES (?,?,?,?, 'running')").run(
      startedAt.toISOString(),
      EXTRACTOR_VERSION,
      JSON.stringify({ limit: options.limit ?? null, force: !!options.force, concurrency }),
      rows.length,
    ).lastInsertRowid,
  );

  const summary: IngestSummary = {
    runId,
    candidates: rows.length,
    ingested: 0,
    skipped: 0,
    failed: 0,
    needsOcr: 0,
    pages: 0,
    chunks: 0,
    tableRows: 0,
    seconds: 0,
    docsPerSecond: 0,
    failures: [],
    failureReasons: {},
  };

  const todo = rows.filter((r) => options.force || !isUpToDate(index, r));
  summary.skipped = rows.length - todo.length;

  // Ordered commit: workers pull the next index; results are written strictly in order.
  const results = new Map<number, ProcessedDocument>();
  let nextToStart = 0;
  let nextToWrite = 0;
  let done = summary.skipped;
  let waiters: Array<() => void> = [];
  const waitForSignal = () => new Promise<void>((resolve) => waiters.push(resolve));
  const signal = () => {
    const current = waiters;
    waiters = [];
    for (const resolve of current) resolve();
  };
  const MAX_BUFFER = concurrency * 4;

  const worker = async () => {
    for (;;) {
      while (nextToStart - nextToWrite >= MAX_BUFFER) await waitForSignal();
      const i = nextToStart++;
      if (i >= todo.length) return;
      let doc: ProcessedDocument;
      try {
        doc = await processDocument(todo[i], components);
      } catch (error) {
        doc = failed(todo[i], "unexpected_error", error instanceof Error ? error.message : String(error));
      }
      results.set(i, doc);
      signal();
    }
  };

  const writer = (async () => {
    while (nextToWrite < todo.length) {
      const doc = results.get(nextToWrite);
      if (!doc) {
        await waitForSignal();
        continue;
      }
      results.delete(nextToWrite);
      nextToWrite++;
      writeDocument(index, doc);
      done++;
      if (doc.extractionStatus === "failed") {
        summary.failed++;
        const reason = (doc.error ?? "unknown").split(":")[0];
        summary.failureReasons[reason] = (summary.failureReasons[reason] ?? 0) + 1;
        summary.failures.push({ documentId: doc.manifest.document_id, reason: doc.error ?? "unknown" });
      } else {
        summary.ingested++;
        if (doc.extractionStatus === "needs_ocr") summary.needsOcr++;
        summary.pages += doc.pages.length;
        summary.chunks += doc.chunks.length;
        summary.tableRows += doc.tableRows.length;
      }
      signal();
      options.onProgress?.({ done, total: rows.length, ingested: summary.ingested, skipped: summary.skipped, failed: summary.failed, elapsedSeconds: (performance.now() - t0) / 1000 });
    }
  })();

  await Promise.all([...Array.from({ length: Math.min(concurrency, todo.length) }, worker), writer]);

  summary.seconds = (performance.now() - t0) / 1000;
  summary.docsPerSecond = summary.seconds > 0 ? (summary.ingested + summary.failed) / summary.seconds : 0;
  prepared(
    index.db,
    `UPDATE ingest_runs SET finished_at=?, ingested=?, skipped=?, failed=?, needs_ocr=?, pages=?, chunks=?, table_rows=?, seconds=?, docs_per_second=?, status=?, failures_json=? WHERE run_id=?`,
  ).run(
    new Date().toISOString(),
    summary.ingested,
    summary.skipped,
    summary.failed,
    summary.needsOcr,
    summary.pages,
    summary.chunks,
    summary.tableRows,
    summary.seconds,
    summary.docsPerSecond,
    summary.failed ? "completed_with_failures" : "completed",
    JSON.stringify(summary.failures.slice(0, 200)),
    runId,
  );
  return { ...summary, index };
}
