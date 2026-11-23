# Architecture

One modular monolith, mountable inside the AdvaitSI console. No microservices.

```
Browser (React workspace)
   │  cookie session, same-origin fetch, SSE for TattvaAI
   ▼
/api/procurement/[...slug]            ← one route file; handler is framework-neutral
   │  authenticate → authorise → run inside request context (principal)
   ▼
┌───────────────────────────── server/ ─────────────────────────────┐
│ platform/   identity · rbac · context · audit-log · app-db · connectors
│ ai/         config · provider (OpenAI Responses) · prompt · tools · agent · ledger
│             sql-guard · schema-catalog (ai_* views) · conversations · domain-registry
│ documents/  ingestion, extraction, chunking, hybrid retrieval, version diff
│ modules.ts, entities.ts, drills.ts   dashboards, case/vendor detail (SQL over scoped tables)
│ db.ts       CSV → SQLite store + row-level security + ai_* views
└────────────────────────────────────────────────────────────────────┘
   │                                   │
   ▼ read-only, scoped                 ▼ writable
procurement store (in-memory SQLite)    app db (.data/tender-intelligence.db)
 76 tables + temp security views         sessions · conversations · ai_usage · audit_log
 + ai_* curated views
   │
   ▼ documents index (.data/documents.db): pages, chunks, FTS5, optional embeddings
```

## Data flow for a TattvaAI question
1. `POST /tattva/stream` → session → `view:tattva` + `ai:query`.
2. `runAgent` builds instructions (as-of date, user, scope, selected case, previous-turn memo) and calls the model through `LlmProvider`.
3. The model requests tools. Each call is checked against the user's permissions, executed inside the request context (row-level security applies), recorded in the audit log, stored in the evidence ledger, and returned to the model as compact JSON with evidence ids.
4. The final text is checked: citations against the ledger, `[[table:R#]]` markers against stored results, figures against retrieved numbers. Tables are rendered from stored results, not from model text.
5. The answer, its tool trace and token usage are stored in the user's conversation and streamed to the browser.

## Replaceable parts
| Concern | Today | Replace with |
|---|---|---|
| Model | `OpenAIResponsesProvider` | any `LlmProvider` |
| Procurement store | in-memory SQLite loaded from CSV | PostgreSQL behind the same table/view names (port `db.ts`; SQL uses SQLite date functions) |
| Row-level security | temp views + request-scoped SQL functions | PostgreSQL RLS policies |
| Document index | SQLite FTS5 (+ float32 vectors) | pgvector |
| Identity | `DemoIdentityProvider` | console SSO provider |
| Connectors | contract + status, only the synthetic dataset connected | GeM / SAP / e-Office adapters |

## Why SQLite now
It lets the product run anywhere with no infrastructure and keeps every query reproducible for tests. It is a deliberate stepping stone: the row-level security, tool layer and SQL guard are written against table and view names, not against SQLite, and a PostgreSQL port is listed as outstanding work in the README.
