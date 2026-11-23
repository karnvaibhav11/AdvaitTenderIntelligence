/**
 * Security verification: row-level security, backend authorization, session
 * integrity, SQL guard, audit-log tamper evidence and conversation isolation.
 * Run with `npm run verify:security`.
 */
import { assert, call, check, freshAppDb, login, summary, PASSWORD } from "./test-helpers";
import { checkAgentSql, runAgentSql } from "../src/modules/procurement/server/ai/sql-guard";
import { CORE_TOOLS, toolsFor } from "../src/modules/procurement/server/ai/tools";
import { getScopedStore, getStore } from "../src/modules/procurement/server/db";
import { getAppDb, openAppDb } from "../src/modules/procurement/server/platform/app-db";
import { listAudit, recordAudit, verifyAuditChain } from "../src/modules/procurement/server/platform/audit-log";
import { runWithContext } from "../src/modules/procurement/server/platform/context";
import { DemoIdentityProvider } from "../src/modules/procurement/server/platform/identity";
import { segregationViolation } from "../src/modules/procurement/server/platform/rbac";

async function main() {
  freshAppDb();
  const idp = new DemoIdentityProvider();
  const store = getStore();
  const as = (username: string) => idp.authenticate(username, PASSWORD)!;
  const scoped = <T,>(username: string, fn: () => T): T => runWithContext({ principal: as(username), requestId: "t" }, fn);
  const count = (username: string, sql: string) => scoped(username, () => Number(getScopedStore().query<{ n: number }>(sql)[0].n));

  console.log("Row-level security");
  await check("no table is left without a scope rule or master declaration", () => {
    const denied = store.scopeRules.filter((r) => r.rule.startsWith("denied"));
    assert.deepEqual(denied.map((r) => r.table), []);
    assert.equal(store.scopeRules.length, store.tables.length);
  });
  await check("scoped store refuses to run without an authenticated context", () => assert.throws(() => getScopedStore().query("SELECT 1"), /authenticated/));
  await check("organisation-wide roles see all 1000 cases", () => {
    assert.equal(count("cmd", "SELECT COUNT(*) n FROM procurement_cases"), 1000);
    assert.equal(count("procurement.head", "SELECT COUNT(*) n FROM procurement_cases"), 1000);
  });
  await check("department-scoped role sees only its department's cases and every linked table follows", () => {
    const total = count("gm.mechanical", "SELECT COUNT(*) n FROM procurement_cases");
    assert.ok(total > 0 && total < 1000, `cases=${total}`);
    assert.equal(count("gm.mechanical", "SELECT COUNT(*) n FROM procurement_cases WHERE department_id <> 'DEP-MECH'"), 0);
    for (const table of ["requisitions", "tender_master", "purchase_orders", "contract_master", "invoice_register", "approvals", "document_metadata", "bidder_submissions", "delivery_milestones", "inspection_records"]) {
      const outside = count("gm.mechanical", `SELECT COUNT(*) n FROM ${table} t WHERE NOT EXISTS (SELECT 1 FROM main.procurement_cases c WHERE c.department_id = 'DEP-MECH' AND (
          ${table === "requisitions" || table === "tender_master" || table === "document_metadata" ? "c.case_id = t.case_id" : table === "approvals" ? "c.requisition_id = t.requisition_id" : table === "bidder_submissions" ? "c.tender_id = t.tender_id OR EXISTS (SELECT 1 FROM main.tender_master tm WHERE tm.tender_id = t.tender_id AND tm.case_id = c.case_id)" : "c.po_number = t.po_number"}))`);
      assert.equal(outside, 0, `${table} leaks ${outside} rows outside DEP-MECH`);
    }
  });
  await check("area-scoped role sees only its area", () => {
    const area = as("area.gm").scope.areas[0];
    assert.equal(count("area.gm", `SELECT COUNT(*) n FROM procurement_cases WHERE area_id <> '${area}'`), 0);
    assert.ok(count("area.gm", "SELECT COUNT(*) n FROM procurement_cases") > 0);
  });
  await check("administrator sees no procurement records at all", () => {
    for (const rule of store.scopeRules.filter((r) => r.key)) assert.equal(count("sysadmin", `SELECT COUNT(*) n FROM "${rule.table}"`), 0, rule.table);
  });
  await check("financial bids are hidden from technical evaluators; payments hidden without data:payments", () => {
    assert.equal(count("technical.evaluator", "SELECT COUNT(*) n FROM financial_quotes"), 0);
    assert.equal(count("technical.evaluator", "SELECT COUNT(*) n FROM comparative_statements"), 0);
    assert.equal(count("technical.evaluator", "SELECT COUNT(*) n FROM invoice_register"), 0);
    assert.equal(count("tender.officer", "SELECT COUNT(*) n FROM payment_register"), 0);
    assert.ok(count("finance.officer", "SELECT COUNT(*) n FROM invoice_register") > 0);
  });
  await check("scoped derived views (v_case, ai_*) inherit the scope", () => {
    assert.equal(count("gm.mechanical", "SELECT COUNT(*) n FROM v_case"), count("gm.mechanical", "SELECT COUNT(*) n FROM procurement_cases"));
    assert.equal(count("gm.mechanical", "SELECT COUNT(*) n FROM ai_cases WHERE department_id <> 'DEP-MECH'"), 0);
    assert.equal(count("technical.evaluator", "SELECT COUNT(*) n FROM ai_bids WHERE quoted_total IS NOT NULL"), 0);
  });

  console.log("\nAuthentication and sessions");
  await check("requests without a session are rejected", async () => {
    for (const path of ["modules/overview", "cases", "documents", "info", "tattva/conversations", "admin/audit"]) assert.equal((await call("GET", path)).status, 401, path);
    assert.equal((await call("POST", "tattva/stream", { body: { question: "hi" } })).status, 401);
  });
  await check("wrong password is rejected and does not reveal whether the user exists", async () => {
    const a = await call("POST", "auth/login", { body: { username: "cmd", password: "nope" } });
    const b = await call("POST", "auth/login", { body: { username: "no.such.user", password: "nope" } });
    assert.equal(a.status, 401);
    assert.equal(b.status, 401);
    assert.equal((await a.json()).error, (await b.json()).error);
  });
  await check("repeated failures are throttled", async () => {
    let status = 0;
    for (let i = 0; i < 7; i++) status = (await call("POST", "auth/login", { body: { username: "throttle.test", password: "x" } })).status;
    assert.equal(status, 429);
  });
  await check("forged or tampered session cookies are rejected", async () => {
    const good = await login("cmd");
    assert.equal((await call("GET", "info", { cookie: good })).status, 200);
    const tampered = good.replace(/\.[^.]+$/, ".AAAA");
    assert.equal((await call("GET", "info", { cookie: tampered })).status, 401);
    const forged = `adv_session=${Buffer.from(JSON.stringify({ sid: "x", sub: "ADV-OFF-0001", exp: Date.now() + 1e6 })).toString("base64url")}.${"A".repeat(43)}`;
    assert.equal((await call("GET", "info", { cookie: forged })).status, 401);
  });
  await check("logout revokes the session server-side", async () => {
    const cookie = await login("auditor");
    assert.equal((await call("GET", "info", { cookie })).status, 200);
    assert.equal((await call("POST", "auth/logout", { cookie })).status, 200);
    assert.equal((await call("GET", "info", { cookie })).status, 401);
  });
  await check("cross-origin state-changing requests are rejected", async () => {
    const response = await call("POST", "auth/login", { body: { username: "cmd", password: PASSWORD }, origin: "https://evil.example" });
    assert.equal(response.status, 403);
  });

  console.log("\nBackend authorization");
  await check("each role can open only the views its permissions grant", async () => {
    const evaluator = await login("technical.evaluator");
    assert.equal((await call("GET", "modules/tenders", { cookie: evaluator })).status, 200);
    assert.equal((await call("GET", "modules/finance", { cookie: evaluator })).status, 403);
    assert.equal((await call("GET", "modules/audit", { cookie: evaluator })).status, 403);
    const admin = await login("sysadmin");
    assert.equal((await call("GET", "modules/overview", { cookie: admin })).status, 403);
    assert.equal((await call("GET", "cases", { cookie: admin })).status, 403);
    assert.equal((await call("GET", "tattva/conversations", { cookie: admin })).status, 403);
    const cmd = await login("cmd");
    assert.equal((await call("GET", "admin/audit", { cookie: cmd })).status, 403);
    assert.equal((await call("GET", "admin/audit", { cookie: admin })).status, 200);
  });
  await check("the sign-in admin opens every dashboard, the register and administration", async () => {
    const admin = await login("admin");
    for (const path of ["modules/overview", "modules/finance", "modules/audit", "cases", "admin/audit"]) assert.equal((await call("GET", path, { cookie: admin })).status, 200, path);
  });
  await check("record and document access is limited to the user's department", async () => {
    const mech = await login("gm.mechanical");
    const other = store.query<{ case_id: string }>("SELECT case_id FROM procurement_cases WHERE department_id <> 'DEP-MECH' LIMIT 1")[0].case_id;
    const own = store.query<{ case_id: string }>("SELECT case_id FROM procurement_cases WHERE department_id = 'DEP-MECH' LIMIT 1")[0].case_id;
    assert.equal((await call("GET", `cases/${other}`, { cookie: mech })).status, 404);
    assert.equal((await call("GET", `cases/${own}`, { cookie: mech })).status, 200);
    const foreignDoc = store.query<{ document_id: string }>("SELECT document_id FROM document_metadata WHERE case_id = ? LIMIT 1", [other])[0].document_id;
    assert.equal((await call("GET", `documents/${foreignDoc}/file`, { cookie: mech })).status, 404);
    const list = (await (await call("GET", "documents?limit=200", { cookie: mech })).json()) as { rows: Array<{ caseId: string }> };
    assert.ok(list.rows.every((r) => r.caseId !== other));
  });
  await check("module aggregates differ by scope (no cross-scope cache leakage)", async () => {
    const cmd = await login("cmd");
    const mech = await login("gm.mechanical");
    const a = (await (await call("GET", "modules/overview", { cookie: cmd })).json()) as { kpis: Array<{ label: string; value: number }> };
    const b = (await (await call("GET", "modules/overview", { cookie: mech })).json()) as { kpis: Array<{ label: string; value: number }> };
    const c = (await (await call("GET", "modules/overview", { cookie: cmd })).json()) as { kpis: Array<{ label: string; value: number }> };
    assert.equal(a.kpis[0].value, 1000);
    assert.ok(b.kpis[0].value < 1000 && b.kpis[0].value > 0);
    assert.equal(c.kpis[0].value, 1000);
  });
  await check("conversations are private to their owner", async () => {
    const { ScriptedProvider } = await import("./test-helpers");
    const { setLlmProviderForTests } = await import("../src/modules/procurement/server/ai/provider");
    setLlmProviderForTests(new ScriptedProvider([{ text: "Hello." }]));
    const a = await login("cmd");
    const b = await login("director.finance");
    const answer = (await (await call("POST", "tattva/ask", { cookie: a, body: { question: "hello" } })).json()) as { answer: { conversationId: string } };
    const id = answer.answer.conversationId;
    assert.equal(((await (await call("GET", `tattva/conversations/${id}/messages`, { cookie: a })).json()) as { messages: unknown[] }).messages.length, 2);
    assert.equal(((await (await call("GET", `tattva/conversations/${id}/messages`, { cookie: b })).json()) as { messages: unknown[] }).messages.length, 0);
    assert.equal((await call("DELETE", `tattva/conversations/${id}`, { cookie: b })).status, 404);
    const reuse = await call("POST", "tattva/ask", { cookie: b, body: { question: "hi", conversationId: id } });
    assert.notEqual(reuse.status, 200);
    setLlmProviderForTests(undefined);
  });
  await check("segregation-of-duties rule rejects the same preparer and approver", () => {
    assert.ok(segregationViolation("ADV-OFF-0001", "ADV-OFF-0001"));
    assert.equal(segregationViolation("ADV-OFF-0001", "ADV-OFF-0002"), null);
    assert.equal(segregationViolation(null, "ADV-OFF-0002"), null);
  });

  console.log("\nSQL guard (model-written SQL)");
  const rejected: Array<[string, string]> = [
    ["DROP TABLE ai_cases", "drop"],
    ["SELECT * FROM ai_cases; DELETE FROM procurement_cases", "multi statement"],
    ["SELECT * FROM ai_cases /* ; */ ; SELECT 1", "comment-hidden second statement"],
    ["DELETE FROM ai_cases", "delete"],
    ["UPDATE ai_cases SET status = 'x'", "update"],
    ["SELECT * FROM procurement_cases", "base table"],
    ["SELECT * FROM vendor_master", "base table 2"],
    ["SELECT * FROM sqlite_master", "schema table"],
    ["SELECT * FROM ai_cases UNION SELECT * FROM main.procurement_cases", "schema-qualified base table"],
    ["PRAGMA table_info(ai_cases)", "pragma"],
    ["WITH RECURSIVE r(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM r) SELECT * FROM r", "recursive"],
    ["SELECT * FROM ai_cases a CROSS JOIN ai_bids b", "cross join"],
    ["SELECT * FROM ai_cases a, ai_bids b", "comma join"],
    ["SELECT * FROM ai_cases a JOIN ai_bids b", "join without ON"],
    ["SELECT * FROM ai_cases a JOIN ai_tenders t ON a.case_id = t.case_id JOIN ai_bids b ON b.tender_id = t.tender_id JOIN ai_pos p ON p.case_id = a.case_id", "too many relations"],
    ["SELECT adv_row_ok('x','y') FROM ai_cases", "scope function probe"],
    ["SELECT randomblob(1000000000) FROM ai_cases", "memory bomb"],
    ["SELECT * FROM ai_status_events e JOIN ai_cases c ON c.case_id = e.case_id", "large view joined"],
    [`SELECT ${"x,".repeat(3000)} 1 FROM ai_cases`, "oversized"],
    ["", "empty"],
  ];
  for (const [sql, label] of rejected) {
    await check(`rejects ${label}`, () => scoped("cmd", () => assert.equal(checkAgentSql(sql).ok, false)));
  }
  await check("accepts a normal aggregate over permitted views", () => scoped("cmd", () => assert.equal(checkAgentSql("SELECT department, COUNT(*) AS n FROM ai_cases GROUP BY department").ok, true)));
  await check("string literals containing SQL are treated as data", () => scoped("cmd", () => {
    const result = runAgentSql("SELECT COUNT(*) AS n FROM ai_cases WHERE title = '''; DROP TABLE ai_cases; --'");
    assert.equal(Number(result.rows[0].n), 0);
  }));
  await check("results are row-capped", () => scoped("cmd", () => {
    const result = runAgentSql("SELECT * FROM ai_status_events");
    assert.equal(result.rows.length, 200);
    assert.equal(result.truncated, true);
  }));
  await check("model-run SQL is row-level scoped to the user", () => {
    assert.equal(scoped("cmd", () => Number(runAgentSql("SELECT COUNT(*) AS n FROM ai_cases").rows[0].n)), 1000);
    const mech = scoped("gm.mechanical", () => Number(runAgentSql("SELECT COUNT(*) AS n FROM ai_cases").rows[0].n));
    assert.ok(mech > 0 && mech < 1000);
  });
  await check("the database connection itself refuses writes", () => assert.throws(() => store.query("DELETE FROM vendor_master"), /readonly|read-only|attempt to write/i));
  await check("run_analytical_query is offered only to roles with ai:sql", () => {
    assert.ok(toolsFor(as("cmd"), CORE_TOOLS).some((t) => t.name === "run_analytical_query"));
    assert.ok(!toolsFor(as("tender.officer"), CORE_TOOLS).some((t) => t.name === "run_analytical_query"));
    assert.ok(!toolsFor(as("technical.evaluator"), CORE_TOOLS).some((t) => t.name === "get_invoice_payment_status"));
  });

  console.log("\nAudit log");
  await check("login, access-denied and document events are recorded", () => {
    const actions = new Set(listAudit(500).map((e) => e.action));
    for (const a of ["auth.login", "auth.login_failed", "access.denied", "auth.logout"]) assert.ok(actions.has(a), a);
  });
  await check("the audit chain verifies", () => {
    const result = verifyAuditChain();
    assert.equal(result.valid, true, String(result.reason));
    assert.ok(result.entries > 10);
  });
  await check("audit entries never contain credentials", () => {
    const text = listAudit(500).map((e) => e.details).join(" ");
    assert.ok(!text.includes(PASSWORD));
  });
  await check("UPDATE and DELETE on the audit log are rejected by the database", () => {
    assert.throws(() => getAppDb().prepare("UPDATE audit_log SET outcome = 'success' WHERE seq = 1").run(), /append-only/);
    assert.throws(() => getAppDb().prepare("DELETE FROM audit_log WHERE seq = 1").run(), /append-only/);
  });
  await check("file-level tampering is detected by the hash chain", () => {
    const db = openAppDb(":memory:");
    const actor = { id: "u1", role: "cmd" };
    for (let i = 0; i < 5; i++) recordAudit(actor, "record.view", { resource: `case:${i}` }, db);
    assert.equal(verifyAuditChain(db).valid, true);
    db.exec("DROP TRIGGER audit_log_no_update");
    db.prepare("UPDATE audit_log SET outcome = 'denied' WHERE seq = 3").run();
    const result = verifyAuditChain(db);
    assert.equal(result.valid, false);
    assert.equal(result.firstBrokenSeq, 3);

    const db2 = openAppDb(":memory:");
    for (let i = 0; i < 5; i++) recordAudit(actor, "record.view", { resource: `case:${i}` }, db2);
    db2.exec("DROP TRIGGER audit_log_no_delete");
    db2.prepare("DELETE FROM audit_log WHERE seq = 2").run();
    assert.equal(verifyAuditChain(db2).valid, false);
  });
  await check("secrets in audit details are redacted", () => {
    const entry = recordAudit({ id: "u", role: "cmd" }, "ai.tool", { details: { password: "hunter2", nested: { api_key: "sk-123", ok: "visible" } } });
    assert.ok(!entry.details.includes("hunter2") && !entry.details.includes("sk-123"));
    assert.ok(entry.details.includes("visible"));
  });

  summary("security");
}

void main();
