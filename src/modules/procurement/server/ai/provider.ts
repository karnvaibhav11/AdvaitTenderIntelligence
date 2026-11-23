import OpenAI from "openai";
import { type AiConfig, LlmServiceError, assertAiConfigured, readAiConfig } from "./config";

/**
 * Model provider abstraction. Procurement logic talks to `LlmProvider`; only
 * `OpenAIResponsesProvider` knows about the OpenAI SDK, so the model, endpoint
 * or vendor can change without touching tools, prompts or the agent loop.
 */
export interface LlmToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface LlmRequest {
  instructions: string;
  input: unknown[];
  tools: LlmToolSpec[];
  maxOutputTokens: number;
  /** Opaque, non-identifying value passed through for provider-side abuse monitoring. */
  safetyIdentifier?: string;
  signal?: AbortSignal;
}

export interface LlmFunctionCall {
  callId: string;
  name: string;
  arguments: string;
}

export interface LlmResponse {
  id: string;
  model: string;
  text: string;
  functionCalls: LlmFunctionCall[];
  /** Output items to replay as input in the next round (stateless operation). */
  outputItems: unknown[];
  usage: { inputTokens: number; outputTokens: number };
  incomplete: string | null;
}

export interface LlmProvider {
  readonly name: string;
  readonly model: string;
  respond(request: LlmRequest, hooks?: { onTextDelta?: (delta: string) => void }): Promise<LlmResponse>;
}

interface ResponsesLikeEvent {
  type: string;
  delta?: string;
  response?: ResponsesLikeResponse;
  message?: string;
  code?: string;
}

interface ResponsesLikeResponse {
  id: string;
  model: string;
  status?: string;
  incomplete_details?: { reason?: string } | null;
  error?: { message?: string; code?: string } | null;
  output?: Array<Record<string, unknown>>;
  usage?: { input_tokens?: number; output_tokens?: number } | null;
}

function mapError(error: unknown): LlmServiceError {
  if (error instanceof LlmServiceError) return error;
  if (error instanceof OpenAI.APIConnectionTimeoutError) return new LlmServiceError("llm_timeout", "The AI service did not respond in time.");
  if (error instanceof OpenAI.APIError) {
    if (error.status === 401 || error.status === 403) return new LlmServiceError("llm_auth", "The AI service rejected the configured credentials.", 502);
    if (error.status === 429) return new LlmServiceError("llm_rate_limited", "The AI service is rate limiting requests. Try again shortly.", 429);
    if (error.status === 400 || error.status === 404) return new LlmServiceError("llm_bad_request", "The AI service rejected the request; check OPENAI_MODEL and the request configuration.", 502);
    return new LlmServiceError("llm_unavailable", "The AI service is temporarily unavailable.");
  }
  return new LlmServiceError("llm_unavailable", "The AI service could not be reached.");
}

export class OpenAIResponsesProvider implements LlmProvider {
  readonly name = "openai";
  private client: OpenAI | null = null;

  constructor(private readonly config: AiConfig = readAiConfig()) {
    assertAiConfigured(config);
  }

  get model(): string {
    return this.config.model!;
  }

  private sdk(): OpenAI {
    this.client ??= new OpenAI({
      apiKey: this.config.apiKey!,
      timeout: this.config.timeoutMs,
      maxRetries: this.config.maxRetries,
      ...(this.config.baseURL ? { baseURL: this.config.baseURL } : {}),
      ...(this.config.organization ? { organization: this.config.organization } : {}),
    });
    return this.client;
  }

  async respond(request: LlmRequest, hooks?: { onTextDelta?: (delta: string) => void }): Promise<LlmResponse> {
    try {
      const stream = await this.sdk().responses.create(
        {
          model: this.config.model!,
          instructions: request.instructions,
          input: request.input as never,
          tools: request.tools.map((tool) => ({ type: "function" as const, name: tool.name, description: tool.description, parameters: tool.parameters, strict: false })),
          max_output_tokens: request.maxOutputTokens,
          store: false,
          stream: true,
          parallel_tool_calls: true,
          ...(this.config.includeEncryptedReasoning ? { include: ["reasoning.encrypted_content" as const] } : {}),
          ...(request.safetyIdentifier ? { safety_identifier: request.safetyIdentifier } : {}),
        },
        { signal: request.signal },
      );
      let final: ResponsesLikeResponse | null = null;
      for await (const event of stream as AsyncIterable<ResponsesLikeEvent>) {
        if (event.type === "response.output_text.delta" && event.delta) hooks?.onTextDelta?.(event.delta);
        else if (event.type === "response.completed" || event.type === "response.incomplete") final = event.response ?? null;
        else if (event.type === "response.failed") throw new LlmServiceError("llm_unavailable", event.response?.error?.message ? "The AI service reported a failure." : "The AI service reported a failure.");
        else if (event.type === "error") throw new LlmServiceError("llm_unavailable", "The AI service reported an error.");
      }
      if (!final) throw new LlmServiceError("llm_unavailable", "The AI service ended the stream without a result.");
      const output = final.output ?? [];
      const functionCalls: LlmFunctionCall[] = output
        .filter((item) => item.type === "function_call")
        .map((item) => ({ callId: String(item.call_id), name: String(item.name), arguments: String(item.arguments ?? "{}") }));
      const text = output
        .filter((item) => item.type === "message")
        .flatMap((item) => (item.content as Array<{ type: string; text?: string }>) ?? [])
        .filter((part) => part.type === "output_text")
        .map((part) => part.text ?? "")
        .join("");
      return {
        id: final.id,
        model: final.model,
        text,
        functionCalls,
        outputItems: output,
        usage: { inputTokens: final.usage?.input_tokens ?? 0, outputTokens: final.usage?.output_tokens ?? 0 },
        incomplete: final.status === "incomplete" ? (final.incomplete_details?.reason ?? "incomplete") : null,
      };
    } catch (error) {
      throw mapError(error);
    }
  }

  /** Verifies the key can reach the API and that the configured model exists. */
  async healthCheck(): Promise<{ ok: boolean; model: string; detail: string }> {
    try {
      await this.sdk().models.retrieve(this.config.model!);
      return { ok: true, model: this.config.model!, detail: "Configured model is available." };
    } catch (error) {
      const mapped = mapError(error);
      return { ok: false, model: this.config.model!, detail: mapped.message };
    }
  }
}

const globalProvider = globalThis as unknown as { __advaitLlm?: LlmProvider; __advaitLlmOverride?: LlmProvider };

/** Returns the configured provider or throws a controlled `llm_not_configured` error. */
export function getLlmProvider(): LlmProvider {
  if (globalProvider.__advaitLlmOverride) return globalProvider.__advaitLlmOverride;
  globalProvider.__advaitLlm ??= new OpenAIResponsesProvider();
  return globalProvider.__advaitLlm;
}

/** Test seam: install a provider double for automated tests only. */
export function setLlmProviderForTests(provider: LlmProvider | undefined): void {
  globalProvider.__advaitLlmOverride = provider;
}
