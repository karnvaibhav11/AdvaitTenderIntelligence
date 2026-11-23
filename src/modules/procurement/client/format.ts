import type { Fmt, RecordRow, Tone } from "../shared/types";

const full = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 });
const decimal = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 1 });

export function compactMoney(value: number): string {
  const abs = Math.abs(value);
  const sign = value < 0 ? "-" : "";
  if (abs >= 1e7) return `${sign}₹${(abs / 1e7).toFixed(abs >= 1e9 ? 0 : 2)} Cr`;
  if (abs >= 1e5) return `${sign}₹${(abs / 1e5).toFixed(2)} L`;
  return `${sign}₹${full.format(Math.round(abs))}`;
}

export function fullMoney(value: number): string {
  return `${value < 0 ? "-" : ""}₹${full.format(Math.abs(Math.round(value)))}`;
}

export function formatDate(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (!match) return value;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return date.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" });
}

export function formatValue(value: RecordRow[string] | undefined, fmt: Fmt = "text", compact = false): string {
  if (value === null || value === undefined || value === "") return "–";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  switch (fmt) {
    case "money":
      return typeof value === "number" || !Number.isNaN(Number(value)) ? (compact ? compactMoney(Number(value)) : fullMoney(Number(value))) : String(value);
    case "int":
      return Number.isNaN(Number(value)) ? String(value) : full.format(Number(value));
    case "num":
      return Number.isNaN(Number(value)) ? String(value) : decimal.format(Number(value));
    case "pct":
      return Number.isNaN(Number(value)) ? String(value) : `${decimal.format(Number(value))}%`;
    case "days":
      return Number.isNaN(Number(value)) ? String(value) : `${full.format(Number(value))} d`;
    case "date":
      return formatDate(String(value));
    default:
      return String(value);
  }
}

export function toneOf(text: string): Tone {
  if (/critical|high|reject|disqual|overdue|disput|cancel|breach|escalate|false/i.test(text)) return "bad";
  if (/medium|pending|partial|delay|review|open|extended|reminder|augment|under|late|missing|expired|in rectification/i.test(text)) return "warn";
  if (/low|paid|closed|approved|accepted|complete|qualified|valid|met|l1|true|on track|verified|active|within|resolved|met|issued/i.test(text)) return "good";
  return "neutral";
}

export function rowsToCsv(columns: Array<{ key: string; label: string }>, rows: RecordRow[]): string {
  const escape = (value: unknown) => {
    const text = value === null || value === undefined ? "" : String(value);
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  return [columns.map((c) => escape(c.label)).join(","), ...rows.map((row) => columns.map((c) => escape(row[c.key])).join(","))].join("\n");
}
