# AdvaitSI Tender & Procurement Intelligence

An independent, integration-ready procurement intelligence domain for AdvaitSI, with an OpenAI-powered TattvaAI analyst. It runs standalone here and is designed to mount in the console at `/console/tender-intelligence`. It does **not** modify the `ai-gov-platform` master project.

> **All data is synthetic.** Vendors, officers, identifiers, prices and documents come from `../ADVAITSI_GEM_SYNTHETIC_PROCUREMENT` and are not official GeM or SECL records.

Documents: [Architecture](docs/ARCHITECTURE.md) · [Security](docs/SECURITY.md) · [Integration into the console](docs/INTEGRATION.md) · [Document pipeline](src/modules/procurement/server/documents/README.md) · [Data quality report](docs/data-quality/DATA_QUALITY_REPORT.md) · [Assessment](docs/ASSESSMENT.md)

## What is genuinely implemented

| Area | Status |
|---|---|
| TattvaAI (OpenAI Responses API) | **Implemented, not yet run against the live API.** Tool-calling agent with 20 tools, streaming, multi-turn memory, evidence-ledger citations, SQL guard, per-user conversations, usage and cost tracking. Verified against a local Responses-API test server and a scripted model, never a real model (no key was available) |
| Backend authentication, roles and row-level security | **Implemented and tested** (51 checks): signed sessions, 11 roles, department/area scope enforced in the data layer, permission-gated financial data, fail-closed tables |
| Tamper-evident audit log | **Implemented and tested**: append-only, hash-chained, verifiable from the Administration view |
| Nine intelligence workspaces, register, document viewer | Implemented (executive, tenders, bid evaluation, finance, workflow, contracts, delivery, vendors, audit) with drill-down from every figure |
| Document intelligence | **Implemented**: all 13,185 PDFs ingested (18,155 pages, 48,345 chunks, 381,236 table rows), keyword retrieval, clause lookup with page numbers, version comparison, injection flagging. **Not implemented:** OCR engine (none is needed for this corpus: every PDF has a text layer) and embeddings (need `OPENAI_EMBEDDING_MODEL`; never generated here) |
| Golden benchmark | 219 questions with database-derived ground truth; tool layer scores 203/203 offline. **Model answer quality is unmeasured** until `npm run eval:ai` is run with OpenAI configured |
| Platform contracts | Typed contracts, module registration descriptor, connector status registry. Only the synthetic dataset is connected |

## What is not implemented (and why it matters)
- **PostgreSQL / pgvector.** The store is in-memory SQLite loaded from CSV. The row-level security, tools and SQL guard are written against table and view names, but the dashboard SQL uses SQLite functions, so a port is real work. Model SQL has no statement timeout until then.
- **OCR.** No OCR engine is integrated, so scanned documents would be flagged `needs_ocr` and left unread.
- **Embeddings / semantic search.** Keyword (BM25) retrieval only until an embedding model is configured and `npm run ingest:docs -- --embed` is run.
- **Production authentication.** The demo identity provider is for demonstration. The console must supply its own.
- **Live integrations** (GeM, SAP, e-Office, DMS, inspection systems): contracts and status only.
- **Reports and exports** beyond CSV download of any table; no Excel/PDF report generator.
- **Tender preparation** (requirement/specification analysis, clause drafting) and personalised tender recommendations.
- **Additional synthetic data generation.** The existing dataset was audited, not extended. See the data quality report for scenarios that are thin or absent.
- **Load testing** and a production benchmark report.

## Run it

Requires Node.js 22.5+ (developed on 24) and the sibling synthetic dataset.

```sh
npm install
cp .env.example .env.local   # set OPENAI_API_KEY and OPENAI_MODEL to enable TattvaAI
npm run ingest:docs          # one-off, about 2 minutes: builds .data/documents.db for document search
npm run dev                  # http://localhost:3000  (use -p to choose another port)
```

Sign in with a demonstration account (the sign-in page offers only `admin`, which can open every dashboard; the other demonstration officers, for example `cmd`, `procurement.head`, `auditor` and the data-less `sysadmin`, remain available through the API for role and scope testing). The passphrase is `DEMO_LOGIN_PASSWORD`, default `advaitsi-demo` outside production. Without OpenAI configured, TattvaAI shows a controlled "not configured" message and produces no answers. The dashboards work regardless.

Set the model deliberately: `OPENAI_MODEL` has no default. Check it from **Administration → AI service**.

## Verify

```sh
npm run typecheck
npm run verify            # data layer: CSV fidelity, modules, drill-downs
npm run verify:security   # 51 checks: row-level security, sessions, authorization, SQL guard, audit chain
npm run verify:ai         # 25 checks: agent loop, citations, tool authorisation, OpenAI provider, document tools, injection
npm run verify:docs       # 48 checks: extraction, retrieval, permissions, version diff
npm run eval:tools        # golden benchmark through the tool layer (offline)
npm run eval:ai           # golden benchmark through the real model (needs OpenAI configured)
npm run audit:data        # data-quality and scenario-coverage report
npm run build
```

`verify:ai` and `verify:security` prove plumbing, authorisation and failure handling. They do **not** show that a real model answers well. The `ScriptedProvider` and the local Responses-API server used in them are test doubles and are not wired into the product.

## Layout
```
src/app/                         page + one API route file
src/modules/procurement/         the integrable module (copy this folder)
  module.ts                      console registration (card, route, API)
  shared/                        wire types, platform contracts
  server/platform/               identity, rbac, request context, audit log, app db, connectors
  server/ai/                     provider, prompt, tools, agent, evidence ledger, SQL guard
  server/documents/              ingestion, extraction, retrieval
  server/                        db (CSV → SQLite + RLS), modules, entities, handler
  client/                        workspace, views, drawer, TattvaAI chat, admin
scripts/                         verification, benchmark generation and evaluation, data audit
benchmark/                       golden questions and results
docs/                            architecture, security, integration, assessment, data quality
```
