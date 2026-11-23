"use client";

import type { Chart } from "../shared/types";
import { useWorkspace } from "./context";
import { compactMoney, formatValue } from "./format";

const PALETTE = ["#1c7cff", "#2fc7e0", "#e0a038", "#8362c7", "#d86a6c", "#6b7e92"];

function label(value: number, fmt: Chart["fmt"]): string {
  return fmt === "money" ? compactMoney(value) : formatValue(value, fmt ?? "int");
}

export function ChartCard({ chart }: { chart: Chart }) {
  const { openRegister } = useWorkspace();
  const max = Math.max(...chart.data.map((d) => Math.max(d.value, d.secondary ?? 0)), 1);

  if (chart.data.length === 0) {
    return (
      <section className="adv-card adv-chart">
        <h3 className="adv-card-title">{chart.title}</h3>
        <p className="adv-empty">No data.</p>
      </section>
    );
  }

  if (chart.kind === "columns") {
    const step = Math.ceil(chart.data.length / 8);
    return (
      <section className="adv-card adv-chart">
        <h3 className="adv-card-title">{chart.title}</h3>
        {chart.subtitle && <p className="adv-card-sub">{chart.subtitle}</p>}
        {chart.secondaryLabel && (
          <div className="adv-legend">
            <span><i style={{ background: PALETTE[1] }} />{chart.primaryLabel}</span>
            <span><i style={{ background: PALETTE[0] }} />{chart.secondaryLabel}</span>
          </div>
        )}
        <div className="adv-columns" role="img" aria-label={chart.title}>
          {chart.data.map((datum, index) => (
            <button
              type="button"
              key={datum.label}
              className="adv-col"
              disabled={!datum.drill}
              onClick={() => datum.drill && openRegister(datum.drill)}
              title={`${datum.label}: ${label(datum.value, chart.fmt)}${datum.secondary !== undefined ? ` / ${label(datum.secondary, chart.fmt)}` : ""}`}
            >
              <span className="adv-col-bars">
                <span className="adv-col-bar" style={{ height: `${(datum.value / max) * 100}%`, background: PALETTE[1] }} />
                {datum.secondary !== undefined && <span className="adv-col-bar" style={{ height: `${(datum.secondary / max) * 100}%`, background: PALETTE[0] }} />}
              </span>
              <span className="adv-col-label">{index % step === 0 ? datum.label.slice(2) : ""}</span>
            </button>
          ))}
        </div>
        <p className="adv-axis-max">Peak {label(max, chart.fmt)}</p>
      </section>
    );
  }

  return (
    <section className="adv-card adv-chart">
      <h3 className="adv-card-title">{chart.title}</h3>
      {chart.subtitle && <p className="adv-card-sub">{chart.subtitle}</p>}
      <ul className="adv-bars">
        {chart.data.map((datum, index) => (
          <li key={datum.label}>
            <button type="button" disabled={!datum.drill} onClick={() => datum.drill && openRegister(datum.drill)} title={datum.drill ? "Show underlying cases" : undefined}>
              <span className="adv-bar-label" title={datum.label}>{datum.label}</span>
              <span className="adv-bar-track">
                <span className="adv-bar-fill" style={{ width: `${Math.max((datum.value / max) * 100, 1.5)}%`, background: PALETTE[index % PALETTE.length] }} />
              </span>
              <span className="adv-bar-value">{label(datum.value, chart.fmt)}</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
