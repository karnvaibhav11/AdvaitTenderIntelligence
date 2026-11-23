"use client";

import { useEffect, useState } from "react";
import { ArrowLeft, ExternalLink, FileText, Sparkles, X } from "lucide-react";
import type { DetailSection, DocumentRef, EntityDetail } from "../shared/types";
import { useWorkspace } from "./context";
import { Badge, DataTableView } from "./DataTableView";
import { formatDate, formatValue } from "./format";
import { useAsync } from "./useAsync";
import { ErrorBlock, LoadingBlock } from "./views/ModulePanel";

export interface DrawerEntry {
  kind: "case" | "vendor" | "document";
  id: string;
  page?: number;
}

function SectionView({ section }: { section: DetailSection }) {
  return (
    <div className="adv-section">
      {section.description && <p className="adv-section-desc">{section.description}</p>}
      {section.fields && section.fields.length > 0 && (
        <dl className="adv-fields">
          {section.fields.map((field) => (
            <div key={field.label}>
              <dt>{field.label}</dt>
              <dd>{field.fmt === "badge" ? <Badge text={String(field.value)} /> : formatValue(field.value, field.fmt)}</dd>
            </div>
          ))}
        </dl>
      )}
      {section.matrix && (
        <section className="adv-card adv-table-card adv-compact">
          <h3 className="adv-card-title">{section.matrix.title}</h3>
          <div className="adv-table-scroll">
            <table className="adv-table">
              <thead>
                <tr>
                  <th>Parameter</th>
                  {section.matrix.columns.map((c) => <th key={c}>{c}</th>)}
                </tr>
              </thead>
              <tbody>
                {section.matrix.rows.map((row) => (
                  <tr key={row.label}>
                    <td>{row.label}</td>
                    {row.cells.map((cell, index) => (
                      <td key={index}><span className={`adv-badge adv-tone-${cell.tone ?? "neutral"}`}>{cell.text}</span></td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
      {section.tables?.map((table, index) => table.rows.length > 0 && <DataTableView key={`${table.title}-${index}`} table={table} pageSize={8} compact />)}
      {section.notes?.map((note) => <p key={note} className="adv-section-note">{note}</p>)}
    </div>
  );
}

function DocumentsTab({ documents }: { documents: DocumentRef[] }) {
  const { openDocument } = useWorkspace();
  if (!documents.length) return <p className="adv-empty">No registered documents for this record.</p>;
  const byStage = new Map<string, DocumentRef[]>();
  for (const doc of documents) byStage.set(doc.stage, [...(byStage.get(doc.stage) ?? []), doc]);
  return (
    <div className="adv-section">
      {[...byStage.entries()].map(([stage, docs]) => (
        <div key={stage} className="adv-doc-group">
          <h4>{stage}</h4>
          <ul>
            {docs.map((doc) => (
              <li key={doc.documentId}>
                <button type="button" onClick={() => openDocument(doc.documentId)} disabled={!doc.available}>
                  <FileText size={15} />
                  <span>
                    <strong>{doc.title}</strong>
                    <small>{doc.documentId} · v{doc.version} · {doc.pages} page{doc.pages === 1 ? "" : "s"} · {formatDate(doc.createdDate)}</small>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

function EntityView({ entry }: { entry: DrawerEntry }) {
  const { api, askTattva } = useWorkspace();
  const state = useAsync<EntityDetail>(
    () => (entry.kind === "case" ? api.caseDetail(entry.id) : api.vendorDetail(entry.id)),
    [api, entry.kind, entry.id],
  );
  const [tab, setTab] = useState("summary");
  useEffect(() => {
    setTab(entry.kind === "case" ? "summary" : "profile");
  }, [entry.kind, entry.id]);

  if (state.error) return <ErrorBlock message={state.error} />;
  if (!state.data) return <LoadingBlock label="Loading record" />;
  const detail = state.data;
  const active = detail.sections.find((s) => s.id === tab);

  return (
    <>
      <header className="adv-drawer-head">
        <p className="adv-eyebrow">{detail.kind === "case" ? "Procurement case" : "Vendor (synthetic)"}</p>
        <h2>{detail.title}</h2>
        <p className="adv-drawer-sub">{detail.subtitle}</p>
        <div className="adv-badges">
          {detail.badges.map((b) => <span key={b.label} className={`adv-badge adv-tone-${b.tone ?? "neutral"}`}>{b.label}</span>)}
        </div>
        {detail.kind === "case" && (
          <button type="button" className="adv-ghost" onClick={() => askTattva(`Summarize the complete lifecycle of ${detail.id}`, detail.id)}>
            <Sparkles size={14} /> Ask TattvaAI about this case
          </button>
        )}
      </header>
      <nav className="adv-tabs" aria-label="Record sections">
        {detail.sections.map((s) => (
          <button key={s.id} type="button" className={tab === s.id ? "active" : ""} onClick={() => setTab(s.id)}>
            {s.title.replace("Tender ADV-DEMO-BID-", "Tender ").replace(/ \(decision support\)/, "")}
          </button>
        ))}
        <button type="button" className={tab === "documents" ? "active" : ""} onClick={() => setTab("documents")}>
          Documents ({detail.documents.length})
        </button>
      </nav>
      <div className="adv-drawer-body">
        {tab === "documents" ? <DocumentsTab documents={detail.documents} /> : active && (
          <>
            <h3 className="adv-section-title">{active.title}</h3>
            <SectionView section={active} />
          </>
        )}
      </div>
    </>
  );
}

function DocumentViewer({ entry }: { entry: DrawerEntry }) {
  const { api } = useWorkspace();
  const url = api.documentUrl(entry.id);
  return (
    <>
      <header className="adv-drawer-head">
        <p className="adv-eyebrow">Source document (synthetic)</p>
        <h2>{entry.id}</h2>
        <p className="adv-drawer-sub">{entry.page ? `Opened at page ${entry.page}` : "Rendered from the registered PDF"}</p>
        <a className="adv-ghost" href={url} target="_blank" rel="noreferrer"><ExternalLink size={14} /> Open in a new tab</a>
      </header>
      <iframe className="adv-pdf" title={`Document ${entry.id}`} src={`${url}#page=${entry.page ?? 1}`} />
    </>
  );
}

export function DetailDrawer({ stack, onBack, onClose }: { stack: DrawerEntry[]; onBack: () => void; onClose: () => void }) {
  const entry = stack[stack.length - 1];
  useEffect(() => {
    const handler = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);
  if (!entry) return null;
  return (
    <>
      <div className="adv-scrim" onClick={onClose} />
      <aside className="adv-drawer" role="dialog" aria-label="Record detail">
        <div className="adv-drawer-bar">
          {stack.length > 1 ? <button type="button" onClick={onBack}><ArrowLeft size={15} /> Back</button> : <span />}
          <button type="button" onClick={onClose} aria-label="Close detail"><X size={16} /></button>
        </div>
        <div className="adv-drawer-scroll">
          {entry.kind === "document" ? <DocumentViewer entry={entry} /> : <EntityView entry={entry} />}
        </div>
      </aside>
    </>
  );
}
