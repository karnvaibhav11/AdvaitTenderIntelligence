import { randomUUID } from "node:crypto";
import type { AiAnswer, AiArtifact, AiCitation, AiEvent, AiToolTrace, RecordRow } from "../../shared/types";
import { getStore } from "../db";
import { recordAudit } from "../platform/audit-log";
import { runWithContext } from "../platform/context";
import { type Principal } from "../platform/rbac";
import { type AiConfig, LlmServiceError, readAiConfig } from "./config";
import { type StoredMessage, appendMessage, createConversation, getConversation, getMessages, recordUsage } from "./conversations";
import { EvidenceLedger, type StoredResult, forModel } from "./ledger";
import { buildInstructions } from "./prompt";
import { type LlmProvider } from "./provider";
import { SqlRejected } from "./sql-guard";
import { type ToolDefinition, toolsFor } from "./tools";

/**
 * The agent loop. One user question becomes: model reasoning -> tool calls
 * (each authorised, scoped, audited) -> more reasoning -> a final answer whose
 * citations and tables are checked against what tools actually returned.
 */

export interface AgentRequest {
  question: string;
  principal: Principal;
  provider: LlmProvider;
  tools: ToolDefinition[];
  conversationId?: string;
  selectedCaseId?: string | null;
  requestId?: string;
  signal?: AbortSignal;
  config?: AiConfig;
}

const MAX_HISTORY_MESSAGES = 12;
const MAX_TOOL_OUTPUT_CHARS = 28_000;

function cleanForHistory(text: string): string {
  return text
    .replace(/\[\[table:[^\]]+\]\]/g, "")
    .replace(/\[E\d+\]/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .slice(0, 3500)
    .trim();
}

function buildMemo(results: StoredResult[]): string | null {
  if (!results.length) return null;
  return results
    .map((r) => {
      const ids = new Set<string>();
      for (const section of r.sections) {
        for (const row of section.rows.slice(0, 25)) {
          for (const key of ["case_id", "tender_id", "contract_number", "po_number", "vendor_id", "invoice_id"]) {
            if (typeof row[key] === "string") ids.add(row[key] as string);
          }
        }
      }
      return `- ${r.tool}(${JSON.stringify(r.args).slice(0, 240)}) → ${r.summary} ${ids.size ? `Ids: ${[...ids].slice(0, 20).join(", ")}` : ""}`.trim();
    })
    .join("\n")
    .slice(0, 2500);
}

function historyItems(messages: StoredMessage[]): unknown[] {
  return messages.slice(-MAX_HISTORY_MESSAGES).map((m) => ({ role: m.role, content: m.role === "assistant" ? cleanForHistory(m.content) : m.content }));
}

function previousMemo(messages: StoredMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === "assistant" && m.payload && typeof (m.payload as unknown as { memo?: string }).memo === "string") return (m.payload as unknown as { memo: string }).memo;
  }
  return null;
}

function serialiseForModel(result: StoredResult): string {
  for (const limit of [40, 20, 10, 5]) {
    const text = JSON.stringify(forModel(result, limit));
    if (text.length <= MAX_TOOL_OUTPUT_CHARS || limit === 5) return text.length > MAX_TOOL_OUTPUT_CHARS ? `${text.slice(0, MAX_TOOL_OUTPUT_CHARS)}…[truncated]` : text;
  }
  return "{}";
}

// ───────────────────────────── Answer checking ─────────────────────────────

const NUMBER_TOKEN = /(?:₹\s?)?(\d[\d,]*(?:\.\d+)?)\s*(crore|cr\b|lakh|lakhs|%|days?)?/gi;

function numbersIn(text: string): number[] {
  const out: number[] = [];
  for (const match of text.matchAll(/-?\d[\d,]*(?:\.\d+)?/g)) {
    const n = Number(match[0].replaceAll(",", ""));
    if (Number.isFinite(n)) out.push(n);
  }
  return out;
}

export function findUngroundedFigures(answer: string, corpus: string): string[] {
  const known = numbersIn(corpus);
  const knownSet = new Set(known.map((n) => Math.round(n * 100) / 100));
  const cleaned = answer.replace(/ADV-[A-Z0-9-]+/g, " ").replace(/\[E\d+\]|\[\[table:[^\]]+\]\]/g, " ").replace(/\b(19|20)\d{2}(?:-\d{2})?\b/g, " ");
  const flagged: string[] = [];
  for (const match of cleaned.matchAll(NUMBER_TOKEN)) {
    const raw = Number(match[1].replaceAll(",", ""));
    if (!Number.isFinite(raw)) continue;
    const unit = (match[2] ?? "").toLowerCase();
    const value = unit.startsWith("cr") ? raw * 1e7 : unit.startsWith("lakh") ? raw * 1e5 : raw;
    if (!unit && raw < 10) continue;
    const tolerance = unit.startsWith("cr") || unit.startsWith("lakh") ? 0.006 : 0.0105;
    const present = knownSet.has(Math.round(value * 100) / 100) || known.some((k) => Math.abs(k - value) <= Math.max(Math.abs(value) * tolerance, 0.51));
    if (!present) flagged.push(match[0].trim());
  }
  return [...new Set(flagged)].slice(0, 6);
}

interface Finalised {
  text: string;
  artifacts: AiArtifact[];
  citations: AiCitation[];
  warnings: string[];
}

export function finaliseAnswer(rawText: string, ledger: EvidenceLedger, corpus: string): Finalised {
  const warnings: string[] = [];
  const cited = new Set<string>();
  let text = rawText.replace(/\[(E\d+(?:\s*[,;]\s*E\d+)*)\]/g, (_m, list: string) => {
    const ids = list.split(/[,;]\s*/).map((id) => id.trim());
    const valid = ids.filter((id) => ledger.get(id));
    const invalid = ids.filter((id) => !ledger.get(id));
    if (invalid.length) warnings.push(`Removed unsupported citation(s): ${invalid.join(", ")}`);
    valid.forEach((id) => cited.add(id));
    return valid.map((id) => `[${id}]`).join("");
  });

  const artifacts: AiArtifact[] = [];
  text = text.replace(/\[\[table:(R\d+)(?:\.(\d+))?\]\]/g, (_m, resultId: string, index?: string) => {
    const result = ledger.getResult(resultId);
    const section = result?.sections[(index ? Number(index) : 1) - 1];
    if (!result || !section) {
      warnings.push(`Removed a table reference that does not exist (${resultId}${index ? `.${index}` : ""})`);
      return "";
    }
    const artifactId = `A${artifacts.length + 1}`;
    artifacts.push({ artifactId, resultId, title: section.title, columns: section.columns, rows: section.rows.slice(0, 100), formats: section.formats, total: section.rows.length });
    return `{{artifact:${artifactId}}}`;
  });

  const ungrounded = findUngroundedFigures(text, corpus);
  if (ungrounded.length) warnings.push(`These figures are not directly present in the retrieved data (they may be derived; verify before relying on them): ${ungrounded.join(", ")}`);

  const citations: AiCitation[] = ledger.allEvidence().map((e) => ({ ...e, cited: cited.has(e.evidenceId) }));
  if (!cited.size && ledger.allResults().length) warnings.push("The answer cites no evidence.");
  return { text: text.trim(), artifacts, citations, warnings };
}

// ───────────────────────────── Loop ─────────────────────────────

export async function* runAgent(request: AgentRequest): AsyncGenerator<AiEvent> {
  const started = Date.now();
  const config = request.config ?? readAiConfig();
  const { principal, provider } = request;
  const requestId = request.requestId ?? randomUUID();
  const asOf = getStore().asOf;
  const available = toolsFor(principal, request.tools);

  let conversationId = request.conversationId;
  if (conversationId && !getConversation(conversationId, principal.id)) {
    yield { type: "error", code: "conversation_not_found", message: "That conversation does not exist or belongs to another user." };
    return;
  }
  const history = conversationId ? getMessages(conversationId, principal.id) : [];
  if (!conversationId) conversationId = createConversation(principal.id, request.question).conversationId;

  recordAudit(principal, "ai.query", { requestId, resource: `conversation:${conversationId}`, details: { question: request.question.slice(0, 500), selectedCase: request.selectedCaseId ?? null, model: provider.model, tools: available.map((t) => t.name) } });
  appendMessage(conversationId, "user", request.question);
  yield { type: "meta", conversationId, model: provider.model, tools: available.map((t) => t.name) };

  const ledger = new EvidenceLedger(history.filter((m) => m.role === "user").length + 1);
  const instructions = buildInstructions({ principal, asOf, selectedCaseId: request.selectedCaseId, previousTurnMemo: previousMemo(history), availableTools: available.map((t) => t.name) });
  const input: unknown[] = [...historyItems(history), { role: "user", content: request.question }];
  const specs = available.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }));
  const trace: AiToolTrace[] = [];
  let inputTokens = 0;
  let outputTokens = 0;
  let rounds = 0;
  let finalText = "";
  const pendingDeltas: string[] = [];

  try {
    for (; rounds < config.maxToolRounds + 1; rounds++) {
      const lastChance = rounds >= config.maxToolRounds;
      pendingDeltas.length = 0;
      const response = await provider.respond(
        { instructions, input, tools: lastChance ? [] : specs, maxOutputTokens: config.maxOutputTokens, safetyIdentifier: principal.id, signal: request.signal },
        { onTextDelta: (delta) => pendingDeltas.push(delta) },
      );
      for (const delta of pendingDeltas) yield { type: "delta", text: delta };
      inputTokens += response.usage.inputTokens;
      outputTokens += response.usage.outputTokens;

      if (!response.functionCalls.length || lastChance) {
        if (response.incomplete) throw new LlmServiceError("llm_incomplete", `The answer was cut off (${response.incomplete}). Try a narrower question.`);
        finalText = response.text;
        if (!finalText.trim()) throw new LlmServiceError("llm_incomplete", "The model returned no answer. Try rephrasing or narrowing the question.");
        break;
      }
      yield { type: "reset_text" };
      input.push(...response.outputItems);

      for (const call of response.functionCalls) {
        const tool = available.find((t) => t.name === call.name);
        let args: Record<string, unknown> = {};
        let parseError: string | null = null;
        try {
          args = call.arguments ? (JSON.parse(call.arguments) as Record<string, unknown>) : {};
        } catch {
          parseError = "Arguments were not valid JSON.";
        }
        yield { type: "tool_start", name: call.name, args };
        const t0 = Date.now();
        let output: string;
        let summary = "";
        let rows = 0;
        let error: string | undefined;
        let resultId: string | undefined;
        if (!tool) {
          error = `Tool ${call.name} is not available to this user.`;
          recordAudit(principal, "access.denied", { requestId, resource: `tool:${call.name}`, outcome: "denied", details: { reason: "tool not permitted or unknown" } });
          output = JSON.stringify({ error });
        } else if (parseError) {
          error = parseError;
          output = JSON.stringify({ error });
        } else {
          try {
            const result = await runWithContext({ principal, requestId }, async () => tool.handler(args, { principal, asOf }));
            const stored = ledger.store(tool.name, args, result);
            resultId = stored.resultId;
            summary = result.summary;
            rows = result.sections.reduce((n, s) => n + s.rows.length, 0);
            output = serialiseForModel(stored);
          } catch (e) {
            if (e instanceof SqlRejected) {
              error = `Query rejected: ${e.message}`;
              recordAudit(principal, "data.sql", { requestId, resource: "run_analytical_query", outcome: "denied", details: { reason: e.message, sql: String(args.sql ?? "").slice(0, 600) } });
              output = JSON.stringify({ error, hint: "Fix the query and try again, or use a business tool." });
            } else {
              error = "The tool failed to run.";
              recordAudit(principal, "ai.error", { requestId, resource: `tool:${call.name}`, outcome: "error", details: { message: e instanceof Error ? e.message.slice(0, 300) : "unknown" } });
              output = JSON.stringify({ error });
            }
          }
        }
        const ms = Date.now() - t0;
        recordAudit(principal, tool?.name === "run_analytical_query" && !error ? "data.sql" : "ai.tool", {
          requestId,
          resource: `tool:${call.name}`,
          outcome: error ? "error" : "success",
          details: { args, rows, ms, resultId, ...(error ? { error } : {}), ...(tool?.name === "run_analytical_query" && !error ? { sql: String(args.sql ?? "").slice(0, 800) } : {}) },
        });
        trace.push({ name: call.name, args, summary: error ?? summary, resultId, rows, ms, error });
        yield { type: "tool_result", name: call.name, summary: error ?? summary, ms, rows, error };
        input.push({ type: "function_call_output", call_id: call.callId, output });
      }
    }

    const corpus = ledger
      .allResults()
      .map((r) => JSON.stringify(r.sections.map((s) => s.rows)) + r.summary)
      .join(" ");
    const finalised = finaliseAnswer(finalText, ledger, corpus);
    const latencyMs = Date.now() - started;
    const cost = config.priceInputPer1M !== null && config.priceOutputPer1M !== null ? (inputTokens / 1e6) * config.priceInputPer1M + (outputTokens / 1e6) * config.priceOutputPer1M : null;
    const answer: AiAnswer = {
      answerId: randomUUID(),
      conversationId,
      text: finalised.text,
      artifacts: finalised.artifacts,
      citations: finalised.citations,
      toolTrace: trace,
      warnings: finalised.warnings,
      usage: { inputTokens, outputTokens, toolCalls: trace.length, rounds: rounds + 1, latencyMs, estimatedCostUsd: cost },
      model: provider.model,
      asOf,
    };
    appendMessage(conversationId, "assistant", finalised.text, { ...answer, memo: buildMemo(ledger.allResults()) });
    recordUsage({ userId: principal.id, conversationId, requestId, model: provider.model, inputTokens, outputTokens, latencyMs, toolCalls: trace.length, estimatedCostUsd: cost });
    yield { type: "final", answer };
  } catch (error) {
    const known = error instanceof LlmServiceError ? error : null;
    recordAudit(principal, "ai.error", { requestId, outcome: "error", details: { code: known?.code ?? "internal", message: known ? known.message : error instanceof Error ? error.message.slice(0, 300) : "unknown" } });
    yield { type: "error", code: known?.code ?? "internal_error", message: known?.message ?? "TattvaAI could not complete this request." };
  }
}

export async function askOnce(request: AgentRequest): Promise<AiAnswer> {
  let answer: AiAnswer | null = null;
  for await (const event of runAgent(request)) {
    if (event.type === "final") answer = event.answer;
    if (event.type === "error") throw new LlmServiceError(event.code === "conversation_not_found" ? "llm_bad_request" : "llm_unavailable", event.message);
  }
  if (!answer) throw new LlmServiceError("llm_unavailable", "No answer was produced.");
  return answer;
}

export type { RecordRow };
