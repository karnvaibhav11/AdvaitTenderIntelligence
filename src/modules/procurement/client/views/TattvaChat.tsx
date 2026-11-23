"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, ChevronDown, MessageSquarePlus, Send, ServerOff, Sparkles, Square } from "lucide-react";
import type { AiAnswer, AiEvent, ConversationSummary } from "../../shared/types";
import { ApiError } from "../api";
import { useWorkspace } from "../context";
import { Markdown } from "../Markdown";

interface Turn {
  id: number;
  question: string;
  answer?: AiAnswer;
  error?: { message: string; code?: string };
  live?: { steps: Array<{ name: string; summary?: string; ms?: number; error?: boolean; done: boolean }>; text: string };
}

export interface TattvaSeed {
  question: string;
  caseId?: string;
  nonce: number;
}

const STARTERS: Array<{ title: string; questions: string[] }> = [
  { title: "Executive", questions: ["What is the current procurement status across all departments?", "Which high-value tenders are delayed?", "Which risks should the CMD review first, and why?"] },
  { title: "Tenders and bids", questions: ["Which tenders are closing in the next seven days?", "Show tenders that have received repeated corrigenda.", "Compare all bidders for tender TND-000123 and tell me who is L1."] },
  { title: "Delivery and vendors", questions: ["Which contracts are expiring in the next 60 days?", "Which vendors have repeated delivery delays?", "Identify procurement delays that may affect critical mine equipment availability."] },
  { title: "Finance and audit", questions: ["Which invoices are overdue, and what is outstanding by department?", "Identify possible duplicate invoices.", "Show me procurement transactions with incomplete approval trails."] },
];

const humanTool = (name: string) => name.replaceAll("_", " ");

function Trace({ answer }: { answer: AiAnswer }) {
  return (
    <details className="adv-details">
      <summary><ChevronDown size={14} /> How this was answered ({answer.toolTrace.length} tool call{answer.toolTrace.length === 1 ? "" : "s"})</summary>
      <ol className="adv-plan">
        {answer.toolTrace.map((t, i) => (
          <li key={i}>
            <strong>{humanTool(t.name)}</strong> <small>{t.ms} ms · {t.rows} rows</small>
            <br />
            {t.error ? <span className="adv-trace-error">{t.summary}</span> : t.summary}
            <pre className="adv-sql-args">{JSON.stringify(t.args)}</pre>
          </li>
        ))}
      </ol>
    </details>
  );
}

function AnswerCard({ answer }: { answer: AiAnswer }) {
  const order = [...new Set([...answer.text.matchAll(/\[(E\d+)\]/g)].map((m) => m[1]))];
  return (
    <div className="adv-answer">
      {answer.warnings.length > 0 && (
        <div className="adv-warnings" role="note">
          <AlertTriangle size={14} />
          <ul>{answer.warnings.map((w) => <li key={w}>{w}</li>)}</ul>
        </div>
      )}
      <Markdown text={answer.text} citations={answer.citations} artifacts={answer.artifacts} />
      {order.length > 0 && (
        <div className="adv-block">
          <h4>Evidence cited</h4>
          <ol className="adv-evidence">
            {order.map((id, index) => {
              const c = answer.citations.find((x) => x.evidenceId === id);
              return c ? (
                <li key={id}>
                  <span className="adv-cite adv-cite-static">{index + 1}</span> {c.label}
                  {c.page ? `, page ${c.page}` : ""} <small>{c.kind}</small>
                </li>
              ) : null;
            })}
          </ol>
        </div>
      )}
      {answer.toolTrace.length > 0 && <Trace answer={answer} />}
      {answer.model && (
        <p className="adv-usage">
          {answer.model} · {answer.usage.inputTokens.toLocaleString("en-IN")} in / {answer.usage.outputTokens.toLocaleString("en-IN")} out tokens · {(answer.usage.latencyMs / 1000).toFixed(1)} s
          {answer.usage.estimatedCostUsd !== null ? ` · ≈ $${answer.usage.estimatedCostUsd.toFixed(4)}` : ""} · data as of {answer.asOf} · AI-generated; verify against the cited records
        </p>
      )}
    </div>
  );
}

export function TattvaChat({ seed, active, compact = false }: { seed: TattvaSeed | null; active: boolean; compact?: boolean }) {
  const { api, selectedCaseId } = useWorkspace();
  const [turns, setTurns] = useState<Turn[]>([]);
  const [conversationId, setConversationId] = useState<string | undefined>();
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const counter = useRef(0);
  const endRef = useRef<HTMLDivElement>(null);
  const handledSeed = useRef(-1);
  const abort = useRef<AbortController | null>(null);

  const refreshConversations = useCallback(() => {
    api.conversations().then(setConversations).catch(() => undefined);
  }, [api]);

  useEffect(() => {
    if (active && !compact) refreshConversations();
  }, [active, compact, refreshConversations]);

  const ask = useCallback(
    async (question: string, caseId?: string, forceNew = false) => {
      const text = question.trim();
      if (!text || busy) return;
      const id = ++counter.current;
      setTurns((prev) => [...prev, { id, question: text, live: { steps: [], text: "" } }]);
      setInput("");
      setBusy(true);
      const controller = new AbortController();
      abort.current = controller;
      const patch = (fn: (turn: Turn) => Turn) => setTurns((prev) => prev.map((t) => (t.id === id ? fn(t) : t)));
      const onEvent = (event: AiEvent) => {
        if (event.type === "meta") setConversationId(event.conversationId);
        if (event.type === "tool_start") patch((t) => ({ ...t, live: { text: "", steps: [...(t.live?.steps ?? []), { name: event.name, done: false }] } }));
        if (event.type === "tool_result")
          patch((t) => ({ ...t, live: { text: t.live?.text ?? "", steps: (t.live?.steps ?? []).map((s) => (s.name === event.name && !s.done ? { ...s, done: true, summary: event.summary, ms: event.ms, error: Boolean(event.error) } : s)) } }));
        if (event.type === "delta") patch((t) => ({ ...t, live: { steps: t.live?.steps ?? [], text: (t.live?.text ?? "") + event.text } }));
        if (event.type === "reset_text") patch((t) => ({ ...t, live: { steps: t.live?.steps ?? [], text: "" } }));
      };
      try {
        const answer = await api.ask(text, { conversationId: forceNew ? undefined : conversationId, caseId: caseId ?? selectedCaseId ?? undefined, onEvent, signal: controller.signal });
        setConversationId(answer.conversationId);
        patch((t) => ({ ...t, answer, live: undefined }));
        refreshConversations();
      } catch (error) {
        const aborted = error instanceof DOMException && error.name === "AbortError";
        patch((t) => ({ ...t, live: undefined, error: { message: aborted ? "Stopped." : error instanceof Error ? error.message : "Request failed", code: error instanceof ApiError ? error.code : undefined } }));
      } finally {
        setBusy(false);
        abort.current = null;
      }
    },
    [api, busy, conversationId, refreshConversations, selectedCaseId],
  );

  useEffect(() => {
    if (seed && seed.nonce !== handledSeed.current) {
      handledSeed.current = seed.nonce;
      setTurns([]);
      counter.current = 0;
      void ask(seed.question, seed.caseId, true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seed]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [turns]);

  const open = async (id: string) => {
    const messages = await api.messages(id);
    const loaded: Turn[] = [];
    let pending: Turn | null = null;
    for (const m of messages) {
      if (m.role === "user") {
        pending = { id: ++counter.current, question: m.content };
        loaded.push(pending);
      } else if (pending) {
        pending.answer = m.payload ?? { answerId: String(m.messageId), conversationId: id, text: m.content, artifacts: [], citations: [], toolTrace: [], warnings: [], usage: { inputTokens: 0, outputTokens: 0, toolCalls: 0, rounds: 0, latencyMs: 0, estimatedCostUsd: null }, model: "", asOf: "" };
      }
    }
    setTurns(loaded);
    setConversationId(id);
  };

  const fresh = () => {
    setTurns([]);
    setConversationId(undefined);
  };

  return (
    <div className={compact ? "adv-chat-compact" : "adv-chat-layout"}>
      {!compact && <aside className="adv-conversations">
        <button type="button" className="adv-new-chat" onClick={fresh}><MessageSquarePlus size={15} /> New conversation</button>
        <ul>
          {conversations.map((c) => (
            <li key={c.conversationId}>
              <button type="button" className={c.conversationId === conversationId ? "active" : ""} onClick={() => void open(c.conversationId)} title={c.title}>{c.title}</button>
            </li>
          ))}
          {conversations.length === 0 && <li className="adv-hint">No earlier conversations</li>}
        </ul>
      </aside>}

      <div className="adv-chat">
        {!compact && <header className="adv-page-head">
          <div>
            <h1>TattvaAI</h1>
            <p>Ask in plain language. TattvaAI plans the analysis, calls authorised tools over your permitted records, and cites its evidence. It cannot approve, award, disqualify or change anything.</p>
          </div>
          {selectedCaseId && <span className="adv-asof">Case in focus: {selectedCaseId.replace("ADV-DEMO-", "")}</span>}
        </header>}

        <div className="adv-thread">
          {turns.length === 0 && (
            <div className="adv-starters">
              <Sparkles size={20} />
              <h2>What would you like to know?</h2>
              <div className="adv-starter-groups">
                {(compact ? STARTERS.slice(0, 2).map((g) => ({ ...g, questions: g.questions.slice(0, 2) })) : STARTERS).map((group) => (
                  <div key={group.title}>
                    <h4>{group.title}</h4>
                    <div className="adv-chips">
                      {group.questions.map((q) => <button type="button" key={q} className="adv-chip adv-chip-link" onClick={() => void ask(q)}>{q}</button>)}
                    </div>
                  </div>
                ))}
              </div>
              {!compact && <p className="adv-hint">Answers are generated by an AI model from tool results. Facts, calculations and interpretation are labelled; check the cited records before acting.</p>}
            </div>
          )}
          {turns.map((turn) => (
            <div key={turn.id} className="adv-turn">
              <div className="adv-q">{turn.question}</div>
              {turn.answer && <AnswerCard answer={turn.answer} />}
              {turn.live && (
                <div className="adv-live">
                  {turn.live.steps.map((s, i) => (
                    <div key={i} className={`adv-step ${s.done ? "done" : ""} ${s.error ? "err" : ""}`}>
                      <span className="adv-step-dot" /> {humanTool(s.name)}{s.done ? ` — ${s.summary}` : "…"}
                    </div>
                  ))}
                  {turn.live.text ? <p className="adv-md-p adv-streaming">{turn.live.text}</p> : <div className="adv-loading"><span className="adv-dots"><i /><i /><i /></span> {turn.live.steps.length ? "Analysing results…" : "Planning…"}</div>}
                </div>
              )}
              {turn.error &&
                (turn.error.code === "llm_not_configured" ? (
                  <div className="adv-error"><ServerOff size={18} /><div><strong>TattvaAI is not configured on this server</strong><p>{turn.error.message}</p><p className="adv-hint">No fallback answers are produced. See <code>.env.example</code> for <code>OPENAI_API_KEY</code> and <code>OPENAI_MODEL</code>.</p></div></div>
                ) : (
                  <div className="adv-error"><AlertTriangle size={18} /><div><strong>Could not answer</strong><p>{turn.error.message}</p></div></div>
                ))}
            </div>
          ))}
          <div ref={endRef} />
        </div>

        <div className="adv-composer-dock">
          <form className="adv-composer" onSubmit={(e) => { e.preventDefault(); void ask(input); }}>
            <input value={input} onChange={(e) => setInput(e.target.value)} placeholder="Ask about tenders, bids, vendors, contracts, deliveries, invoices, delays or risks" aria-label="Ask TattvaAI" maxLength={1500} />
            {busy ? (
              <button type="button" onClick={() => abort.current?.abort()} aria-label="Stop"><Square size={14} /></button>
            ) : (
              <button type="submit" disabled={!input.trim()} aria-label="Send"><Send size={16} /></button>
            )}
          </form>
        </div>
      </div>
    </div>
  );
}
