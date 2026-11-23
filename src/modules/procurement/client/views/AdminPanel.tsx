"use client";

import { useState } from "react";
import { CheckCircle2, ShieldAlert, XCircle } from "lucide-react";
import type { DataTable } from "../../shared/types";
import { useWorkspace } from "../context";
import { DataTableView } from "../DataTableView";
import { useAsync } from "../useAsync";
import { ErrorBlock, LoadingBlock } from "./ModulePanel";

const TABS = ["Audit log", "Users & roles", "AI service", "Data sources"] as const;

function AuditTab() {
  const { api } = useWorkspace();
  const [version, setVersion] = useState(0);
  const [verifying, setVerifying] = useState(false);
  const [verification, setVerification] = useState<{ valid: boolean; entries: number; headHash: string; firstBrokenSeq: number | null; reason: string | null } | null>(null);
  const state = useAsync(() => api.admin("audit?limit=200") as Promise<{ entries: Array<Record<string, string | number | null>> }>, [api, version]);
  if (state.error) return <ErrorBlock message={state.error} />;
  if (!state.data) return <LoadingBlock />;
  const table: DataTable = {
    title: "Audit log (newest first)",
    subtitle: "Append-only and hash-chained. Details hold query metadata, never result rows or secrets.",
    columns: [
      { key: "seq", label: "#", fmt: "int" },
      { key: "ts", label: "Time (UTC)" },
      { key: "actor_id", label: "Actor" },
      { key: "actor_role", label: "Role" },
      { key: "action", label: "Action", fmt: "badge" },
      { key: "resource", label: "Resource" },
      { key: "outcome", label: "Outcome", fmt: "badge" },
      { key: "details", label: "Details" },
    ],
    rows: state.data.entries,
  };
  return (
    <>
      <div className="adv-verify-bar">
        <button type="button" disabled={verifying} onClick={async () => { setVerifying(true); setVerification((await api.admin("audit/verify")) as typeof verification); setVerifying(false); setVersion((v) => v + 1); }}>
          {verifying ? "Verifying…" : "Verify hash chain"}
        </button>
        {verification && (
          <span className={verification.valid ? "adv-ok" : "adv-bad"}>
            {verification.valid ? <CheckCircle2 size={15} /> : <XCircle size={15} />}
            {verification.valid ? `Chain intact: ${verification.entries} entries, head ${verification.headHash.slice(0, 16)}…` : `Chain broken at entry ${verification.firstBrokenSeq}: ${verification.reason}`}
          </span>
        )}
      </div>
      <DataTableView table={table} pageSize={20} />
    </>
  );
}

function UsersTab() {
  const { api } = useWorkspace();
  const state = useAsync(() => api.admin("users") as Promise<{ provider: string; users: Array<Record<string, string | number | null>>; roles: Array<{ id: string; label: string; summary: string; permissions: string[] }> }>, [api]);
  if (state.error) return <ErrorBlock message={state.error} />;
  if (!state.data) return <LoadingBlock />;
  return (
    <>
      <DataTableView
        table={{
          title: `Users (identity provider: ${state.data.provider})`,
          columns: [{ key: "username", label: "Username" }, { key: "name", label: "Name" }, { key: "role", label: "Role", fmt: "badge" }, { key: "designation", label: "Designation" }],
          rows: state.data.users,
        }}
        pageSize={20}
      />
      <DataTableView
        table={{
          title: "Roles and permissions",
          subtitle: "Enforced on the server for every request. Data permissions also apply as row-level security in the database.",
          columns: [{ key: "label", label: "Role" }, { key: "summary", label: "Purpose" }, { key: "permissions", label: "Permissions" }],
          rows: state.data.roles.map((r) => ({ label: r.label, summary: r.summary, permissions: r.permissions.join(", ") })),
        }}
        pageSize={20}
      />
    </>
  );
}

function AiTab() {
  const { api } = useWorkspace();
  const health = useAsync(() => api.admin("ai-health") as Promise<{ configured: boolean; ok: boolean; model?: string; detail: string; embeddingModelConfigured: boolean }>, [api]);
  const usage = useAsync(() => api.admin("usage") as Promise<{ total: Record<string, number>; byUser: Array<Record<string, string | number>>; recent: Array<Record<string, string | number | null>> }>, [api]);
  if (health.error || usage.error) return <ErrorBlock message={health.error ?? usage.error ?? ""} />;
  if (!health.data || !usage.data) return <LoadingBlock />;
  const h = health.data;
  return (
    <>
      <div className={`adv-card adv-ai-health ${h.ok ? "ok" : "bad"}`}>
        {h.ok ? <CheckCircle2 size={18} /> : <ShieldAlert size={18} />}
        <div>
          <strong>{h.configured ? (h.ok ? `OpenAI connected, model ${h.model}` : "OpenAI is configured but not reachable") : "OpenAI is not configured"}</strong>
          <p>{h.detail}</p>
          <p className="adv-hint">Embedding model: {h.embeddingModelConfigured ? "configured" : "not configured (document search uses keyword retrieval only)"}. Keys are read on the server only and are never sent to the browser.</p>
        </div>
      </div>
      <div className="adv-kpis">
        {[["Requests", usage.data.total.requests], ["Input tokens", usage.data.total.input_tokens], ["Output tokens", usage.data.total.output_tokens], ["Tool calls", usage.data.total.tool_calls], ["Avg latency (ms)", Math.round(usage.data.total.avg_latency_ms)], ["Estimated cost (USD)", usage.data.total.cost_usd]].map(([label, value]) => (
          <div key={String(label)} className="adv-card adv-kpi"><span className="adv-kpi-label">{label}</span><strong className="adv-kpi-value">{typeof value === "number" ? value.toLocaleString("en-IN") : value}</strong></div>
        ))}
      </div>
      <DataTableView
        table={{ title: "Recent AI requests", columns: [{ key: "ts", label: "Time" }, { key: "user_id", label: "User" }, { key: "model", label: "Model" }, { key: "input_tokens", label: "In", fmt: "int" }, { key: "output_tokens", label: "Out", fmt: "int" }, { key: "latency_ms", label: "Latency", fmt: "int" }, { key: "tool_calls", label: "Tools", fmt: "int" }], rows: usage.data.recent }}
      />
    </>
  );
}

function SourcesTab() {
  const { api } = useWorkspace();
  const state = useAsync(() => api.admin("integrations") as Promise<{ connectors: Array<Record<string, string | number | null>> }>, [api]);
  if (state.error) return <ErrorBlock message={state.error} />;
  if (!state.data) return <LoadingBlock />;
  return (
    <DataTableView
      table={{
        title: "Data sources and integrations",
        subtitle: "Only connectors shown as connected are live. Everything else is a contract waiting for an authorised interface.",
        columns: [{ key: "name", label: "Source" }, { key: "state", label: "State", fmt: "badge" }, { key: "provenance", label: "Provenance" }, { key: "detail", label: "Detail" }],
        rows: state.data.connectors,
      }}
      pageSize={20}
    />
  );
}

export function AdminPanel() {
  const [tab, setTab] = useState<(typeof TABS)[number]>("Audit log");
  return (
    <div className="adv-module">
      <header className="adv-page-head">
        <div>
          <h1>Administration</h1>
          <p>Audit trail, identity and roles, AI service health and usage, and data-source status. Administrators do not see procurement records.</p>
        </div>
      </header>
      <nav className="adv-tabs adv-tabs-inline" aria-label="Administration sections">
        {TABS.map((t) => <button key={t} type="button" className={tab === t ? "active" : ""} onClick={() => setTab(t)}>{t}</button>)}
      </nav>
      {tab === "Audit log" && <AuditTab />}
      {tab === "Users & roles" && <UsersTab />}
      {tab === "AI service" && <AiTab />}
      {tab === "Data sources" && <SourcesTab />}
    </div>
  );
}
