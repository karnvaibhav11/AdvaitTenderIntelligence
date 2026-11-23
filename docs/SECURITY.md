# Security model

Everything below is enforced on the server. The UI reads the signed-in user to tailor itself and is never trusted to enforce anything.

## Identity and sessions
- `IdentityProvider` (`server/platform/identity.ts`) decides who a user is. The bundled `DemoIdentityProvider` signs in synthetic officers with a shared demo passphrase (`DEMO_LOGIN_PASSWORD`; defaults to `advaitsi-demo` outside production and is **disabled in production unless set**). A host supplies its own provider (console SSO) with `setIdentityProvider()`.
- Sessions are HMAC-signed cookies (`HttpOnly`, `SameSite=Lax`, `Secure` in production) backed by a server-side session row, so logout and expiry are enforced by the server. `SESSION_SECRET` (32+ characters) is required in production.
- Login is throttled per client and username; failures do not reveal whether a user exists.
- State-changing requests must come from the same origin (`PROCUREMENT_ALLOWED_ORIGINS` adds trusted ones).

## Authorization
- Roles and permissions: `server/platform/rbac.ts` (CMD, Director, Functional head, GM, Area GM, Procurement head, Tender officer, Finance officer, Technical evaluator, Internal auditor, Administrator).
- Every API route checks a permission (`view:*`, `ai:query`, `ai:sql`, `admin:*`). Denials are audited.
- **Row-level security in the data layer.** Each request runs inside an async context carrying the principal. SQL functions read it, and every procurement table is shadowed by a filtered view limited to the principal's departments or areas, linked through case, requisition, tender, PO, contract, submission, invoice and document keys. Data permissions (`data:bids_financial`, `data:payments`, `data:budget`) additionally gate the sensitive tables. A table that cannot be tied to a case and is not declared master data is **denied** (fail closed). Because the filter lives under the table names, dashboards, drill-downs, document access and model-written SQL are all scoped without each query needing to remember to filter.
- The scoped store refuses to run without an authenticated context. Only trusted tooling (`getStore()`) is unscoped.
- Caches are keyed by scope so one user's aggregates never serve another.
- Segregation of duties: `segregationViolation()` rejects the same officer preparing and approving a transaction. This product has no write workflows, so it is enforced as a policy function and surfaced as an analytic control exception (IND-06).

## AI safety
- The model gets business tools plus an optional SQL tool. It never sees base tables: only `ai_*` views without tax identifiers, addresses, e-mail addresses, hashes or dataset scenario labels.
- Model-written SQL passes a tokenising guard (single `SELECT`, `ai_*` views only, at most 3 relations, equality `ON`, no comma/cross joins, no recursion, no scope-function probing, size and row caps), then runs on a read-only connection through the same row-level security. `run_analytical_query` is offered only to roles with `ai:sql`.
- Tools a user lacks are not offered, and a call to one is refused and audited.
- Retrieved document text is untrusted evidence: flagged when it looks like instructions and labelled in the prompt as data.
- Citations are validated against an evidence ledger; table references against stored results; unsupported ones are removed and reported. Figures not found in retrieved data raise a warning.
- Requests are stateless (`store:false`); conversation history stays in this application's database, per user.
- The OpenAI key is read from the server environment only, never sent to the browser, logged or placed in request bodies. If OpenAI is unavailable the user sees a controlled error; there is no fake fallback.

## Audit log
`server/platform/audit-log.ts`: append-only, hash-chained SQLite table (`prev_hash` → `hash` over each entry). Triggers reject `UPDATE` and `DELETE`; editing or deleting rows at file level breaks `verifyAuditChain()` from the first altered entry. Entries record logins, denials, AI queries, each tool call, SQL metadata, document views and admin actions. Details hold metadata only and redact secrets. Administrators can verify the chain in the UI.
Limits: a party with full write access to the database file can rewrite the whole chain. Anchor the head hash somewhere the application cannot write (a log service, WORM storage or the platform audit service) to detect that.

## Known gaps
- No statement timeout for model SQL (`node:sqlite` cannot interrupt a running query); joins are constrained instead. PostgreSQL's `statement_timeout` should replace this.
- The demo identity provider is not a production authentication system.
- Encryption at rest, backup, retention and data-residency controls are deployment responsibilities and are not implemented in this module.
