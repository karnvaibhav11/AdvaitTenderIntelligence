import { getDocumentProxy } from "unpdf";
import type { PageExtractor, RawPage, TextItem } from "./types";

// Control characters left over from un-mapped glyphs (typically Devanagari
// matras/conjuncts without a ToUnicode entry). Dropping them recovers most words.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\ufffd]/g;

export function cleanText(value: string): string {
  return value.replace(CONTROL, "").replace(/\u00a0/g, " ");
}

interface PdfJsItem {
  str: string;
  transform: number[];
  width: number;
  height: number;
}

/** PDF.js (via unpdf) text-layer extractor returning positioned runs per page. */
export class PdfJsPageExtractor implements PageExtractor {
  readonly name = "pdfjs-unpdf";

  async extractPages(bytes: Uint8Array): Promise<RawPage[]> {
    // PDF.js transfers/detaches the buffer, so hand it a copy.
    const pdf = await getDocumentProxy(new Uint8Array(bytes));
    try {
      const pages: RawPage[] = [];
      for (let pageNo = 1; pageNo <= pdf.numPages; pageNo++) {
        const page = await pdf.getPage(pageNo);
        const [, , width, height] = page.view;
        const content = await page.getTextContent();
        const items: TextItem[] = [];
        for (const raw of content.items as unknown as PdfJsItem[]) {
          if (typeof raw.str !== "string" || !raw.transform) continue;
          const text = cleanText(raw.str);
          const size = Math.hypot(raw.transform[2], raw.transform[3]) || raw.height || 0;
          items.push({ text, x: raw.transform[4], y: raw.transform[5], width: raw.width, size });
        }
        pages.push({ pageNo, width, height, items });
        page.cleanup();
      }
      return pages;
    } finally {
      await (pdf as unknown as { loadingTask?: { destroy?: () => Promise<void> } }).loadingTask?.destroy?.();
    }
  }
}
