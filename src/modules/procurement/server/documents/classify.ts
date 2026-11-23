import type { Block, Classification, DocumentMetadata, LayoutResult, ManifestRow, TableRowRecord } from "./types";

const norm = (v: string) => v.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

function tokenOverlap(a: string, b: string): number {
  const ta = new Set(norm(a).split(" ").filter(Boolean));
  const tb = new Set(norm(b).split(" ").filter(Boolean));
  if (!ta.size || !tb.size) return 0;
  let hit = 0;
  for (const t of ta) if (tb.has(t)) hit++;
  return hit / Math.max(ta.size, tb.size);
}

export function allTableRows(blocks: Block[]): TableRowRecord[] {
  return blocks.flatMap((b) => (b.type === "table" ? b.rows : []));
}

function kvValue(rows: TableRowRecord[], ...labels: string[]): string | null {
  for (const label of labels) {
    const row = rows.find((r) => r.kind === "kv" && r.cells[0]?.toLowerCase() === label.toLowerCase());
    if (row?.cells[1]) return row.cells[1];
  }
  return null;
}

/** Manifest doc_type is authoritative; the page title and the 'Document type' row are used to verify it. */
export function classifyDocument(row: ManifestRow, layout: LayoutResult): Classification {
  const warnings: string[] = [];
  const rows = allTableRows(layout.blocks);
  const typeRow = kvValue(rows, "Document type");
  const fromRow = typeRow?.match(/^([A-Z]{2,6})\b/)?.[1] ?? null;
  const fromId = row.document_id.match(/^[A-Z]+-[A-Z]+-([A-Z]{2,6})-/)?.[1] ?? null;
  const detectedDocType = fromRow ?? fromId;
  const titleOnPage = layout.title;
  const titleMatchesManifest = !!titleOnPage && tokenOverlap(titleOnPage, row.title) >= 0.8;
  const typeMatchesManifest = detectedDocType === row.doc_type;
  if (!titleOnPage) warnings.push("no document title found on page 1");
  else if (!titleMatchesManifest) warnings.push(`title on page ("${titleOnPage}") differs from manifest title ("${row.title}")`);
  if (!typeMatchesManifest) warnings.push(`detected doc type ${detectedDocType ?? "none"} differs from manifest ${row.doc_type}`);
  return { docType: row.doc_type, detectedDocType, titleOnPage, titleMatchesManifest, typeMatchesManifest, warnings };
}

const uniq = (values: Iterable<string>) => [...new Set(values)].sort();

function isoDate(dmy: string): string {
  const [d, m, y] = dmy.split("-");
  return `${y}-${m}-${d}`;
}

/** Regex-based metadata extraction (ids, dates, department) from the extracted text. */
export function extractMetadata(row: ManifestRow, layout: LayoutResult): DocumentMetadata {
  const warnings: string[] = [];
  const bodyText = layout.pages.map((p) => p.text).join("\n");
  const headerText = layout.pages.flatMap((p) => [...p.headerLines, ...p.footerLines]).join("\n");
  const all = `${headerText}\n${bodyText}`;
  const rows = allTableRows(layout.blocks);

  const docLine = all.match(/Document\s+([A-Z]+-[A-Z]+-[A-Z]{2,6}-[\w-]+)\s*\|\s*Version\s+(\d+)\s*\|\s*Created\s+(\d{2}-\d{2}-\d{4})/);
  const headerId = headerText.match(/([A-Z]+-[A-Z]+-[A-Z]{2,6}-[\w-]+)\s*\|\s*Version\s+(\d+)/);
  const documentNumber = kvValue(rows, "Document ID") ?? docLine?.[1] ?? headerId?.[1] ?? null;
  const version = Number(docLine?.[2] ?? headerId?.[2] ?? kvValue(rows, "Version")) || null;
  const documentDate = docLine?.[3] ? isoDate(docLine[3]) : null;

  const caseIds = uniq(all.match(/\bADV-DEMO-\d{4}-\d{6}\b/g) ?? []);
  const tenderIds = uniq(all.match(/\bADV-DEMO-BID-\d{4}-\d{6}\b/g) ?? []);
  const poNumbers = uniq(all.match(/\bADV-DEMO-PO-\d{4}-\d{6}\b/g) ?? []);
  const dates = uniq((bodyText.match(/\b\d{2}-\d{2}-\d{4}\b/g) ?? []).map(isoDate));
  const department = kvValue(rows, "Department", "Requesting Department", "Indenting Department");
  const organisation = kvValue(rows, "Organisation", "Organization");

  if (documentNumber && documentNumber !== row.document_id) warnings.push(`document number on page (${documentNumber}) differs from manifest (${row.document_id})`);
  if (!documentNumber) warnings.push("document number not found in text");
  if (!all.includes(row.document_id)) warnings.push("manifest document_id not present in text");
  if (!caseIds.includes(row.case_id)) warnings.push(`manifest case_id ${row.case_id} not found in text`);
  if (caseIds.some((c) => c !== row.case_id)) warnings.push(`text references other case ids: ${caseIds.filter((c) => c !== row.case_id).join(", ")}`);
  // Delivery/invoice/payment documents legitimately omit the tender id, so absence is fine; a different id is a conflict.
  if (row.tender_id && tenderIds.some((t) => t !== row.tender_id)) warnings.push(`text references tender ids other than manifest ${row.tender_id}: ${tenderIds.join(", ")}`);
  if (row.po_number && poNumbers.some((p) => p !== row.po_number)) warnings.push(`text references PO numbers other than manifest ${row.po_number}: ${poNumbers.join(", ")}`);
  if (version !== null && version !== row.version) warnings.push(`version on page (${version}) differs from manifest (${row.version})`);

  return { documentNumber, caseIds, tenderIds, poNumbers, version, documentDate, dates, department, organisation, warnings };
}
