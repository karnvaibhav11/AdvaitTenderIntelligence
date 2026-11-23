# Integrating into the AdvaitSI console

Nothing here modifies `ai-gov-platform`; these are the steps the master team would take.

## 1. Mount the module
Copy `src/modules/procurement/` into the console's `src/modules/`, then add the API route (`src/app/api/procurement/[...slug]/route.ts`, identical to this repository's) and a page at **`/console/tender-intelligence`**:

```tsx
import { ProcurementWorkspace } from "@/modules/procurement";
export default function Page() {
  return <ProcurementWorkspace height="calc(100vh - 64px)" />;
}
```
Dependencies to add: `csv-parse`, `lucide-react`, `openai`, `unpdf`. Node 22.5 or later (24 recommended). All CSS is scoped under `.adv-root`.

## 2. Product-selection card
`tenderIntelligenceModule` (`src/modules/procurement/module.ts`) holds the card title, description, route, API path and required permission. Render it with the same card component as "GM Daily Dashboard" and "Mining Intelligence".

## 3. Sign-in (SSO)
The workspace's built-in login is for the demo. In the console:
```ts
import { setIdentityProvider } from "@/modules/procurement/server/platform/identity";
setIdentityProvider(consoleIdentityProvider); // maps the console session to a Principal
```
A provider implements `authenticate`, `resolve` and optionally `listLoginHints`; map console roles onto the role ids in `rbac.ts` and supply department/area scope from the console's user directory. Pass the signed-in user to `<ProcurementWorkspace user={...} />` to skip the second prompt. The backend still authenticates every request.

## 4. TattvaAI sharing
- The Tender agent is registered in `ai/domain-registry.ts` with its own tools and data views. The shared TattvaAI orchestrator should select the agent by domain and pass the platform user context (`shared/platform-contracts.ts`).
- The Mining agent belongs to the CoalMind codebase. It registers against `DomainAgentRegistration` and must not be given `ai_*` views or procurement tools; the reverse also holds. This repository does not contain or assume the CoalMind implementation.
- The master platform already has an OpenAI integration (`advaitsi/src/lib/openai.ts`, small/large tiers via `OPENAI_MODEL` and `OPENAI_MODEL_LARGE`). This module reads the same `OPENAI_MODEL` variable but also needs `OPENAI_API_KEY`; consolidate provider configuration in the shared service when merging.

## 5. Cross-domain questions
Example: "Are delayed critical spares contributing to equipment downtime?" A future executive orchestrator sends a `CrossDomainQuery` with a `CrossDomainGrant` (explicit, scoped, time-limited). The Tender domain answers only with the fields the grant lists (PO status, planned vs actual delivery dates), never raw tables; the Mining domain does the same for downtime. The orchestrator joins and states limitations. Today `get_operational_impact` returns only procurement-side links (work orders waiting for spares) and says that downtime is not accessible.

## 6. Audit, notifications, observability
- Forward audit entries to the platform audit service through `PlatformAuditEvent` and anchor the chain head hash outside the application database.
- Suggested follow-ups (for example approvals pending more than 14 days) are surfaced as lists. If the platform wants notifications, send `PlatformNotification` with `origin: "suggested_follow_up"` after human confirmation.
- Token usage and latency are stored in `ai_usage`; the Administration view summarises them.

## 7. Connectors
`platform/connectors.ts` defines the connector contract and reports real state. Only the synthetic dataset is connected. GeM, SAP, e-Office, DMS and inspection systems show `not_configured`; implement `Connector` against an authorised interface and call `registerConnector`. Each source must tag its records with a provenance value.
