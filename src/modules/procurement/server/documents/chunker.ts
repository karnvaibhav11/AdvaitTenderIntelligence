import type { Block, BlockType, ChunkDraft, Chunker, TableRowRecord } from "./types";

export const CHUNK_TARGET_MIN = 500;
export const CHUNK_MAX = 900;

interface Piece {
  type: BlockType;
  section: string;
  pageStart: number;
  pageEnd: number;
  text: string;
  /** table pieces only */
  header: string[] | null;
  rows: TableRowRecord[];
}

/**
 * Section- and table-aware chunker.
 *
 * Pieces are paragraphs (text) or row groups (tables; the header line is repeated in every
 * group). Consecutive pieces of the same type are packed into chunks of ~500-900 characters,
 * so small neighbouring sections share a chunk (its heading lists all of them) while a chunk
 * never mixes text with table rows and never exceeds 900 characters. Page numbers are tracked
 * per row/paragraph, the chunk keeps page_start/page_end. The chunker only sees one document's
 * blocks, so chunks can never span documents.
 */
export class SectionChunker implements Chunker {
  readonly name = "section-chunker-v2";

  chunk(blocks: Block[], opts: { title?: string | null } = {}): ChunkDraft[] {
    const title = opts.title ?? "";
    const pieces: Piece[] = [];
    for (const block of blocks) {
      if (block.type === "text") {
        for (const text of splitLong(block.text)) pieces.push({ type: "text", section: block.section, pageStart: block.page, pageEnd: block.page, text, header: null, rows: [] });
      } else {
        for (const group of packRows(block.rows)) {
          pieces.push({ type: "table", section: block.section, pageStart: group.pageStart, pageEnd: group.pageEnd, text: group.text, header: group.header, rows: group.rows });
        }
      }
    }

    const out: ChunkDraft[] = [];
    let cur: Piece[] = [];
    let len = 0;
    const flush = () => {
      if (!cur.length) return;
      const sections = [...new Set(cur.map((p) => p.section))];
      const heading = title && !(sections.length === 1 && sections[0] === title) ? `${title} > ${sections.join(" | ")}` : sections.join(" | ");
      const type = cur[0].type;
      const rows = cur.flatMap((p) => p.rows);
      out.push({
        chunkNo: out.length + 1,
        pageStart: Math.min(...cur.map((p) => p.pageStart)),
        pageEnd: Math.max(...cur.map((p) => p.pageEnd)),
        chunkType: type,
        heading,
        text: cur.map((p) => p.text).join("\n"),
        tableJson:
          type === "table"
            ? JSON.stringify({
                sections,
                tables: cur.map((p) => ({ section: p.section, header: p.header })),
                rows: rows.map((r) => ({ page: r.page, rowNo: r.rowNo, section: r.section, cells: r.cells, record: r.record, amounts: r.amounts })),
              })
            : null,
      });
      cur = [];
      len = 0;
    };
    for (const piece of pieces) {
      if (cur.length && (cur[0].type !== piece.type || len >= CHUNK_TARGET_MIN || len + piece.text.length + 1 > CHUNK_MAX)) flush();
      cur.push(piece);
      len += piece.text.length + 1;
    }
    flush();
    return out;
  }
}

function splitLong(text: string): string[] {
  if (text.length <= CHUNK_MAX) return [text];
  const sentences = text.split(/(?<=[.;!?])\s+/);
  const parts: string[] = [];
  let cur = "";
  for (const s of sentences) {
    if (cur && cur.length + s.length + 1 > 700) {
      parts.push(cur);
      cur = "";
    }
    cur = cur ? `${cur} ${s}` : s;
  }
  if (cur) parts.push(cur);
  // Pathological text without sentence breaks: hard split.
  return parts.flatMap((p) => (p.length <= CHUNK_MAX ? [p] : (p.match(new RegExp(`.{1,${CHUNK_MAX}}`, "gs")) ?? [p])));
}

function packRows(rows: TableRowRecord[]) {
  const out: Array<{ header: string[] | null; rows: TableRowRecord[]; text: string; pageStart: number; pageEnd: number }> = [];
  const header = rows[0]?.header ?? null;
  const headerLine = header ? header.join(" | ") : "";
  let cur: TableRowRecord[] = [];
  let len = headerLine.length;
  const flush = () => {
    if (!cur.length) return;
    const lines = [...(headerLine ? [headerLine] : []), ...cur.map((r) => r.text)];
    out.push({ header, rows: cur, text: lines.join("\n"), pageStart: Math.min(...cur.map((r) => r.page)), pageEnd: Math.max(...cur.map((r) => r.page)) });
    cur = [];
    len = headerLine.length;
  };
  for (const row of rows) {
    if (cur.length && len + row.text.length + 1 > CHUNK_MAX) flush();
    cur.push(row);
    len += row.text.length + 1;
  }
  flush();
  return out;
}
