import type { Amount, Block, LayoutAnalyzer, LayoutResult, PageText, RawPage, TableRowRecord, TextItem } from "./types";

/**
 * Geometry-based layout analysis for text-layer PDFs.
 *
 * 1. Runs are clustered into lines by baseline (y) and into segments by x gaps.
 * 2. Header/footer bands and the diagonal watermark are separated from the body.
 * 3. Font size identifies the title and section headings (English part kept,
 *    the Hindi translation is retained in page text only).
 * 4. Inside a section, segments are assigned to columns using the header row
 *    (or the label/value columns of a key/value block), grouped into cells
 *    (wrapped lines) and into rows around the first-column cells. Header rows
 *    repeated on a following page are recognised and not duplicated.
 *
 * All thresholds are tuned for A4 documents produced by fpdf2 (the synthetic
 * corpus) and are exposed in LAYOUT so another producer can override them.
 */
export const LAYOUT = {
  headerBandRatio: 0.078,
  footerBandRatio: 0.05,
  watermarkMinSize: 30,
  titleMinSize: 12,
  headingMinSize: 9.5,
  lineTolerance: 2,
  segmentGapPt: 3.4,
  segmentGapEm: 0.4,
  /** x of the value column in label/value blocks (label width 58 mm + 12 mm margin). */
  kvValueX: 201.3,
  kvValueTolerance: 3,
  /** Lines closer than factor*fontSize belong to the same wrapped cell. */
  sameCellFactor: 1.7,
  paragraphFactor: 1.65,
  minBodyChars: 10,
};

export const DEVANAGARI = /[\u0900-\u097f]/;
const ASCII_LETTER = /[A-Za-z]/;

interface Seg {
  x0: number;
  x1: number;
  y: number;
  size: number;
  text: string;
  page: number;
}

interface BodyLine {
  page: number;
  y: number;
  size: number;
  segs: Seg[];
}

const norm = (value: string) => value.normalize("NFC").replace(/\s+/g, " ").trim();

function isHindiOnly(text: string): boolean {
  return DEVANAGARI.test(text) && !ASCII_LETTER.test(text);
}

function englishPart(text: string): string {
  const cut = text.indexOf(" / ");
  if (cut > 0 && /[^\x00-\x7f]/.test(text.slice(cut + 3))) return norm(text.slice(0, cut));
  if (DEVANAGARI.test(text) && cut < 0) {
    const m = text.search(/\s*\/?\s*[\u0900-\u097f]/);
    if (m > 0) return norm(text.slice(0, m).replace(/\/\s*$/, ""));
  }
  return norm(text);
}

const UNIT_PATTERNS: Array<[RegExp, Amount["unit"]]> = [
  [/^(?:months?|month\(s\))$/i, "months"],
  [/^(?:days?)$/i, "days"],
  [/^(?:weeks?)$/i, "weeks"],
  [/^(?:years?)$/i, "years"],
  [/^(?:nos\.?|no\.|units?|pcs|set|sets)$/i, "nos"],
];

/** Pull amounts (₹), percentages and quantities with units out of a cell/row text. */
export function extractAmounts(text: string): Amount[] {
  const out: Amount[] = [];
  for (const m of text.matchAll(/₹\s?([\d,]+(?:\.\d+)?)(?:\s?(crore|lakh|cr|lac)\b)?/gi)) {
    let value = Number(m[1].replace(/,/g, ""));
    const scale = (m[2] ?? "").toLowerCase();
    if (scale === "crore" || scale === "cr") value *= 1e7;
    else if (scale === "lakh" || scale === "lac") value *= 1e5;
    if (Number.isFinite(value)) out.push({ raw: m[0].trim(), value, unit: "INR", currency: "INR" });
  }
  for (const m of text.matchAll(/(\d+(?:\.\d+)?)\s?%/g)) out.push({ raw: m[0], value: Number(m[1]), unit: "percent" });
  for (const m of text.matchAll(/(\d+(?:\.\d+)?)\s*(Months?\(s\)|Months?|Days?|Weeks?|Years?|Nos\.?|Units?|Pcs|Sets?)\b/gi)) {
    const unitWord = m[2];
    const unit = UNIT_PATTERNS.find(([re]) => re.test(unitWord))?.[1] ?? "other";
    out.push({ raw: m[0], value: Number(m[1]), unit });
  }
  return out;
}

function buildLines(page: RawPage): { body: BodyLine[]; header: string[]; footer: string[]; bodyChars: number } {
  const headerBand = page.height * (1 - LAYOUT.headerBandRatio);
  const footerBand = page.height * LAYOUT.footerBandRatio;
  const usable = page.items
    .filter((it): it is TextItem => it.text.trim().length > 0 && it.size < LAYOUT.watermarkMinSize)
    .sort((a, b) => b.y - a.y || a.x - b.x);

  const clusters: TextItem[][] = [];
  let ref = Number.NaN;
  for (const item of usable) {
    if (clusters.length && Math.abs(item.y - ref) <= LAYOUT.lineTolerance) clusters[clusters.length - 1].push(item);
    else {
      clusters.push([item]);
      ref = item.y;
    }
  }

  const body: BodyLine[] = [];
  const header: string[] = [];
  const footer: string[] = [];
  let bodyChars = 0;
  for (const cluster of clusters) {
    cluster.sort((a, b) => a.x - b.x);
    const segs: Seg[] = [];
    let cur: Seg | null = null;
    let prevEnd = 0;
    let prevSize = 0;
    for (const item of cluster) {
      const gap = item.x - prevEnd;
      const size = item.size || prevSize || 8;
      if (cur && gap <= Math.max(LAYOUT.segmentGapPt, LAYOUT.segmentGapEm * size)) {
        cur.text += (gap > 0.12 * size ? " " : "") + item.text.trim();
        cur.x1 = Math.max(cur.x1, item.x + item.width);
        cur.size = Math.max(cur.size, size);
      } else {
        cur = { x0: item.x, x1: item.x + item.width, y: item.y, size, text: item.text.trim(), page: page.pageNo };
        segs.push(cur);
      }
      prevEnd = Math.max(prevEnd, item.x + item.width);
      prevSize = size;
    }
    for (const seg of segs) seg.text = norm(seg.text);
    // Devanagari lines (translated titles) have irregular word gaps: treat as one text run, not table cells.
    if (segs.length > 1 && segs.some((s) => DEVANAGARI.test(s.text)) && segs.every((s) => !/[A-Za-z0-9]/.test(s.text))) {
      const merged: Seg = { ...segs[0], x1: Math.max(...segs.map((s) => s.x1)), text: segs.map((s) => s.text).join(" ") };
      segs.splice(0, segs.length, merged);
    }
    const text = segs.map((s) => s.text).join(" ");
    const y = cluster[0].y;
    if (y >= headerBand) header.push(text);
    else if (y <= footerBand) footer.push(text);
    else {
      body.push({ page: page.pageNo, y, size: Math.max(...segs.map((s) => s.size)), segs });
      bodyChars += text.replace(/\s/g, "").length;
    }
  }
  return { body, header, footer, bodyChars };
}

interface Section {
  name: string;
  full: string;
  page: number;
  lines: BodyLine[];
}

interface CellGroup {
  col: number;
  yc: number;
  text: string;
}

export class GeometryLayoutAnalyzer implements LayoutAnalyzer {
  readonly name = "geometry-lines-v1";

  analyze(rawPages: RawPage[]): LayoutResult {
    const pages: PageText[] = [];
    const entries = new Map<number, string[]>();
    const push = (page: number, text: string) => {
      if (!text) return;
      const list = entries.get(page) ?? [];
      list.push(text);
      entries.set(page, list);
    };

    const allBody: BodyLine[] = [];
    const meta = new Map<number, { header: string[]; footer: string[]; bodyChars: number }>();
    for (const raw of rawPages) {
      const built = buildLines(raw);
      allBody.push(...built.body);
      meta.set(raw.pageNo, built);
    }

    const leftX = allBody.length ? Math.min(...allBody.flatMap((l) => l.segs.map((s) => s.x0))) : 0;
    const blocks: Block[] = [];
    const titleParts: string[] = [];
    const sections: Section[] = [{ name: "Document Information", full: "", page: 1, lines: [] }];

    for (const line of allBody) {
      const first = line.segs[0];
      const lineText = line.segs.map((s) => s.text).join(" ");
      if (line.size >= LAYOUT.titleMinSize) {
        titleParts.push(lineText);
        push(line.page, lineText);
        blocks.push({ type: "text", page: line.page, section: "Document Information", text: lineText });
        continue;
      }
      const isHeading = line.size >= LAYOUT.headingMinSize && ASCII_LETTER.test(first.text) && first.x0 <= leftX + 12 && !isHindiOnly(first.text);
      if (isHeading) {
        const full = norm(lineText);
        sections.push({ name: englishPart(full), full, page: line.page, lines: [] });
        continue;
      }
      sections[sections.length - 1].lines.push(line);
    }

    for (const section of sections) this.processSection(section, leftX, blocks, push);

    for (const raw of rawPages) {
      const built = meta.get(raw.pageNo)!;
      const text = (entries.get(raw.pageNo) ?? []).join("\n");
      pages.push({
        pageNo: raw.pageNo,
        text,
        hasTextLayer: built.bodyChars >= LAYOUT.minBodyChars,
        source: "text_layer",
        headerLines: built.header,
        footerLines: built.footer,
      });
    }
    return { pages, blocks, title: titleParts.length ? norm(titleParts.join(" ")) : null };
  }

  private processSection(section: Section, leftX: number, blocks: Block[], push: (page: number, text: string) => void) {
    const { lines } = section;
    const sectionName = section.name;
    if (section.full) push(section.page, section.full);
    if (!lines.length) return;

    const emitParagraphs = (subset: BodyLine[]) => {
      for (const para of this.paragraphs(subset)) {
        push(para.page, para.text);
        if (!isHindiOnly(para.text)) blocks.push({ type: "text", page: para.page, section: sectionName, text: para.text });
      }
    };

    const isGridLine = (l: BodyLine) => l.segs.length >= 2 || l.segs.some((s) => s.x0 > leftX + 30);
    const firstGrid = lines.findIndex(isGridLine);
    if (firstGrid < 0) return emitParagraphs(lines);

    // Leading prose lines before the table/kv block (single segment at the left margin, sentence-like).
    let start = 0;
    while (start < firstGrid) {
      const t = lines[start].segs[0].text;
      if (lines[start].segs.length === 1 && lines[start].segs[0].x0 <= leftX + 3 && (t.length >= 60 || /[.!?]$/.test(t))) start++;
      else break;
    }
    if (start > 0) emitParagraphs(lines.slice(0, start));
    const gridLines = lines.slice(start);

    const l0 = gridLines.find((l) => l.segs.length >= 2);
    let mode: "kv" | "grid";
    let starts: number[];
    if (!l0) {
      mode = "kv";
      const valueX = Math.min(...gridLines.flatMap((l) => l.segs.filter((s) => s.x0 > leftX + 30).map((s) => s.x0)));
      starts = [leftX, valueX];
    } else if (l0.segs[0].text.endsWith(":") || (l0.segs.length === 2 && Math.abs(l0.segs[1].x0 - LAYOUT.kvValueX) <= LAYOUT.kvValueTolerance)) {
      mode = "kv";
      starts = [l0.segs[0].x0, l0.segs[1].x0];
    } else {
      mode = "grid";
      starts = l0.segs.map((s) => s.x0);
    }
    const colOf = (seg: Seg) => {
      let col = 0;
      for (let j = 0; j < starts.length; j++) if (starts[j] < seg.x1 - 0.5) col = j;
      return col;
    };

    const byPage = new Map<number, BodyLine[]>();
    for (const l of gridLines) byPage.set(l.page, [...(byPage.get(l.page) ?? []), l]);

    const tableRows: TableRowRecord[] = [];
    let header: string[] | null = null;
    let rowNo = 0;
    let firstPage = true;
    for (const [page, pageLines] of byPage) {
      const rows = this.buildRows(pageLines, colOf, starts.length);
      let dataRows = rows;
      let continued = !firstPage;
      if (mode === "grid") {
        if (firstPage) {
          header = rows[0] ?? null;
          dataRows = rows.slice(1);
        } else if (header && rows.length && sameRow(rows[0], header)) {
          dataRows = rows.slice(1);
        }
      }
      for (const cells of dataRows) {
        if (cells.every((c) => !c)) continue;
        const text = cells.join(" | ").trim();
        const record: Record<string, string> = {};
        if (mode === "kv") record[cells[0].replace(/:$/, "").trim()] = cells[1] ?? "";
        else header?.forEach((h, i) => (record[h || `col${i + 1}`] = cells[i] ?? ""));
        const cleanCells = mode === "kv" ? [cells[0].replace(/:$/, "").trim(), cells[1] ?? ""] : cells;
        tableRows.push({
          kind: mode,
          page,
          tableNo: 1,
          section: sectionName,
          rowNo: ++rowNo,
          header: mode === "grid" ? header : null,
          cells: cleanCells,
          record,
          text: mode === "kv" ? cleanCells.join(" | ").trim() : text,
          amounts: extractAmounts(cleanCells.join(" ")),
          continued,
        });
      }
      firstPage = false;
    }

    // Emit header into page text for the first page too, then rows grouped per page.
    if (header) push(gridLines[0].page, header.join(" | "));
    let block: { page: number; rows: TableRowRecord[] } | null = null;
    for (const row of tableRows) {
      push(row.page, row.text);
      if (!block) block = { page: row.page, rows: [] };
      block.rows.push(row);
    }
    if (block) blocks.push({ type: "table", page: block.page, section: sectionName, rows: block.rows });
  }

  private buildRows(lines: BodyLine[], colOf: (s: Seg) => number, ncols: number): string[][] {
    const segs = lines.flatMap((l) => l.segs).sort((a, b) => b.y - a.y || a.x0 - b.x0);
    const groups: CellGroup[] = [];
    for (let col = 0; col < ncols; col++) {
      let cur: { ys: number[]; texts: string[]; last: number; size: number } | null = null;
      const flush = () => {
        if (cur) groups.push({ col, yc: cur.ys.reduce((a, b) => a + b, 0) / cur.ys.length, text: norm(cur.texts.join(" ")) });
        cur = null;
      };
      for (const seg of segs) {
        if (colOf(seg) !== col) continue;
        if (cur && cur.last - seg.y > LAYOUT.sameCellFactor * cur.size) flush();
        if (!cur) cur = { ys: [], texts: [], last: seg.y, size: seg.size };
        cur.ys.push(seg.y);
        cur.texts.push(seg.text);
        cur.last = seg.y;
      }
      flush();
    }
    const anchors = groups.filter((g) => g.col === 0).sort((a, b) => b.yc - a.yc);
    if (!anchors.length) return [];
    const rows = anchors.map((a) => ({ yc: a.yc, cells: Array.from({ length: ncols }, (_, i) => (i === 0 ? [a] : [])) as CellGroup[][] }));
    for (const g of groups) {
      if (g.col === 0) continue;
      let best = 0;
      for (let i = 1; i < rows.length; i++) if (Math.abs(rows[i].yc - g.yc) < Math.abs(rows[best].yc - g.yc)) best = i;
      rows[best].cells[g.col].push(g);
    }
    return rows.map((r) => r.cells.map((cell) => norm(cell.sort((a, b) => b.yc - a.yc).map((g) => g.text).join(" "))));
  }

  private paragraphs(lines: BodyLine[]): Array<{ page: number; text: string }> {
    const out: Array<{ page: number; text: string; y: number; size: number }> = [];
    for (const line of lines) {
      const text = line.segs.map((s) => s.text).join(" ");
      const prev = out[out.length - 1];
      const bullet = /^[•▪‣◦\-*]\s/.test(text);
      if (prev && !bullet && prev.page === line.page && Math.abs(prev.size - line.size) < 0.5 && prev.y - line.y <= LAYOUT.paragraphFactor * line.size) {
        prev.text = `${prev.text} ${text}`;
        prev.y = line.y;
      } else out.push({ page: line.page, text, y: line.y, size: line.size });
    }
    return out.map((p) => ({ page: p.page, text: norm(p.text) }));
  }
}

function sameRow(a: string[], b: string[]): boolean {
  const n = Math.max(a.length, b.length);
  let same = 0;
  for (let i = 0; i < n; i++) if ((a[i] ?? "").toLowerCase() === (b[i] ?? "").toLowerCase()) same++;
  return same / n >= 0.6;
}
