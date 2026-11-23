"use client";

import { useMemo, useState } from "react";
import { ArrowDown, ArrowUp, Download, Search } from "lucide-react";
import type { DataTable, RecordRow } from "../shared/types";
import { useWorkspace } from "./context";
import { formatValue, rowsToCsv, toneOf } from "./format";

interface Props {
  table: DataTable;
  pageSize?: number;
  compact?: boolean;
}

export function Badge({ text }: { text: string }) {
  return <span className={`adv-badge adv-tone-${toneOf(text)}`}>{text}</span>;
}

export function DataTableView({ table, pageSize = 12, compact = false }: Props) {
  const { openCase, openVendor, openDocument } = useWorkspace();
  const [sortKey, setSortKey] = useState<string | null>(null);
  const [descending, setDescending] = useState(true);
  const [filter, setFilter] = useState("");
  const [visible, setVisible] = useState(pageSize);

  const rows = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    let result: RecordRow[] = needle
      ? table.rows.filter((row) => table.columns.some((c) => String(row[c.key] ?? "").toLowerCase().includes(needle)))
      : table.rows;
    if (sortKey) {
      result = [...result].sort((a, b) => {
        const x = a[sortKey];
        const y = b[sortKey];
        const bothNumbers = typeof x === "number" && typeof y === "number";
        const order = bothNumbers ? (x as number) - (y as number) : String(x ?? "").localeCompare(String(y ?? ""), undefined, { numeric: true });
        return descending ? -order : order;
      });
    }
    return result;
  }, [table.rows, table.columns, filter, sortKey, descending]);

  const clickable = Boolean(table.caseKey || table.vendorKey || table.documentKey);

  const activate = (row: RecordRow) => {
    if (table.documentKey && row[table.documentKey]) return openDocument(String(row[table.documentKey]), typeof row.page === "number" ? row.page : undefined);
    if (table.vendorKey && row[table.vendorKey]) return openVendor(String(row[table.vendorKey]));
    if (table.caseKey && row[table.caseKey]) return openCase(String(row[table.caseKey]));
  };

  const download = () => {
    const blob = new Blob([rowsToCsv(table.columns, rows)], { type: "text/csv" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `${(table.title ?? "table").toLowerCase().replace(/[^a-z0-9]+/g, "-")}.csv`;
    link.click();
    URL.revokeObjectURL(link.href);
  };

  if (table.rows.length === 0) {
    return (
      <section className="adv-card adv-table-card">
        {table.title && <h3 className="adv-card-title">{table.title}</h3>}
        <p className="adv-empty">No records in the loaded data.</p>
      </section>
    );
  }

  return (
    <section className={`adv-card adv-table-card ${compact ? "adv-compact" : ""}`}>
      <div className="adv-table-head">
        <div>
          {table.title && <h3 className="adv-card-title">{table.title}</h3>}
          <p className="adv-card-sub">
            {table.subtitle ? `${table.subtitle} · ` : ""}
            {rows.length === table.rows.length ? `${table.rows.length} records` : `${rows.length} of ${table.rows.length} records`}
          </p>
        </div>
        <div className="adv-table-tools">
          {table.rows.length > 6 && (
            <label className="adv-mini-search">
              <Search size={13} />
              <input value={filter} onChange={(e) => { setFilter(e.target.value); setVisible(pageSize); }} placeholder="Filter" aria-label="Filter rows" />
            </label>
          )}
          <button type="button" className="adv-icon-button" onClick={download} title="Download as CSV" aria-label="Download as CSV">
            <Download size={14} />
          </button>
        </div>
      </div>
      <div className="adv-table-scroll">
        <table className="adv-table">
          <thead>
            <tr>
              {table.columns.map((column) => (
                <th
                  key={column.key}
                  className={["money", "int", "num", "pct", "days"].includes(column.fmt ?? "") ? "adv-right" : ""}
                  onClick={() => {
                    if (sortKey === column.key) setDescending(!descending);
                    else { setSortKey(column.key); setDescending(true); }
                  }}
                >
                  <span>
                    {column.label}
                    {sortKey === column.key && (descending ? <ArrowDown size={11} /> : <ArrowUp size={11} />)}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, visible).map((row, index) => (
              <tr
                key={index}
                className={clickable ? "adv-clickable" : ""}
                onClick={clickable ? () => activate(row) : undefined}
                onKeyDown={clickable ? (e) => { if (e.key === "Enter") activate(row); } : undefined}
                tabIndex={clickable ? 0 : undefined}
              >
                {table.columns.map((column) => {
                  const raw = row[column.key];
                  const text = formatValue(raw, column.fmt, true);
                  return (
                    <td key={column.key} className={[["money", "int", "num", "pct", "days"].includes(column.fmt ?? "") ? "adv-right" : "", typeof raw === "string" && /^ADV-[A-Z0-9-]+$/.test(raw) ? "adv-nowrap" : ""].join(" ").trim()} title={column.fmt === "money" ? formatValue(raw, "money") : undefined}>
                      {column.fmt === "badge" && raw !== null && raw !== "" ? <Badge text={String(raw)} /> : text}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {visible < rows.length && (
        <button type="button" className="adv-more" onClick={() => setVisible(visible + pageSize * 3)}>
          Show more ({rows.length - visible} remaining)
        </button>
      )}
    </section>
  );
}
