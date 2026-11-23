# Procurement document ingestion + hybrid retrieval

Real ingestion of the 13,185 synthetic procurement PDFs (`ADVAITSI_GEM_SYNTHETIC_PROCUREMENT`) into a
searchable SQLite index, with keyword (FTS5/BM25) and optional vector retrieval, document-level
permissions, clause lookup, version comparison and citation objects.

> Everything is synthetic demo data. Retrieved text is **untrusted**: results carry a `suspicious` flag
> (prompt-injection heuristic) and callers must treat chunk text as data, never as instructions.

## Pipeline

```
manifest row (data/document_metadata.csv)
  -> validate.ts      exists, size, %PDF header, size + sha256 vs manifest (path cannot escape the corpus root)
  -> pdf-extract.ts   PdfJsPageExtractor: unpdf/PDF.js getTextContent items with x/y/width/size per page
  -> layout.ts        GeometryLayoutAnalyzer: lines by y-clustering, cells by x gaps, header/footer/watermark
                      removal, title + section headings by font size, key/value blocks and grid tables
                      (columns from the header row, wrapped cells, rows around first-column anchors,
                      repeated headers on continuation pages dropped, ₹/%/Nos/Months/Days amounts parsed)
  -> OcrEngine        pages with no text layer -> NoOcrEngine => 'ocr_not_configured' (document becomes 'needs_ocr')
  -> classify.ts      manifest doc_type verified against the 'Document type' row / id and the page title;
                      metadata (document number, version, date, department, organisation, case/tender/PO ids) by regex
  -> chunker.ts       SectionChunker: ~500-900 char chunks, text vs table never mixed, header line repeated
                      in table chunks, page_start/page_end, heading path "Title > Section | Section"
  -> store.ts         documents / pages / chunks / table_rows / chunks_fts (FTS5, porter + unicode61)
  -> embeddings.ts    optional: OpenAI embeddings (batches of 96) stored as float32
  -> retrieval.ts     searchChunks, findClause, compareDocumentVersions, buildEvidence, ...
```

Every stage is an interface in `types.ts` (`PageExtractor`, `LayoutAnalyzer`, `Chunker`, `OcrEngine`,
`EmbeddingProvider`) and `defaultComponents({...})` lets a caller swap one in. Extraction itself never reads
`document_extracted_fields.csv` (it is only used as a test oracle in `scripts/verify-documents.ts`).

Layout thresholds live in `LAYOUT` (layout.ts); they are tuned for the fpdf2-generated A4 documents of the
synthetic corpus (title >= 12 pt, headings 9.5-12 pt, label/value column at x ~= 201 pt).

## Storage

Default `.data/documents.db` (override with `PROCUREMENT_DOCS_DB`; the directory is created; add `.data/` to
`.gitignore`). WAL mode.

| table | content |
| --- | --- |
| `documents` | `document_id` PK, `case_id`, `tender_id`, `po_number`, `doc_type`, `title`, `version`, `supersedes_document_id`, `relative_path`, `page_count`, `sha256`, `ocr_status`, `extraction_status`, `extracted_at`, `text_chars`, `synthetic` (default 1) + `extractor_version`, `detected_doc_type`, `title_verified`, `doc_date`, `department`, `organisation`, `chunk_count`, `table_row_count`, `warnings` (JSON), `error` |
| `pages` | `document_id`, `page_no`, `text` (reading order, headers/footers removed), `has_text_layer` |
| `chunks` | `chunk_id` PK, `document_id`, `page_start`, `page_end`, `chunk_no`, `chunk_type` (`text`/`table`), `heading`, `text`, `table_json` (header + rows with page, cells, record, amounts) |
| `table_rows` | one structured record per table row: page, section, kind (`kv`/`grid`), header, cells, record, `' | '` text, amounts, `continued` |
| `chunks_fts` | FTS5 external-content index over `chunks(text, heading)`, kept in sync by triggers |
| `chunk_embeddings` | `chunk_id`, `model`, `dim`, `vector` (L2-normalised float32 BLOB) |
| `ingest_runs` | one row per run: counts, seconds, docs/second, failures |

`extraction_status`: `ok` / `needs_ocr` / `failed`. `ocr_status`: `not_needed` / `ocr_not_configured` / `ocr_done` / `ocr_failed`.
Authorisation uses the manifest `case_id` stored in `documents` (trusted), not ids found inside the PDF text.

## Running

```bash
npm run ingest:docs -- --limit 200      # first 200 manifest rows
npm run ingest:docs                     # full corpus (idempotent + resumable)
npm run ingest:docs -- --force          # re-ingest everything
npm run ingest:docs -- --concurrency 4 --db path/to/other.db

# embeddings (needs a key and an explicit model; refuses to run otherwise)
OPENAI_API_KEY=... OPENAI_EMBEDDING_MODEL=<model> npm run ingest:docs -- --embed
OPENAI_API_KEY=... OPENAI_EMBEDDING_MODEL=<model> npm run ingest:docs -- --embed-only   # skip PDF ingestion

npm run verify:docs                     # tests (sample ingest into .data/verify, plus read-only checks of the full index)
```

* Skipping: a document is skipped when the stored `sha256` equals the manifest, the `extractor_version`
  matches and it did not fail. Failed documents are retried on every run. Bump `EXTRACTOR_VERSION`
  (types.ts) after changing extraction behaviour.
* Concurrency (default 8, `--concurrency`): PDFs are parsed concurrently but committed strictly in manifest
  order, so chunk ids are identical regardless of concurrency.
* Embeddings env: `OPENAI_API_KEY`, `OPENAI_EMBEDDING_MODEL` (no default), `OPENAI_TIMEOUT` (ms),
  `OPENAI_MAX_RETRIES` (SDK retries). Only chunks without a vector for that model are embedded, each batch of
  96 is committed immediately, so an interrupted run resumes.

## Retrieval API

Everything is exported from `documents/index.ts`; all functions are synchronous, take the handle from
`openDocumentIndex(path?, { readOnly? })` and never mutate it.

```ts
openDocumentIndex(dbPath?: string, options?: { readOnly?: boolean }): DocumentIndex
searchChunks(index, { query, allowedCaseIds?: string[] | null, caseId?, tenderId?, poNumber?, documentId?,
                      docTypes?: string[], limit?: number, queryEmbedding?: number[] | null,
                      embeddingModel?: string }): SearchResult[]
getDocumentPages(index, documentId, { allowedCaseIds? }): { document, pages: [{ pageNo, text, hasTextLayer }] } | null
getDocumentText(index, documentId, { allowedCaseIds? }): string | null            // "[page N]" markers
findClause(index, { documentId? | tenderId?, topic, allowedCaseIds?, limit? }): { topic, matches, pages }
compareDocumentVersions(index, { documentIdA, documentIdB, allowedCaseIds? }): VersionComparison | { ok: false, error }
buildEvidence(result, { page?, quote? }?): { evidenceId: `DOC:${documentId}:p${page}:c${chunkId}`, documentId, page, quote /* <= 240 */ }
containsInstructionLikeText(text): boolean
```

* **Permissions.** `allowedCaseIds`: `null`/`undefined` = unrestricted, `[]` = nothing. The list is bound as one
  JSON parameter and applied in the `WHERE` of the FTS, vector and document queries, so disallowed chunks are never
  ranked, counted or returned. Missing and forbidden documents are indistinguishable (`null` / `not_found`).
  `docTypes: []` means "no doc-type filter" (not "nothing").
* **Hybrid ranking.** FTS5 `bm25` (heading weighted 2.5x) over a sanitised query: only letter/digit tokens survive and
  each is double-quoted, so `AND`, `OR`, `NEAR(`, `*`, `"`, `;--`, column filters etc. are literals and cannot raise
  FTS syntax errors; terms are OR-ed plus one exact-phrase term for 2-8 word queries. With `queryEmbedding`, cosine
  similarity is computed in JS over the stored vectors of permitted chunks (streamed, top-100 kept) and fused with
  reciprocal rank fusion (k = 60). `score` is the RRF score, `keywordScore` = -bm25, `vectorScore` = cosine,
  `matchedBy` lists the contributing rankers. A query embedding whose dimension matches no stored vectors contributes
  nothing; several stored models of the same dimension require `embeddingModel`.
* **Clause lookup.** `findClause` expands topics (`liquidated damages`, `emd`, `warranty`, `payment terms`,
  `eligibility`, `performance security`, `delivery`, `sla`, `inspection`, `bid deadline`; aliases like `LD`, `EMD`
  work; unknown topics use the topic text) and returns chunks plus the exact rows/paragraphs and **their own page
  numbers** (`hits`) and an evidence object per match.
* **Version comparison.** Row/line-level diff on the stored table rows and text paragraphs, whitespace-normalised,
  ignoring the Document Control block, headers/footers and generation lines. Identical lines cancel, the rest is
  paired by section + row key (then by token similarity) into `changed` (with per-field before/after), `added` or
  `removed`; each side carries `{ text, page, section }` or `null` (no invented pages). When one document is a
  corrigendum (`COR`), `Revised X` rows are matched to the base row `X` (a `changed` entry when the value really
  differs) and the remaining corrigendum statements are listed as `corrigendum_note` with their page. Documents of
  different cases are rejected. A plain-text `summary` is returned.
* **Untrusted text.** `containsInstructionLikeText` flags patterns such as "ignore previous instructions",
  "system prompt", "you are now", "disregard", "reveal ... prompt/secret/key", "api key"; flagged chunks are kept and
  returned with `suspicious: true`.

## Measured results (this machine, 6 cores, Node 24, full corpus)

| | |
| --- | --- |
| documents / pages | 13,185 / 18,155 (all page counts equal the manifest) |
| chunks | 48,345 (16,260 text, 32,085 table; <= 900 chars each, table median 575) |
| table rows | 381,236 (308,434 key/value, 72,802 grid; 7,557 rows on continuation pages) |
| failures / needs_ocr | 0 / 0 |
| ingest time | 129.5 s = 101.8 documents/s (concurrency 8); a resumed run skips all 13,185 in 0.3 s |
| index size | ~290 MB |

Extraction accuracy (`npm run verify:docs`):

* **Oracle**: `document_extracted_fields.csv` label/value pairs (page-1 "Key Particulars", never used by the
  extractor) vs recovered key/value rows: 100-pair stratified sample 100 %, the 1,706 pairs of the 155 sampled documents
  100 %, **all 150,669 pairs of the corpus 100 %** (value and page). The oracle only covers key/value blocks.
* **Independent cross-checks** on the sample: PO `Total Contract Value` equals `purchase_orders.csv.total_value`; BID
  "Line Items" rows equal `tender_line_items.csv` (description, qty, UoM); 99.89 % of ASCII tokens of the PDF text layer
  are present in the extracted page text with no extra tokens (the remainder are the intentionally dropped repeated
  table headers).

## Limitations (honest list)

* **No OCR.** `NoOcrEngine` only reports `ocr_not_configured`; scanned/image-only pages become `needs_ocr`.
  Every PDF in the synthetic corpus has a text layer, so the path is exercised only with a generated blank PDF and a
  stub engine. A real engine plugs in through `OcrEngine` (`defaultComponents({ ocr })`).
* **No embeddings were generated.** There is no API key here, so `OpenAiEmbeddingProvider` has never called the real
  API; the vector path (storage, cosine search, RRF, permissions, resumable batching) is tested only with
  `HashingEmbeddingProvider`, a hashing bag-of-words test double with no semantics that is not used by any production path.
  Cosine search scans all permitted vectors in JS (fine for tens of thousands of chunks, not millions).
* **Table detection is heuristic geometry**, tuned to this generator's layout: text-run positions only (no ruling lines
  or colours), key/value vs grid decided from a trailing colon / the value-column x position, columns from the header
  row, rows anchored on first-column cells (a row with an empty first column would merge into its neighbour), right/centred
  alignment handled via cell extents. Real-world scanned or multi-column tenders need a different `LayoutAnalyzer`.
* **Hindi** headings/titles are kept in `pages.text` but excluded from chunks: PDF.js text for the shaped Devanagari font
  is partly garbled (stray glyph characters remain after control characters are stripped), so it is not indexed.
* Chunks never mix text and table rows and sections are short, so text chunks are small (median ~130 chars) while table
  chunks average 500-800; a single table row longer than 900 characters would still be one oversized chunk.
* Search is OR-ranked BM25 (porter stemming), so near-identical boilerplate across thousands of documents ties and is
  ordered by chunk id; use `caseId` / `tenderId` / `documentId` filters for precision. No cross-lingual retrieval without embeddings.
* Skipping relies on the manifest sha256 stored at ingestion time; files changed on disk after ingestion are detected
  on the next `--force` run (or when the manifest hash changes), not on every skipped run.
* The injection heuristic is a regex list: it reduces risk, it does not prove text safe.
* `ingest:docs` reads PDFs from the corpus directory resolved from `PROCUREMENT_DATA_DIR` /
  `PROCUREMENT_DOCUMENTS_DIR` (default `../ADVAITSI_GEM_SYNTHETIC_PROCUREMENT`) and only reads from it.
