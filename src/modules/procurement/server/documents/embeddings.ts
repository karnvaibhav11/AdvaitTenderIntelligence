import { prepared, type DocumentIndex } from "./store";
import type { EmbeddingProvider } from "./types";

export const EMBED_BATCH_SIZE = 96;

export interface OpenAiEmbeddingConfig {
  apiKey: string;
  model: string;
  /** Request timeout in ms (OPENAI_TIMEOUT). */
  timeout?: number;
  /** SDK retry count (OPENAI_MAX_RETRIES). */
  maxRetries?: number;
}

function intEnv(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer, got "${raw}"`);
  return value;
}

/** Reads OPENAI_API_KEY, OPENAI_EMBEDDING_MODEL, OPENAI_TIMEOUT, OPENAI_MAX_RETRIES. No model default exists on purpose. */
export function openAiConfigFromEnv(): { config?: OpenAiEmbeddingConfig; missing: string[] } {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  const model = process.env.OPENAI_EMBEDDING_MODEL?.trim();
  const missing = [!apiKey && "OPENAI_API_KEY", !model && "OPENAI_EMBEDDING_MODEL"].filter(Boolean) as string[];
  if (missing.length) return { missing };
  return { config: { apiKey: apiKey!, model: model!, timeout: intEnv("OPENAI_TIMEOUT"), maxRetries: intEnv("OPENAI_MAX_RETRIES") }, missing: [] };
}

/** Embeddings through the official OpenAI SDK. Retries/backoff are handled by the SDK (maxRetries). */
export class OpenAiEmbeddingProvider implements EmbeddingProvider {
  readonly model: string;
  private clientPromise: Promise<{ embeddings: { create(args: { model: string; input: string[]; encoding_format: "float" }): Promise<{ data: Array<{ index: number; embedding: number[] }> }> } }> | null = null;

  constructor(private readonly config: OpenAiEmbeddingConfig) {
    this.model = config.model;
  }

  static fromEnv(): OpenAiEmbeddingProvider {
    const { config, missing } = openAiConfigFromEnv();
    if (!config) throw new Error(`Embeddings not configured: set ${missing.join(" and ")}`);
    return new OpenAiEmbeddingProvider(config);
  }

  private client() {
    this.clientPromise ??= import("openai").then(({ default: OpenAI }) => {
      const options: { apiKey: string; timeout?: number; maxRetries?: number } = { apiKey: this.config.apiKey };
      if (this.config.timeout !== undefined) options.timeout = this.config.timeout;
      if (this.config.maxRetries !== undefined) options.maxRetries = this.config.maxRetries;
      return new OpenAI(options) as never;
    });
    return this.clientPromise;
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (!texts.length) return [];
    const client = await this.client();
    const response = await client.embeddings.create({ model: this.model, input: texts, encoding_format: "float" });
    const ordered = [...response.data].sort((a, b) => a.index - b.index).map((d) => d.embedding);
    if (ordered.length !== texts.length) throw new Error(`embedding count ${ordered.length} != input count ${texts.length}`);
    return ordered;
  }
}

/**
 * Deterministic bag-of-hashed-tokens embedder for TESTS ONLY. It has no semantic
 * knowledge; it exists so the vector storage/search/permission paths can be
 * exercised without an API key. Never wire this into a production code path.
 */
export class HashingEmbeddingProvider implements EmbeddingProvider {
  readonly model: string;
  constructor(readonly dim = 256) {
    this.model = `test-hashing-${dim}`;
  }
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((text) => {
      const v = new Array<number>(this.dim).fill(0);
      for (const token of text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) {
        let h = 2166136261;
        for (let i = 0; i < token.length; i++) h = Math.imul(h ^ token.charCodeAt(i), 16777619) >>> 0;
        v[h % this.dim] += 1;
      }
      return v;
    });
  }
}

export function normalizeVector(vector: ArrayLike<number>): Float32Array {
  const out = new Float32Array(vector.length);
  let norm = 0;
  for (let i = 0; i < vector.length; i++) {
    if (!Number.isFinite(vector[i])) throw new Error("embedding contains a non-finite value");
    norm += vector[i] * vector[i];
  }
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < vector.length; i++) out[i] = vector[i] / norm;
  return out;
}

export function vectorToBlob(vector: Float32Array): Uint8Array {
  return new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength);
}

export function blobToVector(blob: Uint8Array): Float32Array {
  // Copy: SQLite blobs are not guaranteed 4-byte aligned.
  const copy = new Uint8Array(blob.byteLength);
  copy.set(blob);
  return new Float32Array(copy.buffer);
}

export interface EmbedProgress {
  embedded: number;
  remaining: number;
}

export interface EmbedResult {
  model: string;
  embedded: number;
  batches: number;
  remaining: number;
}

/** Text embedded for a chunk: heading path + content. */
export function embeddingInput(chunk: { heading: string | null; text: string }): string {
  return `${chunk.heading ?? ""}\n${chunk.text}`.trim().slice(0, 6000);
}

/**
 * Resumable: only chunks without a vector for `provider.model` are embedded,
 * each batch is committed as soon as it returns, so an interrupted run
 * continues where it stopped.
 */
export async function embedPendingChunks(
  index: DocumentIndex,
  provider: EmbeddingProvider,
  options: { batchSize?: number; limit?: number; onProgress?: (p: EmbedProgress) => void } = {},
): Promise<EmbedResult> {
  const batchSize = Math.max(1, options.batchSize ?? EMBED_BATCH_SIZE);
  const { db } = index;
  const pendingSql = "SELECT c.chunk_id, c.heading, c.text FROM chunks c WHERE NOT EXISTS (SELECT 1 FROM chunk_embeddings e WHERE e.chunk_id = c.chunk_id AND e.model = ?) ORDER BY c.chunk_id LIMIT ?";
  const total = Number((prepared(db, "SELECT COUNT(*) AS n FROM chunks c WHERE NOT EXISTS (SELECT 1 FROM chunk_embeddings e WHERE e.chunk_id = c.chunk_id AND e.model = ?)").get(provider.model) as { n: number }).n);
  let budget = options.limit ?? Number.POSITIVE_INFINITY;
  let embedded = 0;
  let batches = 0;
  while (budget > 0) {
    const batch = prepared(db, pendingSql).all(provider.model, Math.min(batchSize, budget)) as Array<{ chunk_id: number; heading: string | null; text: string }>;
    if (!batch.length) break;
    const vectors = await provider.embed(batch.map(embeddingInput));
    if (vectors.length !== batch.length) throw new Error(`provider returned ${vectors.length} vectors for ${batch.length} inputs`);
    db.exec("BEGIN IMMEDIATE");
    try {
      const insert = prepared(db, "INSERT OR REPLACE INTO chunk_embeddings (chunk_id, model, dim, vector) VALUES (?,?,?,?)");
      batch.forEach((chunk, i) => {
        const v = normalizeVector(vectors[i]);
        insert.run(chunk.chunk_id, provider.model, v.length, vectorToBlob(v));
      });
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    embedded += batch.length;
    budget -= batch.length;
    batches++;
    options.onProgress?.({ embedded, remaining: total - embedded });
  }
  return { model: provider.model, embedded, batches, remaining: Math.max(0, total - embedded) };
}
