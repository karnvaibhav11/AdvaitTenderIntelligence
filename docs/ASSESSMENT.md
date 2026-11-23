# Initial assessment (Phase 1)

Scope: this repository, the sibling synthetic dataset `ADVAITSI_GEM_SYNTHETIC_PROCUREMENT`, and the master project `ai-gov-platform`, inspected **read-only**. Findings are from the code and data as found; the reference figures in the brief (for example 2,969 bids) describe an earlier dataset, not this one.

## 1. What already worked
- **Dataset.** 76 relational CSV tables, 1,000 cases, 13,185 PDFs with a manifest, and a generator with its own validator. 387 further checks run by `npm run audit:data` found **no critical defects and no failed checks** once two false alarms were explained (below).
- **Master platform.** A working OpenAI-backed TattvaAI in `advaitsi/` (small/large model tiers via `OPENAI_MODEL` and `OPENAI_MODEL_LARGE`, an SQL agent, grounding checks, RBAC and SSO into the console), a Prisma backend with its own `TATTVA_*` provider settings, and a console shell that embeds the app in an iframe.
- **The previous version of this module.** A CSV dashboard and a fixed-intent chatbot. Its screens and SQL were reused; the chatbot was retired because the brief forbids a fixed-intent assistant as the primary one.

## 2. What was incomplete
- Dashboards had no authentication; the role switcher only changed navigation.
- TattvaAI could answer only about 15 phrasings.
- Document text was never read from the PDFs; only pre-extracted fields existed in the dataset.
- No audit trail, no conversation memory, no cost tracking.

## 3. What was missing
PostgreSQL, vector search, OCR, real authorization, tamper-evident audit, a benchmark, platform integration contracts. Of these, this pass added authorization, audit, benchmark, retrieval (keyword) and contracts. **Still missing:** PostgreSQL/pgvector, an OCR engine, embeddings, live connectors, tender-preparation features, exports beyond CSV, load tests.

## 4. What could be reused
Dataset and its generator; the master's OpenAI conventions (`OPENAI_MODEL`); the dashboards' SQL and drill-down design; the console's iframe/SSO pattern.

## 5. What had to be redesigned
- The data layer: every query now runs inside a request principal with row-level security in the database layer (see [Security](SECURITY.md)).
- TattvaAI: from intent rules to a tool-calling agent behind a provider abstraction, with an evidence ledger and citation checks.
- Document access: from pre-extracted fields to ingestion of the PDFs themselves with page-level evidence.

## 6. Synthetic data that needs additional generation
Not generated in this pass. The data-quality report ([report](data-quality/DATA_QUALITY_REPORT.md), [JSON](data-quality/data-quality-report.json)) scores the 49 risk scenarios in the brief: **20 covered, 2 thin, 27 absent**, with a concrete list of records, tables and PDFs to add per scenario.

Highest-value gaps: missing approval trails and approval bypass above the value threshold; repeated corrigenda (2+ per tender: none exist); contract termination and repeated extensions (none); similar vendor identities; conflicting eligibility clauses; price deviations beyond ±30%; true duplicate invoices; advance payments; excess delivery; scanned/image PDFs and rotated or noisy documents for OCR (the corpus is native-text only).

Other honest findings:
- **Volumes are below the targets** (for example 1,019 tenders against 2,000, 240 vendors against 1,000, 4,357 approvals against 12,000).
- **665 of 4,357 approval steps (15%) were approved by the officer who raised the requisition.** That rate looks like a generator artefact, not a designed segregation-of-duties scenario. Treat IND-06 with that caveat; a genuine SoD test set is absent.
- **Equal-amount invoices against one PO** (183 groups) are staged instalments, so duplicate-invoice detection has no true positives to test against.
- **Gross receipts exceed ordered quantity on 217 POs**, always by exactly the rejected quantity re-supplied as a replacement lot and counted again. Net of rejections nothing is over-delivered; the report's check is written that way.
- **Four POs have no contract**: all are dated within four days of the as-of date, so signing is pending, not missing.
- Low-value POs (up to ₹5 lakh) have fewer approval steps. This looks like delegation by value, so it is treated as ambiguous, not as a bypass.

## 7. What prevented integration into AdvaitSI
- No stable module boundary: addressed by `src/modules/procurement/` with a registration descriptor and typed platform contracts.
- Authentication assumed nothing about the host: addressed with an `IdentityProvider` seam (`setIdentityProvider`).
- The master's current constraint (do not modify it) means the card, route and SSO wiring are documented in [Integration](INTEGRATION.md), not applied.
- Dependency and runtime requirements for the master: Node 22.5+, and the packages listed there.

## 8. What prevents reliable LLM-based reasoning
- **No live model has been run.** There was no `OPENAI_API_KEY` on this machine, so answer quality, tool-selection accuracy and latency/cost are unmeasured. `npm run eval:ai` will measure them.
- SQLite has no statement timeout, so model SQL is constrained by shape rather than time.
- Keyword-only retrieval until embeddings exist; BM25 ties on boilerplate repeated across thousands of documents, so document questions should name a tender.
- Data gaps above limit what risk questions can show, and one (IND-06) is dominated by an artefact.
- Several ground-truth answers depend on definitions (delayed, active, high value, late milestone). They are in `business-rules.ts` and are offered to the model through a tool, but an organisation's real definitions will differ.
