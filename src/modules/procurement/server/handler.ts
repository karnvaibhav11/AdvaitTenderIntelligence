import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { AiEvent, CaseFilters, DatasetInfo, SessionUser } from "../shared/types";
import { getAppDb } from "./platform/app-db";
import { listAudit, recordAudit, verifyAuditChain } from "./platform/audit-log";
import { runWithContext } from "./platform/context";
import { getConnectorStatuses } from "./platform/connectors";
import {
  type IdentityProvider,
  clearLoginFailures,
  clearSessionCookieHeader,
  createSession,
  getIdentityProvider,
  loginThrottled,
  noteLoginFailure,
  readSession,
  revokeSession,
  sessionCookieHeader,
} from "./platform/identity";
import { AuthorizationError, type Permission, type Principal, ROLE_DEFINITIONS, VIEW_IDS, hasPermission } from "./platform/rbac";
import { getDomainAgent } from "./ai/domain-registry";
import { LlmServiceError, readAiConfig } from "./ai/config";
import { askOnce, runAgent } from "./ai/agent";
import { deleteConversation, getMessages, listConversations, usageSummary } from "./ai/conversations";
import { OpenAIResponsesProvider, getLlmProvider } from "./ai/provider";
import { SAMPLE_QUESTIONS } from "./ai/sample-questions";
import { getStore } from "./db";
import { caseDetail, findDocument, listCases, listDocuments, vendorDetail } from "./entities";
import { getModule, scalar } from "./modules";

/**
 * Framework-neutral request handler. A host mounts it from a single catch-all
 * route: `GET/POST/DELETE /api/procurement/[...slug]`. Every route except the
 * login endpoints requires a signed-in principal, and every data query runs
 * inside that principal's row-level-security context.
 */

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers } });
}

function fail(message: string, status = 400, code?: string, headers: Record<string, string> = {}): Response {
  return json({ error: message, ...(code ? { code } : {}) }, status, headers);
}

function describeScope(principal: Principal): string {
  if (principal.scope.all) return "All departments";
  if (principal.scope.departments.length) return `Department: ${principal.scope.departments.join(", ")}`;
  if (principal.scope.areas.length) return `Area: ${principal.scope.areas.join(", ")}`;
  return "No procurement records";
}

function sessionUser(principal: Principal): SessionUser {
  return {
    id: principal.id,
    username: principal.username,
    name: principal.name,
    role: principal.role,
    roleLabel: ROLE_DEFINITIONS[principal.role].label,
    designation: principal.designation,
    departmentId: principal.departmentId,
    scopeSummary: describeScope(principal),
    permissions: principal.permissions,
    views: VIEW_IDS.filter((id) => principal.permissions.includes(`view:${id}` as Permission)),
  };
}

function info(): DatasetInfo {
  const store = getStore();
  return {
    synthetic: true,
    label: "Advait synthetic GeM-style procurement dataset",
    asOf: store.asOf,
    tables: store.tables.length,
    cases: scalar("SELECT COUNT(*) FROM procurement_cases"),
    documents: scalar("SELECT COUNT(*) FROM document_metadata"),
    documentsOnDisk: existsSync(store.documentsDir),
    disclaimer: "SYNTHETIC DEMO DATA. Every vendor, officer, identifier, price and document is fictitious and is not an official GeM document or SECL record.",
  };
}

function filtersFrom(params: URLSearchParams): CaseFilters {
  const get = (key: string) => params.get(key) || undefined;
  return {
    q: get("q"),
    stage: get("stage"),
    status: get("status"),
    risk: get("risk"),
    department: get("department"),
    category: get("category"),
    scenario: get("scenario"),
    drill: get("drill"),
    sort: get("sort"),
    limit: params.get("limit") ? Number(params.get("limit")) : undefined,
    offset: params.get("offset") ? Number(params.get("offset")) : undefined,
  };
}

async function pdfResponse(documentId: string, principal: Principal, requestId: string): Promise<Response> {
  const found = findDocument(documentId);
  if (!found) return fail("Document not found", 404);
  const root = getStore().documentsDir;
  const resolved = path.resolve(found.path);
  if (!resolved.startsWith(root + path.sep)) return fail("Document path rejected", 403);
  if (!existsSync(resolved)) return fail("Document file is not available on this server", 404);
  recordAudit(principal, "document.view", { requestId, resource: `document:${documentId}`, details: { caseId: found.ref.caseId, type: found.ref.docType } });
  const bytes = await readFile(resolved);
  return new Response(new Uint8Array(bytes), {
    headers: { "Content-Type": "application/pdf", "Content-Disposition": `inline; filename="${found.ref.documentId}.pdf"`, "Cache-Control": "private, max-age=300" },
  });
}

function sameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  const allowed = (process.env.PROCUREMENT_ALLOWED_ORIGINS ?? "").split(",").map((o) => o.trim()).filter(Boolean);
  return origin === new URL(request.url).origin || allowed.includes(origin);
}

function clientIp(request: Request): string | null {
  return request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
}

const MODULE_VIEWS = new Set(["overview", "tenders", "evaluation", "finance", "workflow", "contracts", "delivery", "vendors", "audit"]);

function sse(events: AsyncGenerator<AiEvent>, signal: AbortSignal): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      try {
        for await (const event of events) {
          if (signal.aborted) break;
          controller.enqueue(encoder.encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`));
        }
      } catch {
        controller.enqueue(encoder.encode(`event: error\ndata: ${JSON.stringify({ type: "error", code: "internal_error", message: "The stream failed." })}\n\n`));
      } finally {
        controller.close();
      }
    },
    cancel() {
      void events.return(undefined);
    },
  });
  return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-store, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" } });
}

function llmErrorResponse(error: unknown): Response {
  if (error instanceof LlmServiceError) return fail(error.message, error.status, error.code);
  return fail("TattvaAI could not complete this request.", 500, "internal_error");
}

export async function handleProcurementRequest(request: Request, slug: string[] = [], identity: IdentityProvider = getIdentityProvider()): Promise<Response> {
  const url = new URL(request.url);
  const [head, second, third, fourth] = slug.map(decodeURIComponent);
  const requestId = crypto.randomUUID();

  try {
    if (request.method !== "GET" && request.method !== "HEAD" && !sameOrigin(request)) return fail("Cross-origin request rejected", 403, "bad_origin");

    // ── Authentication endpoints ─────────────────────────────
    if (head === "auth") {
      if (second === "login" && request.method === "POST") {
        const body = (await request.json().catch(() => null)) as { username?: string; password?: string } | null;
        const username = String(body?.username ?? "").trim().toLowerCase();
        const key = `${clientIp(request) ?? "local"}:${username}`;
        if (!username || !body?.password) return fail("Username and password are required", 400);
        if (loginThrottled(key)) return fail("Too many failed attempts. Wait a few minutes and try again.", 429, "throttled");
        const principal = identity.authenticate(username, String(body.password));
        if (!principal) {
          noteLoginFailure(key);
          recordAudit({ id: username || "unknown", role: "anonymous" }, "auth.login_failed", { requestId, outcome: "denied", details: { ip: clientIp(request) } });
          return fail("Sign-in failed. Check the username and password.", 401, "bad_credentials");
        }
        clearLoginFailures(key);
        const cookie = createSession(principal, clientIp(request));
        recordAudit(principal, "auth.login", { requestId, details: { provider: principal.provider } });
        return json({ user: sessionUser(principal) }, 200, { "Set-Cookie": sessionCookieHeader(cookie) });
      }
      if (second === "hints" && request.method === "GET") return json({ users: identity.listLoginHints?.() ?? [] });
      const session = readSession(request.headers.get("cookie"), identity);
      if (second === "me" && request.method === "GET") return session ? json({ user: sessionUser(session.principal) }) : json({ user: null });
      if (second === "logout" && request.method === "POST") {
        if (session) {
          revokeSession(session.sessionId);
          recordAudit(session.principal, "auth.logout", { requestId });
        }
        return json({ ok: true }, 200, { "Set-Cookie": clearSessionCookieHeader() });
      }
      return fail("Not found", 404);
    }

    // ── Everything else needs a principal ─────────────────────
    const session = readSession(request.headers.get("cookie"), identity);
    if (!session) return fail("Sign in to continue", 401, "unauthenticated");
    const { principal } = session;
    const need = (permission: Permission) => {
      if (!hasPermission(principal, permission)) {
        recordAudit(principal, "access.denied", { requestId, outcome: "denied", resource: url.pathname, details: { required: permission } });
        throw new AuthorizationError(`Your role does not include ${permission}`);
      }
    };

    return await runWithContext({ principal, requestId }, async (): Promise<Response> => {
      // ── TattvaAI ───────────────────────────
      if (head === "tattva") {
        need("view:tattva");
        need("ai:query");
        if (request.method === "POST" && (second === "stream" || second === "ask")) {
          const body = (await request.json().catch(() => null)) as { question?: string; conversationId?: string; caseId?: string } | null;
          const question = body?.question?.trim();
          if (!question) return fail("A question is required", 400);
          if (question.length > 1500) return fail("Question is too long", 400);
          const agent = getDomainAgent("tender");
          let provider;
          try {
            provider = getLlmProvider();
          } catch (error) {
            recordAudit(principal, "ai.error", { requestId, outcome: "error", details: { code: error instanceof LlmServiceError ? error.code : "internal" } });
            return llmErrorResponse(error);
          }
          const agentRequest = { question, principal, provider, tools: agent.tools, conversationId: body?.conversationId, selectedCaseId: body?.caseId ?? null, requestId, signal: request.signal };
          if (second === "ask") {
            try {
              return json({ answer: await askOnce(agentRequest) });
            } catch (error) {
              return llmErrorResponse(error);
            }
          }
          return sse(runAgent(agentRequest), request.signal);
        }
        if (request.method === "GET" && second === "suggestions") return json({ groups: SAMPLE_QUESTIONS });
        if (request.method === "GET" && second === "conversations" && !third) return json({ conversations: listConversations(principal.id) });
        if (request.method === "GET" && second === "conversations" && third && fourth === "messages") return json({ messages: getMessages(third, principal.id) });
        if (request.method === "DELETE" && second === "conversations" && third) return deleteConversation(third, principal.id) ? json({ ok: true }) : fail("Conversation not found", 404);
        return fail("Not found", 404);
      }

      // ── Administration ─────────────────────────
      if (head === "admin") {
        need("view:admin");
        recordAudit(principal, "admin.view", { requestId, resource: `admin:${second}` });
        if (second === "audit" && third === "verify") {
          need("admin:audit");
          const result = verifyAuditChain();
          recordAudit(principal, "admin.audit_verify", { requestId, details: { valid: result.valid, entries: result.entries } });
          return json(result);
        }
        if (second === "audit") {
          need("admin:audit");
          return json({ entries: listAudit(Number(url.searchParams.get("limit") ?? 100)) });
        }
        if (second === "users") {
          need("admin:users");
          return json({
            provider: identity.id,
            users: (identity.listLoginHints?.() ?? []).map((u) => ({ ...u, permissions: ROLE_DEFINITIONS[u.role].permissions })),
            roles: Object.entries(ROLE_DEFINITIONS).map(([id, def]) => ({ id, label: def.label, summary: def.summary, permissions: def.permissions })),
          });
        }
        if (second === "usage") return json(usageSummary());
        if (second === "integrations") return json({ connectors: getConnectorStatuses() });
        if (second === "ai-health") {
          const config = readAiConfig();
          try {
            const provider = getLlmProvider();
            const health = provider instanceof OpenAIResponsesProvider ? await provider.healthCheck() : { ok: true, model: provider.model, detail: "Custom provider installed." };
            return json({ configured: true, ...health, embeddingModelConfigured: Boolean(config.embeddingModel) });
          } catch (error) {
            return json({ configured: false, ok: false, detail: error instanceof Error ? error.message : "Not configured", embeddingModelConfigured: Boolean(config.embeddingModel) });
          }
        }
        if (second === "database") {
          const row = getAppDb().prepare("SELECT COUNT(*) AS n FROM sessions").get() as { n: number };
          return json({ activeSessionRows: row.n, scopeRules: getStore().scopeRules.length, masterTables: getStore().masterTables });
        }
        return fail("Not found", 404);
      }

      if (request.method !== "GET") return fail("Method not allowed", 405);

      switch (head) {
        case "info":
          return json(info());
        case "modules": {
          if (!second || !MODULE_VIEWS.has(second)) return fail("Unknown module", 404);
          need(`view:${second}` as Permission);
          const view = getModule(second);
          return view ? json(view) : fail("Unknown module", 404);
        }
        case "cases": {
          need("view:cases");
          if (second) {
            const detail = caseDetail(second);
            if (!detail) return fail("Case not found", 404);
            recordAudit(principal, "record.view", { requestId, resource: `case:${second}` });
            return json(detail);
          }
          return json(listCases(filtersFrom(url.searchParams)));
        }
        case "vendors": {
          need("view:vendors");
          const detail = second ? vendorDetail(second) : null;
          return detail ? json(detail) : fail("Vendor not found", 404);
        }
        case "documents": {
          need("view:documents");
          if (second && third === "file") return pdfResponse(second, principal, requestId);
          const p = url.searchParams;
          return json(listDocuments({ q: p.get("q") || undefined, type: p.get("type") || undefined, limit: p.get("limit") ? Number(p.get("limit")) : undefined, offset: p.get("offset") ? Number(p.get("offset")) : undefined }));
        }
        default:
          return fail("Not found", 404);
      }
    });
  } catch (error) {
    if (error instanceof AuthorizationError) return fail(error.message, 403, "forbidden");
    const message = error instanceof Error ? error.message : "Unexpected error";
    return fail(`Procurement service error: ${message}`, 503);
  }
}
