"use client";

import { Fragment, type ReactNode } from "react";
import type { AiArtifact, AiCitation, DataTable } from "../shared/types";
import { useWorkspace } from "./context";
import { DataTableView } from "./DataTableView";

function pretty(key: string): string {
  return key.replaceAll("_", " ").replace(/^./, (c) => c.toUpperCase());
}

export function artifactToTable(artifact: AiArtifact): DataTable {
  const rowKeys = new Set(artifact.columns);
  return {
    title: artifact.title,
    subtitle: artifact.total > artifact.rows.length ? `Showing ${artifact.rows.length} of ${artifact.total}` : undefined,
    columns: artifact.columns.map((key) => ({ key, label: pretty(key), fmt: artifact.formats?.[key] })),
    rows: artifact.rows,
    caseKey: rowKeys.has("case_id") ? "case_id" : undefined,
    vendorKey: !rowKeys.has("case_id") && rowKeys.has("vendor_id") ? "vendor_id" : undefined,
  };
}

function CitationChip({ citation, index }: { citation: AiCitation; index: number }) {
  const { openCase, openVendor, openDocument } = useWorkspace();
  const act = () => {
    if (citation.documentId) openDocument(citation.documentId, citation.page);
    else if (citation.caseId) openCase(citation.caseId);
    else if (citation.vendorId) openVendor(citation.vendorId);
  };
  const actionable = Boolean(citation.documentId || citation.caseId || citation.vendorId);
  return (
    <button type="button" className={`adv-cite ${actionable ? "" : "adv-cite-static"}`} onClick={actionable ? act : undefined} title={`${citation.label}${citation.page ? `, page ${citation.page}` : ""}`}>
      {index}
    </button>
  );
}

function inline(text: string, citations: Map<string, { citation: AiCitation; index: number }>, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const pattern = /(\*\*[^*]+\*\*|`[^`]+`|\[E\d+\])/g;
  let last = 0;
  let n = 0;
  for (const match of text.matchAll(pattern)) {
    const start = match.index ?? 0;
    if (start > last) nodes.push(text.slice(last, start));
    const token = match[0];
    const key = `${keyPrefix}-${n++}`;
    if (token.startsWith("**")) nodes.push(<strong key={key}>{token.slice(2, -2)}</strong>);
    else if (token.startsWith("`")) nodes.push(<code key={key}>{token.slice(1, -1)}</code>);
    else {
      const entry = citations.get(token.slice(1, -1));
      nodes.push(entry ? <CitationChip key={key} citation={entry.citation} index={entry.index} /> : null);
    }
    last = start + token.length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

function splitRow(line: string): string[] {
  return line.trim().replace(/^\||\|$/g, "").split("|").map((cell) => cell.trim());
}

/** Small, safe Markdown renderer: headings, bold, lists, GFM tables, citations and table artifacts. No raw HTML. */
export function Markdown({ text, citations, artifacts }: { text: string; citations: AiCitation[]; artifacts: AiArtifact[] }) {
  const order = new Map<string, { citation: AiCitation; index: number }>();
  let counter = 0;
  for (const match of text.matchAll(/\[(E\d+)\]/g)) {
    const found = citations.find((c) => c.evidenceId === match[1]);
    if (found && !order.has(found.evidenceId)) order.set(found.evidenceId, { citation: found, index: ++counter });
  }
  const lines = text.split("\n");
  const blocks: ReactNode[] = [];
  let i = 0;
  let key = 0;
  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed) {
      i++;
      continue;
    }
    const artifact = /^\{\{artifact:(A\d+)\}\}$/.exec(trimmed);
    if (artifact) {
      const found = artifacts.find((a) => a.artifactId === artifact[1]);
      if (found) blocks.push(<div key={key++} className="adv-md-artifact"><DataTableView table={artifactToTable(found)} pageSize={8} compact /></div>);
      i++;
      continue;
    }
    if (/^#{1,4}\s/.test(trimmed)) {
      blocks.push(<h4 key={key++} className="adv-md-h">{inline(trimmed.replace(/^#{1,4}\s/, ""), order, `h${key}`)}</h4>);
      i++;
      continue;
    }
    if (trimmed.startsWith("|") && lines[i + 1]?.trim().match(/^\|?\s*:?-{2,}/)) {
      const header = splitRow(trimmed);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].trim().startsWith("|")) rows.push(splitRow(lines[i++]));
      blocks.push(
        <div key={key++} className="adv-table-scroll adv-md-table">
          <table className="adv-table">
            <thead><tr>{header.map((h, c) => <th key={c}>{inline(h, order, `th${c}`)}</th>)}</tr></thead>
            <tbody>{rows.map((r, ri) => <tr key={ri}>{r.map((cell, c) => <td key={c}>{inline(cell, order, `td${ri}-${c}`)}</td>)}</tr>)}</tbody>
          </table>
        </div>,
      );
      continue;
    }
    if (/^([-*•])\s/.test(trimmed) || /^\d+[.)]\s/.test(trimmed)) {
      const ordered = /^\d+[.)]\s/.test(trimmed);
      const items: string[] = [];
      while (i < lines.length && (/^([-*•])\s/.test(lines[i].trim()) || /^\d+[.)]\s/.test(lines[i].trim()))) items.push(lines[i++].trim().replace(/^([-*•]|\d+[.)])\s+/, ""));
      const content = items.map((item, idx) => <li key={idx}>{inline(item, order, `li${key}-${idx}`)}</li>);
      blocks.push(ordered ? <ol key={key++} className="adv-md-list">{content}</ol> : <ul key={key++} className="adv-md-list">{content}</ul>);
      continue;
    }
    const paragraph: string[] = [];
    while (i < lines.length && lines[i].trim() && !/^#{1,4}\s/.test(lines[i].trim()) && !/^([-*•])\s/.test(lines[i].trim()) && !/^\d+[.)]\s/.test(lines[i].trim()) && !/^\{\{artifact:/.test(lines[i].trim()) && !lines[i].trim().startsWith("|")) paragraph.push(lines[i++]);
    blocks.push(
      <p key={key++} className="adv-md-p">
        {paragraph.map((p, idx) => <Fragment key={idx}>{idx > 0 && <br />}{inline(p, order, `p${key}-${idx}`)}</Fragment>)}
      </p>,
    );
  }
  return <div className="adv-md">{blocks}</div>;
}
