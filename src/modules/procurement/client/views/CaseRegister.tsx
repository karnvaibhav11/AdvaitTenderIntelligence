"use client";

import { useEffect, useState } from "react";
import { ChevronLeft, ChevronRight, Search, X } from "lucide-react";
import type { CaseFilters, CaseList } from "../../shared/types";
import { useWorkspace } from "../context";
import { Badge } from "../DataTableView";
import { formatValue } from "../format";
import { useAsync } from "../useAsync";
import { ErrorBlock } from "./ModulePanel";

const PAGE = 25;

export function CaseRegister({ drill, onClearDrill }: { drill?: string; onClearDrill: () => void }) {
  const { api, openCase } = useWorkspace();
  const [filters, setFilters] = useState<CaseFilters>({ sort: "recent" });
  const [query, setQuery] = useState("");
  const [offset, setOffset] = useState(0);

  useEffect(() => {
    const timer = setTimeout(() => {
      setFilters((previous) => ({ ...previous, q: query || undefined }));
      setOffset(0);
    }, 250);
    return () => clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    setOffset(0);
  }, [drill]);

  const state = useAsync<CaseList>(() => api.cases({ ...filters, drill, limit: PAGE, offset }), [api, filters, drill, offset]);
  const list = state.data;

  const update = (key: keyof CaseFilters, value: string) => {
    setFilters((previous) => ({ ...previous, [key]: value || undefined }));
    setOffset(0);
  };

  return (
    <div className="adv-module">
      <header className="adv-page-head">
        <div>
          <h1>Procurement register</h1>
          <p>Every procurement case from requisition to closure. Open any row for the full lifecycle, evidence and source documents.</p>
        </div>
        {list && <span className="adv-asof">{list.total.toLocaleString("en-IN")} cases</span>}
      </header>

      {drill && (
        <div className="adv-drill-chip">
          <span>Showing: <strong>{list?.drillTitle ?? drill}</strong></span>
          <button type="button" onClick={onClearDrill} aria-label="Clear drill-down"><X size={13} /> Clear</button>
        </div>
      )}

      <div className="adv-filters">
        <label className="adv-search">
          <Search size={15} />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search case, tender, PO, vendor or requirement" aria-label="Search procurement cases" />
        </label>
        <select value={filters.stage ?? ""} onChange={(e) => update("stage", e.target.value)} aria-label="Stage">
          <option value="">All stages</option>
          {list?.facets.stages.map((v) => <option key={v}>{v}</option>)}
        </select>
        <select value={filters.status ?? ""} onChange={(e) => update("status", e.target.value)} aria-label="Status">
          <option value="">All statuses</option>
          {list?.facets.statuses.map((v) => <option key={v}>{v}</option>)}
        </select>
        <select value={filters.risk ?? ""} onChange={(e) => update("risk", e.target.value)} aria-label="Risk">
          <option value="">Any risk</option>
          {list?.facets.risks.map((v) => <option key={v}>{v}</option>)}
        </select>
        <select value={filters.department ?? ""} onChange={(e) => update("department", e.target.value)} aria-label="Department">
          <option value="">All departments</option>
          {list?.facets.departments.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
        </select>
        <select value={filters.category ?? ""} onChange={(e) => update("category", e.target.value)} aria-label="Category">
          <option value="">All categories</option>
          {list?.facets.categories.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
        </select>
        <select value={filters.sort ?? "recent"} onChange={(e) => update("sort", e.target.value)} aria-label="Sort">
          <option value="recent">Recently updated</option>
          <option value="risk">Highest risk</option>
          <option value="value">Highest value</option>
          <option value="delay">Longest delay</option>
          <option value="oldest">Oldest first</option>
        </select>
      </div>

      {state.error ? (
        <ErrorBlock message={state.error} />
      ) : (
        <section className="adv-card adv-table-card">
          <div className="adv-table-scroll">
            <table className="adv-table">
              <thead>
                <tr>
                  <th>Case</th>
                  <th>Requirement</th>
                  <th>Department</th>
                  <th>Stage</th>
                  <th>Status</th>
                  <th>Risk</th>
                  <th className="adv-right">Estimated</th>
                  <th className="adv-right">Awarded</th>
                  <th className="adv-right">Delay</th>
                  <th>Vendor</th>
                </tr>
              </thead>
              <tbody>
                {(list?.rows ?? []).map((row) => (
                  <tr key={row.caseId} className="adv-clickable" tabIndex={0} onClick={() => openCase(row.caseId)} onKeyDown={(e) => e.key === "Enter" && openCase(row.caseId)}>
                    <td className="adv-mono">{row.caseId.replace("ADV-DEMO-", "")}</td>
                    <td className="adv-wrap">{row.title}</td>
                    <td>{row.department}</td>
                    <td>{row.stage}</td>
                    <td><Badge text={row.status} /></td>
                    <td><Badge text={row.riskCategory} /></td>
                    <td className="adv-right">{formatValue(row.estimatedValue, "money", true)}</td>
                    <td className="adv-right">{row.awardValue ? formatValue(row.awardValue, "money", true) : "–"}</td>
                    <td className="adv-right">{row.delayDays > 0 ? `${row.delayDays} d` : "–"}</td>
                    <td>{row.vendorName ?? "–"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {state.loading && !list && <p className="adv-empty">Loading…</p>}
            {list && list.rows.length === 0 && <p className="adv-empty">No cases match these filters.</p>}
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
