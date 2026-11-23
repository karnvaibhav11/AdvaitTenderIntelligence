/**
 * OpenAI configuration, read only from the server environment. Nothing here is
 * ever sent to the browser and the key is never logged.
 */
export interface AiConfig {
  apiKey: string | null;
  /** Chat/reasoning model. No default: it must be chosen and verified by the operator. */
  model: string | null;
  embeddingModel: string | null;
  baseURL: string | null;
  organization: string | null;
  timeoutMs: number;
  maxRetries: number;
  maxOutputTokens: number;
  maxToolRounds: number;
  /** Required for stateless multi-step use of reasoning models. */
  includeEncryptedReasoning: boolean;
  priceInputPer1M: number | null;
  priceOutputPer1M: number | null;
}

function intEnv(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return value && Number.isFinite(n) && n > 0 ? Math.trunc(n) : fallback;
}

function numEnv(value: string | undefined): number | null {
  const n = Number(value);
  return value && Number.isFinite(n) && n >= 0 ? n : null;
}

export function readAiConfig(env: Record<string, string | undefined> = process.env): AiConfig {
  return {
    apiKey: env.OPENAI_API_KEY?.trim() || null,
    model: env.OPENAI_MODEL?.trim() || null,
    embeddingModel: env.OPENAI_EMBEDDING_MODEL?.trim() || null,
    baseURL: env.OPENAI_BASE_URL?.trim() || null,
    organization: env.OPENAI_ORGANIZATION?.trim() || null,
    timeoutMs: intEnv(env.OPENAI_TIMEOUT, 60_000),
    maxRetries: env.OPENAI_MAX_RETRIES !== undefined && Number.isFinite(Number(env.OPENAI_MAX_RETRIES)) ? Math.max(0, Math.trunc(Number(env.OPENAI_MAX_RETRIES))) : 2,
    maxOutputTokens: intEnv(env.OPENAI_MAX_OUTPUT_TOKENS, 3000),
    maxToolRounds: intEnv(env.TATTVA_MAX_TOOL_ROUNDS, 8),
    includeEncryptedReasoning: env.OPENAI_INCLUDE_ENCRYPTED_REASONING === "true",
    priceInputPer1M: numEnv(env.OPENAI_PRICE_INPUT_PER_1M),
    priceOutputPer1M: numEnv(env.OPENAI_PRICE_OUTPUT_PER_1M),
  };
}

export class LlmServiceError extends Error {
  constructor(
    readonly code: "llm_not_configured" | "llm_auth" | "llm_rate_limited" | "llm_timeout" | "llm_unavailable" | "llm_bad_request" | "llm_incomplete",
    message: string,
    readonly status = 503,
  ) {
    super(message);
  }
}

/** Names of the variables that are required but missing (never their values). */
export function missingAiConfig(config: AiConfig): string[] {
  const missing: string[] = [];
  if (!config.apiKey) missing.push("OPENAI_API_KEY");
  if (!config.model) missing.push("OPENAI_MODEL");
  return missing;
}

export function assertAiConfigured(config: AiConfig): void {
  const missing = missingAiConfig(config);
  if (missing.length) {
    throw new LlmServiceError(
      "llm_not_configured",
      `TattvaAI is not configured: set ${missing.join(" and ")} on the server. No fallback answers are produced.`,
    );
  }
}
