import { randomUUID } from "node:crypto";
import { getAppDb } from "../platform/app-db";

/** Conversations are private to the user who created them. Every read checks ownership. */

export interface ConversationSummary {
  conversationId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

export interface StoredMessage {
  messageId: number;
  role: "user" | "assistant";
  content: string;
  payload: unknown;
  createdAt: string;
}

export function createConversation(userId: string, title: string): ConversationSummary {
  const now = new Date().toISOString();
  const conversationId = randomUUID();
  getAppDb()
    .prepare("INSERT INTO conversations (conversation_id, user_id, title, created_at, updated_at) VALUES (?,?,?,?,?)")
    .run(conversationId, userId, title.slice(0, 90), now, now);
  return { conversationId, title: title.slice(0, 90), createdAt: now, updatedAt: now };
}

export function getConversation(conversationId: string, userId: string): ConversationSummary | null {
  const row = getAppDb()
    .prepare("SELECT conversation_id, title, created_at, updated_at FROM conversations WHERE conversation_id = ? AND user_id = ?")
    .get(conversationId, userId) as { conversation_id: string; title: string; created_at: string; updated_at: string } | undefined;
  return row ? { conversationId: row.conversation_id, title: row.title, createdAt: row.created_at, updatedAt: row.updated_at } : null;
}

export function listConversations(userId: string, limit = 30): ConversationSummary[] {
  return (
    getAppDb()
      .prepare("SELECT conversation_id, title, created_at, updated_at FROM conversations WHERE user_id = ? ORDER BY updated_at DESC LIMIT ?")
      .all(userId, limit) as Array<{ conversation_id: string; title: string; created_at: string; updated_at: string }>
  ).map((row) => ({ conversationId: row.conversation_id, title: row.title, createdAt: row.created_at, updatedAt: row.updated_at }));
}

export function appendMessage(conversationId: string, role: "user" | "assistant", content: string, payload?: unknown): void {
  const now = new Date().toISOString();
  const db = getAppDb();
  db.prepare("INSERT INTO messages (conversation_id, role, content, payload_json, created_at) VALUES (?,?,?,?,?)").run(
    conversationId,
    role,
    content,
    payload === undefined ? null : JSON.stringify(payload),
    now,
  );
  db.prepare("UPDATE conversations SET updated_at = ? WHERE conversation_id = ?").run(now, conversationId);
}

export function getMessages(conversationId: string, userId: string, limit = 200): StoredMessage[] {
  if (!getConversation(conversationId, userId)) return [];
  return (
    getAppDb()
      .prepare("SELECT message_id, role, content, payload_json, created_at FROM messages WHERE conversation_id = ? ORDER BY message_id LIMIT ?")
      .all(conversationId, limit) as Array<{ message_id: number; role: "user" | "assistant"; content: string; payload_json: string | null; created_at: string }>
  ).map((row) => ({ messageId: row.message_id, role: row.role, content: row.content, payload: row.payload_json ? JSON.parse(row.payload_json) : null, createdAt: row.created_at }));
}

export function deleteConversation(conversationId: string, userId: string): boolean {
  if (!getConversation(conversationId, userId)) return false;
  const db = getAppDb();
  db.prepare("DELETE FROM messages WHERE conversation_id = ?").run(conversationId);
  db.prepare("DELETE FROM conversations WHERE conversation_id = ?").run(conversationId);
  return true;
}

export function recordUsage(entry: {
  userId: string;
  conversationId: string | null;
  requestId: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  toolCalls: number;
  estimatedCostUsd: number | null;
}): void {
  getAppDb()
    .prepare("INSERT INTO ai_usage (ts, user_id, conversation_id, request_id, model, input_tokens, output_tokens, latency_ms, tool_calls, estimated_cost_usd) VALUES (?,?,?,?,?,?,?,?,?,?)")
    .run(new Date().toISOString(), entry.userId, entry.conversationId, entry.requestId, entry.model, entry.inputTokens, entry.outputTokens, entry.latencyMs, entry.toolCalls, entry.estimatedCostUsd);
}

export function usageSummary(): { total: Record<string, number>; byUser: Array<Record<string, string | number>>; recent: Array<Record<string, string | number | null>> } {
  const db = getAppDb();
  const total = (db
    .prepare("SELECT COUNT(*) AS requests, COALESCE(SUM(input_tokens),0) AS input_tokens, COALESCE(SUM(output_tokens),0) AS output_tokens, COALESCE(SUM(tool_calls),0) AS tool_calls, COALESCE(SUM(estimated_cost_usd),0) AS cost_usd, COALESCE(AVG(latency_ms),0) AS avg_latency_ms FROM ai_usage")
    .get() as Record<string, number>);
  const byUser = db.prepare("SELECT user_id, COUNT(*) AS requests, SUM(input_tokens + output_tokens) AS tokens FROM ai_usage GROUP BY user_id ORDER BY tokens DESC LIMIT 20").all() as Array<Record<string, string | number>>;
  const recent = db.prepare("SELECT ts, user_id, model, input_tokens, output_tokens, latency_ms, tool_calls, estimated_cost_usd FROM ai_usage ORDER BY usage_id DESC LIMIT 20").all() as Array<Record<string, string | number | null>>;
  return { total, byUser, recent };
}
