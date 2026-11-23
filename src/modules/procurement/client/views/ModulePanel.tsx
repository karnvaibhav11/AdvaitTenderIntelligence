"use client";

import { AlertTriangle, Info, Loader2 } from "lucide-react";
import type { Kpi, ModuleView } from "../../shared/types";
import { ChartCard } from "../Charts";
import { useWorkspace } from "../context";
import { DataTableView } from "../DataTableView";
import { formatValue } from "../format";
import { useAsync } from "../useAsync";

export function LoadingBlock({ label = "Loading from the procurement database" }: { label?: string }) {
  return (
    <div className="adv-loading" role="status">
      <Loader2 size={18} className="adv-spin" />
      <span>{label}</span>
    </div>
  );
}

export function ErrorBlock({ message }: { message: string }) {
  return (
    <div className="adv-error" role="alert">
      <AlertTriangle size={18} />
      <div>
        <strong>Data source unavailable</strong>
        <p>{message}</p>
        <p className="adv-hint">Check that the synthetic CSV directory is reachable (set <code>PROCUREMENT_DATA_DIR</code>) and Node 22.5+ is running.</p>
      </div>
    </div>
  );
}

function KpiCard({ kpi }: { kpi: Kpi }) {
  const { openRegister } = useWorkspace();
  const content = (
    <>
      <span className="adv-kpi-label">{kpi.label}</span>
      <strong className="adv-kpi-value">{typeof kpi.value === "number" ? formatValue(kpi.value, kpi.fmt ?? "int", true) : kpi.value}</strong>
      {kpi.hint && <span className="adv-kpi-hint">{kpi.hint}</span>}
    </>
  );
  const className = `adv-card adv-kpi adv-tone-edge-${kpi.tone ?? "neutral"}`;
  return kpi.drill ? (
    <button type="button" className={`${className} adv-kpi-link`} onClick={() => openRegister(kpi.drill!)} title="Show the underlying cases">
      {content}
    </button>
  ) : (
    <div className={className}>{content}</div>
  );
}

export function ModulePanel({ moduleId }: { moduleId: string }) {
  const { api } = useWorkspace();
  const state = useAsync<ModuleView>(() => api.module(moduleId), [api, moduleId]);

  if (state.error) return <ErrorBlock message={state.error} />;
  if (!state.data) return <LoadingBlock />;
  const view = state.data;

  return (
    <div className="adv-module">
      <header className="adv-page-head">
        <div>
          <h1>{view.title}</h1>
          <p>{view.summary}</p>
        </div>
        <span className="adv-asof">Data as of {formatValue(view.asOf, "date")}</span>
      </header>

      <div className="adv-kpis">
        {view.kpis.map((kpi) => (
          <KpiCard key={kpi.label} kpi={kpi} />
        ))}
      </div>

      {view.charts.length > 0 && (
        <div className="adv-chart-grid">
          {view.charts.map((chart) => (
            <ChartCard key={chart.title} chart={chart} />
          ))}
        </div>
      )}

      {view.tables.map((table, index) => (
        <DataTableView key={`${table.title}-${index}`} table={table} />
      ))}

      {view.notes.length > 0 && (
        <aside className="adv-notes">
          <Info size={15} />
          <ul>
            {view.notes.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        </aside>
      )}
    </div>
  );
}
