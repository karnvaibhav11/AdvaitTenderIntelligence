"use client";

import { useEffect, useState } from "react";
import { ChevronLeft, ChevronRight, FileText, Search } from "lucide-react";
import type { DocumentList } from "../../shared/types";
import { useWorkspace } from "../context";
import { formatDate } from "../format";
import { useAsync } from "../useAsync";
import { ErrorBlock } from "./ModulePanel";

const PAGE = 30;

export function DocumentLibrary() {
  const { api, openDocument, openCase } = useWorkspace();
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [type, setType] = useState("");
  const [offset, setOffset] = useState(0);

  useEffect(() => {
    const timer = setTimeout(() => { setSearch(query); setOffset(0); }, 250);
    return () => clearTimeout(timer);
  }, [query]);

  const state = useAsync<DocumentList>(() => api.documents({ q: search, type, limit: PAGE, offset }), [api, search, type, offset]);
  const list = state.data;

  return (
    <div className="adv-module">
      <header className="adv-page-head">
        <div>
          <h1>Document library</h1>
          <p>Registered source PDFs (requisitions, tenders, bids, evaluations, awards, POs, deliveries, invoices, payments) with their parent record.</p>
        </div>
        {list && <span className="adv-asof">{list.total.toLocaleString("en-IN")} documents</span>}
      </header>
      <div className="adv-filters">
        <label className="adv-search">
          <Search size={15} />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search by document, case, tender or PO number" aria-label="Search documents" />
        </label>
        <select value={type} onChange={(e) => { setType(e.target.value); setOffset(0); }} aria-label="Document type">
          <option value="">All types</option>
          {list?.docTypes.map((t) => <option key={t.id} value={t.id}>{t.id} ({t.count})</option>)}
        </select>
      </div>
      {state.error ? (
        <ErrorBlock message={state.error} />
      ) : (
        <section className="adv-card adv-table-card">
          <div className="adv-table-scroll">
            <table className="adv-table">
              <thead>
                <tr><th>Document</th><th>Type</th><th>Title</th><th>Stage</th><th className="adv-right">Pages</th><th>Date</th><th>Case</th><th>File</th></tr>
              </thead>
              <tbody>
                {(list?.rows ?? []).map((doc) => (
                  <tr key={doc.documentId} className="adv-clickable" tabIndex={0} onClick={() => openDocument(doc.documentId)} onKeyDown={(e) => e.key === "Enter" && openDocument(doc.documentId)}>
                    <td className="adv-mono"><FileText size={13} /> {doc.documentId.replace("ADV-DEMO-", "")}</td>
                    <td><span className="adv-badge adv-tone-neutral">{doc.docType}</span></td>
                    <td className="adv-wrap">{doc.title}</td>
                    <td>{doc.stage}</td>
                    <td className="adv-right">{doc.pages}</td>
                    <td>{formatDate(doc.createdDate)}</td>
                    <td><button type="button" className="adv-link" onClick={(e) => { e.stopPropagation(); openCase(doc.caseId); }}>{doc.caseId.replace("ADV-DEMO-", "")}</button></td>
                    <td>{doc.available ? "Available" : "Not on server"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {list && list.rows.length === 0 && <p className="adv-empty">No documents match.</p>}
          </div>
          {list && list.total > PAGE && (
            <div className="adv-pager">
              <span>{offset + 1}–{Math.min(offset + PAGE, list.total)} of {list.total.toLocaleString("en-IN")}</span>
              <button type="button" disabled={offset === 0} onClick={() => setOffset(Math.max(offset - PAGE, 0))} aria-label="Previous page"><ChevronLeft size={15} /></button>
              <button type="button" disabled={offset + PAGE >= list.total} onClick={() => setOffset(offset + PAGE)} aria-label="Next page"><ChevronRight size={15} /></button>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
