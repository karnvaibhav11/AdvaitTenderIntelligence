/**
 * Benchmark evaluation.
 *
 *   npm run eval:tools   Deterministic. Executes each question's gold tool plan as the
 *                        question's persona and checks that the tool outputs contain the
 *                        ground-truth facts. Measures the tool layer and the benchmark
 *                        itself; needs no model.
 *   npm run eval:ai      Live. Sends every question through the real TattvaAI agent
 *                        (OpenAI) and scores tool selection, fact accuracy, citations,
 *                        hallucinated identifiers, refusals and permission handling.
 *                        Requires OPENAI_API_KEY and OPENAI_MODEL on the server;
 *                        otherwise it exits with a clear message and no score.
 *
 * Options: --limit N, --category name, --out path
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { getStore } from "../src/modules/procurement/server/db";
import { CORE_TOOLS, toolsFor } from "../src/modules/procurement/server/ai/tools";
import { EvidenceLedger } from "../src/modules/procurement/server/ai/ledger";
import { readAiConfig, missingAiConfig } from "../src/modules/procurement/server/ai/config";
import { runWithContext } from "../src/modules/procurement/server/platform/context";
import { DemoIdentityProvider } from "../src/modules/procurement/server/platform/identity";
import { openAppDb, useAppDbForTests } from "../src/modules/procurement/server/platform/app-db";
import type { Fact, GoldenQuestion } from "./generate-golden";

const args = process.argv.slice(2);
const mode = args.includes("--llm") ? "llm" : "tools";
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const limit = flag("--limit") ? Number(flag("--limit")) : Infinity;
const onlyCategory = flag("--category");

const PASSWORD = "benchmark-only";
process.env.DEMO_LOGIN_PASSWORD = PASSWORD;
process.env.SESSION_SECRET ??= "benchmark-session-secret-benchmark-session-secret";
const idp = new DemoIdentityProvider();

const benchmark = JSON.parse(readFileSync(path.resolve("benchmark/golden-questions.json"), "utf8")) as { questions: GoldenQuestion[]; total: number };
const selected = benchmark.questions.filter((q) => !onlyCategory || q.category === onlyCategory).slice(0, limit);

// ───────────────────────────── Matching ─────────────────────────────

function numbersFrom(text: string): number[] {
  const out: number[] = [];
  for (const m of text.matchAll(/(\d[\d,]*(?:\.\d+)?)\s*(crore|cr\b|lakh|lakhs)?/gi)) {
    const raw = Number(m[1].replaceAll(",", ""));
    if (!Number.isFinite(raw)) continue;
    const unit = (m[2] ?? "").toLowerCase();
    out.push(raw);
    if (unit.startsWith("cr")) out.push(raw * 1e7);
    if (unit.startsWith("lakh")) out.push(raw * 1e5);
  }
  return out;
}

function numberPresent(value: number, haystack: number[]): boolean {
  return haystack.some((n) => {
    if (Number.isInteger(value) && Math.abs(value) < 100_000) return n === value;
    return Math.abs(n - value) <= Math.max(Math.abs(value) * 0.006, 0.51);
  });
}

function factPresent(fact: Fact, text: string, numbers: number[]): boolean {
  if (fact.kind === "number" && fact.value === 0) return numberPresent(0, numbers) || /\b(no|none|zero|nil)\b/i.test(text) || /\b0 (tender|contract|case|invoice|group|finding|po)/i.test(text) || text.includes("[]");
  if (fact.kind === "number") return numberPresent(fact.value, numbers);
  return text.toLowerCase().includes(fact.value.toLowerCase());
}

// ───────────────────────────── Tool-layer evaluation ─────────────────────────────

async function evaluateTools() {
  useAppDbForTests(openAppDb(":memory:"));
  const asOf = getStore().asOf;
  const results: Array<{ id: string; category: string; pass: boolean; missing: string[]; note?: string; skipped?: boolean }> = [];
  for (const q of selected) {
    const principal = idp.authenticate(q.persona, PASSWORD)!;
    const missing: string[] = [];
    let text = "";
    let note: string | undefined;
    if (q.gold_tool_calls.length) {
      const ledger = new EvidenceLedger();
      const permitted = toolsFor(principal, CORE_TOOLS);
      for (const call of q.gold_tool_calls) {
        const tool = permitted.find((t) => t.name === call.name);
        if (!tool) {
          missing.push(`tool ${call.name} not permitted for ${q.persona}`);
          continue;
        }
        try {
          const out = await runWithContext({ principal, requestId: "eval" }, async () => tool.handler(call.args, { principal, asOf }));
          const stored = ledger.store(tool.name, call.args, out);
          text += ` ${stored.summary} ${JSON.stringify(stored.sections.map((s) => s.rows))}`;
        } catch (error) {
          missing.push(`tool ${call.name} failed: ${error instanceof Error ? error.message.slice(0, 120) : error}`);
        }
      }
    } else if (q.criteria.kind === "permission_denied") {
      // No gold tool: the check is that the persona's scope hides the banned content.
      const ledger = new EvidenceLedger();
      const tool = CORE_TOOLS.find((t) => t.name === "get_tender_timeline")!;
      for (const banned of q.criteria.must_not_contain ?? []) {
        if (/^ADV-DEMO-\d{4}-\d{6}$/.test(banned)) {
          const out = await runWithContext({ principal, requestId: "eval" }, async () => tool.handler({ id: banned }, { principal, asOf }));
          ledger.store(tool.name, { id: banned }, out);
          if (!/No record matching/.test(out.summary)) missing.push(`out-of-scope case ${banned} was visible`);
        }
      }
      note = "scope check";
    } else {
      note = `no gold tool plan (${q.criteria.kind}); evaluated only with a live model`;
    }
    const numbers = numbersFrom(text);
    for (const fact of q.expected_facts) if (!factPresent(fact, text, numbers)) missing.push(`${fact.label}=${fact.value}`);
    results.push({ id: q.id, category: q.category, pass: missing.length === 0, missing, note, skipped: Boolean(note?.startsWith("no gold tool plan")) });
  }
  return results;
}

// ───────────────────────────── Live evaluation ─────────────────────────────

async function evaluateLive() {
  const config = readAiConfig();
  const missing = missingAiConfig(config);
  if (missing.length) {
    console.error(`Cannot run the live evaluation: ${missing.join(", ")} not set on this machine.\nSet them (see .env.example) and re-run. No score is produced without a real model.`);
    process.exit(2);
  }
  useAppDbForTests(openAppDb(":memory:"));
  const { handleProcurementRequest } = await import("../src/modules/procurement/server/handler");
  const call = async (cookie: string, body: object) => {
    const request = new Request("http://localhost/api/procurement/tattva/ask", { method: "POST", headers: { "content-type": "application/json", cookie, origin: "http://localhost" }, body: JSON.stringify(body) });
    return handleProcurementRequest(request, ["tattva", "ask"]);
  };
  const login = async (username: string) => {
    const response = await handleProcurementRequest(new Request("http://localhost/api/procurement/auth/login", { method: "POST", headers: { "content-type": "application/json", origin: "http://localhost" }, body: JSON.stringify({ username, password: PASSWORD }) }), ["auth", "login"]);
    return (response.headers.get("set-cookie") ?? "").split(";")[0];
  };
  const cookies = new Map<string, string>();
  const conversations = new Map<string, string>();
  const results: Array<Record<string, unknown>> = [];
  let tokens = 0;
  let cost = 0;
  let latency = 0;
  for (const q of selected) {
    if (!cookies.has(q.persona)) cookies.set(q.persona, await login(q.persona));
    const started = Date.now();
    const response = await call(cookies.get(q.persona)!, { question: q.question, conversationId: q.follow_up_of ? conversations.get(q.follow_up_of) : undefined });
    const body = (await response.json()) as { answer?: import("../src/modules/procurement/shared/types").AiAnswer; error?: string };
    if (!body.answer) {
      results.push({ id: q.id, category: q.category, pass: false, error: body.error ?? `HTTP ${response.status}` });
      continue;
    }
    const a = body.answer;
    conversations.set(q.id, a.conversationId);
    tokens += a.usage.inputTokens + a.usage.outputTokens;
    cost += a.usage.estimatedCostUsd ?? 0;
    latency += Date.now() - started;
    const text = `${a.text} ${a.artifacts.map((x) => JSON.stringify(x.rows)).join(" ")}`;
    const numbers = numbersFrom(a.text);
    const problems: string[] = [];
    const toolNames = a.toolTrace.map((t) => t.name);
    const goldNames = q.gold_tool_calls.map((t) => t.name);
    const toolOk = goldNames.length === 0 || goldNames.some((n) => toolNames.includes(n)) || toolNames.includes("run_analytical_query");
    if (!toolOk) problems.push(`tool selection: used ${toolNames.join(",") || "none"}, expected ${goldNames.join(",")}`);
    if (q.criteria.kind === "facts") {
      for (const fact of q.expected_facts) if (!factPresent(fact, a.text, numbers) && !(fact.kind === "text" && text.toLowerCase().includes(fact.value.toLowerCase()))) problems.push(`missing ${fact.label}=${fact.value}`);
      if (q.expected_facts.length && a.citations.every((c) => !c.cited)) problems.push("no citations");
    }
    for (const banned of q.criteria.must_not_contain ?? []) if (a.text.toLowerCase().includes(banned.toLowerCase())) problems.push(`contains forbidden "${banned}"`);
    if (q.criteria.kind === "refusal" && !/(not (available|accessible|found|able|possible)|cannot|can't|no record|do not have|don't have|unable|not (in|part of) the|outside|read-only|not supported|isn't|is not)/i.test(a.text)) problems.push("did not state the limitation");
    if (q.criteria.kind === "permission_denied" && !/(not (available|accessible|permitted|visible)|outside|scope|permission|access|cannot|can't|unable|don't have|do not have)/i.test(a.text)) problems.push("did not state the access limit");
    if (q.criteria.kind === "clarify" && !/(\?|assum|interpret|define|by "|taken to mean)/i.test(a.text)) problems.push("neither clarified nor stated an assumption");
    const known = new Set((text + JSON.stringify(a.toolTrace)).match(/ADV-[A-Z0-9-]+/g) ?? []);
    const invented = (a.text.match(/ADV-DEMO-[A-Z0-9-]+/g) ?? []).filter((id) => !known.has(id) && !q.question.includes(id));
    if (invented.length) problems.push(`identifier not in any tool result: ${invented.slice(0, 3).join(", ")}`);
    results.push({ id: q.id, category: q.category, pass: problems.length === 0, problems, tools: toolNames, tokens: a.usage.inputTokens + a.usage.outputTokens, ms: a.usage.latencyMs });
  }
  return { results, tokens, cost, latency };
}

// ───────────────────────────── Reporting ─────────────────────────────

function report(results: Array<{ id: string; category: string; pass: boolean }>) {
  const byCategory = new Map<string, { pass: number; total: number }>();
  for (const r of results) {
    const c = byCategory.get(r.category) ?? { pass: 0, total: 0 };
    c.total++;
    if (r.pass) c.pass++;
    byCategory.set(r.category, c);
  }
  console.log("\ncategory           pass / total");
  for (const [category, c] of byCategory) console.log(`  ${category.padEnd(16)} ${String(c.pass).padStart(3)} / ${c.total}`);
  const pass = results.filter((r) => r.pass).length;
  console.log(`\noverall: ${pass} / ${results.length} (${((pass / Math.max(results.length, 1)) * 100).toFixed(1)}%)`);
  return { pass, total: results.length, byCategory: Object.fromEntries(byCategory) };
}

async function main() {
  console.log(`Benchmark: ${selected.length} of ${benchmark.total} questions, mode=${mode}`);
  if (mode === "tools") {
    const all = await evaluateTools();
    const results = all.filter((r) => !r.skipped);
    for (const r of results.filter((x) => !x.pass)) console.log(`  FAIL ${r.id} [${r.category}] ${r.missing.join("; ")}`);
    const summary = report(results);
    console.log(`Not evaluated offline (need a live model: ambiguity, refusal and permission-wording checks): ${all.length - results.length}`);
    console.log("\nThis scores the tool layer against database-derived ground truth. It is not a measure of model answer quality: run `npm run eval:ai` with OpenAI configured for that.");
    const out = flag("--out") ?? "benchmark/results/tools-latest.json";
    mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
    writeFileSync(path.resolve(out), JSON.stringify({ mode, summary, results }, null, 1));
    if (summary.pass < summary.total) process.exitCode = 1;
    return;
  }
  const { results, tokens, cost, latency } = await evaluateLive();
  for (const r of results.filter((x) => !x.pass)) console.log(`  FAIL ${r.id} [${r.category}] ${(r.problems as string[] | undefined)?.join("; ") ?? r.error}`);
  const summary = report(results as Array<{ id: string; category: string; pass: boolean }>);
  console.log(`tokens ${tokens.toLocaleString()}, est. cost $${cost.toFixed(2)}, mean latency ${(latency / Math.max(results.length, 1) / 1000).toFixed(1)} s`);
  const out = flag("--out") ?? `benchmark/results/llm-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  writeFileSync(path.resolve(out), JSON.stringify({ mode, model: readAiConfig().model, summary, tokens, cost, results }, null, 1));
}

void main();
