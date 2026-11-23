/**
 * Ingests the synthetic procurement PDFs into the document index.
 *
 *   npm run ingest:docs -- --limit 200
 *   npm run ingest:docs                      # full corpus
 *   npm run ingest:docs -- --force           # re-ingest everything
 *   OPENAI_API_KEY=... OPENAI_EMBEDDING_MODEL=... npm run ingest:docs -- --embed
 *
 * Env: PROCUREMENT_DOCS_DB (default .data/documents.db), PROCUREMENT_DATA_DIR,
 * PROCUREMENT_DOCUMENTS_DIR, OPENAI_API_KEY, OPENAI_EMBEDDING_MODEL,
 * OPENAI_TIMEOUT (ms), OPENAI_MAX_RETRIES.
 */
import { embedPendingChunks, OpenAiEmbeddingProvider, openAiConfigFromEnv } from "../src/modules/procurement/server/documents/embeddings";
import { loadManifest } from "../src/modules/procurement/server/documents/manifest";
import { ingestDocuments } from "../src/modules/procurement/server/documents/pipeline";

interface Args {
  limit?: number;
  force: boolean;
  embed: boolean;
  embedOnly: boolean;
  concurrency: number;
  db?: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { force: false, embed: false, embedOnly: false, concurrency: 8 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === "--limit") args.limit = Number(value());
    else if (a === "--force") args.force = true;
    else if (a === "--embed") args.embed = true;
    else if (a === "--embed-only") args.embed = args.embedOnly = true;
    else if (a === "--concurrency") args.concurrency = Number(value());
    else if (a === "--db") args.db = value();
    else throw new Error(`Unknown argument: ${a}`);
  }
  if (args.limit !== undefined && (!Number.isInteger(args.limit) || args.limit < 0)) throw new Error("--limit must be a non-negative integer");
  if (!Number.isInteger(args.concurrency) || args.concurrency < 1) throw new Error("--concurrency must be a positive integer");
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.embed) {
    const { missing } = openAiConfigFromEnv();
    if (missing.length) {
      console.error(`Refusing to embed: ${missing.join(" and ")} must be set. No embeddings are generated without them (there is no default model or fake provider).`);
      process.exit(2);
    }
  }

  const manifest = loadManifest();
  let index;
  if (!args.embedOnly) {
    console.log(`Manifest: ${manifest.length} documents. Concurrency ${args.concurrency}${args.limit !== undefined ? `, limit ${args.limit}` : ""}${args.force ? ", force" : ""}`);
    let lastPrint = 0;
    const summary = await ingestDocuments(manifest, {
      dbPath: args.db,
      limit: args.limit,
      force: args.force,
      concurrency: args.concurrency,
      onProgress: (p) => {
        if (p.elapsedSeconds - lastPrint >= 10 || p.done === p.total) {
          lastPrint = p.elapsedSeconds;
          console.log(`  ${p.done}/${p.total} done (ingested ${p.ingested}, skipped ${p.skipped}, failed ${p.failed}) ${p.elapsedSeconds.toFixed(0)}s`);
        }
      },
    });
    index = summary.index;
    console.log("\nIngest summary");
    console.log(`  database        ${index.path}`);
    console.log(`  candidates      ${summary.candidates}`);
    console.log(`  ingested        ${summary.ingested}`);
    console.log(`  skipped         ${summary.skipped} (already ingested with same sha256 + extractor)`);
    console.log(`  failed          ${summary.failed}${summary.failed ? ` ${JSON.stringify(summary.failureReasons)}` : ""}`);
    console.log(`  needs_ocr       ${summary.needsOcr}`);
    console.log(`  pages           ${summary.pages}`);
    console.log(`  chunks          ${summary.chunks}`);
    console.log(`  table rows      ${summary.tableRows}`);
    console.log(`  seconds         ${summary.seconds.toFixed(1)}`);
    console.log(`  docs/second     ${summary.docsPerSecond.toFixed(1)}`);
    for (const f of summary.failures.slice(0, 20)) console.log(`  FAILED ${f.documentId}: ${f.reason}`);
    if (summary.failed) process.exitCode = 1;
  } else {
    const { openDocumentIndex } = await import("../src/modules/procurement/server/documents/store");
    index = openDocumentIndex(args.db);
  }

  if (args.embed) {
    const provider = OpenAiEmbeddingProvider.fromEnv();
    console.log(`\nEmbedding pending chunks with model ${provider.model} (batches of 96, resumable)`);
    const result = await embedPendingChunks(index, provider, { onProgress: (p) => process.stdout.write(`\r  embedded ${p.embedded}, remaining ${p.remaining}   `) });
    console.log(`\n  embedded ${result.embedded} chunks in ${result.batches} requests; ${result.remaining} remaining`);
  } else {
    console.log("\nEmbeddings: skipped (pass --embed with OPENAI_API_KEY and OPENAI_EMBEDDING_MODEL set). Keyword (FTS5/BM25) retrieval is fully available.");
  }
  index.close();
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
