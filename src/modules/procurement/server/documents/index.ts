/**
 * Document ingestion + hybrid retrieval for the procurement PDF corpus.
 * See README.md for the pipeline, schema and limitations.
 */
export * from "./types";
export { loadManifest, stratifiedSample, resolveCorpusRoot, resolveDataDir, resolveDocumentsRoot, readCsv } from "./manifest";
export { validateFile, documentPath, MAX_PDF_BYTES } from "./validate";
export { PdfJsPageExtractor, cleanText } from "./pdf-extract";
export { GeometryLayoutAnalyzer, LAYOUT, extractAmounts } from "./layout";
export { classifyDocument, extractMetadata } from "./classify";
export { SectionChunker, CHUNK_MAX, CHUNK_TARGET_MIN } from "./chunker";
export { defaultComponents, processDocument, ingestDocuments } from "./pipeline";
export type { PipelineComponents, IngestOptions, IngestProgress, IngestSummary } from "./pipeline";
export { openDocumentIndex, resolveDbPath, DEFAULT_DB_PATH, isUpToDate, writeDocument } from "./store";
export type { DocumentIndex } from "./store";
export {
  OpenAiEmbeddingProvider,
  HashingEmbeddingProvider,
  openAiConfigFromEnv,
  embedPendingChunks,
  embeddingInput,
  EMBED_BATCH_SIZE,
} from "./embeddings";
export {
  searchChunks,
  buildFtsQuery,
  buildEvidence,
  containsInstructionLikeText,
  getDocument,
  getDocumentPages,
  getDocumentText,
  listTenderVersions,
  findClause,
  compareDocumentVersions,
  CLAUSE_TOPICS,
} from "./retrieval";
export type {
  SearchParams,
  SearchResult,
  Evidence,
  DocumentInfo,
  DocumentPages,
  ClauseResult,
  ClauseMatch,
  VersionComparison,
  VersionComparisonError,
  DocumentChange,
  DiffSide,
  FieldChange,
} from "./retrieval";
