/**
 * Replace string literals, quoted identifiers and comments so keyword and
 * statement checks run only on real SQL tokens. A single left-to-right scan
 * handles escaped quotes and comment markers inside strings correctly.
 */
export function maskSql(sql: string): string {
  let out = "";
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];
    const next = sql[i + 1];
    if (ch === "-" && next === "-") {
      while (i < sql.length && sql[i] !== "\n") i++;
      out += " ";
    } else if (ch === "/" && next === "*") {
      const end = sql.indexOf("*/", i + 2);
      i = end < 0 ? sql.length : end + 2;
      out += " ";
    } else if (ch === "'" || ch === '"') {
      i++;
      while (i < sql.length) {
        if (sql[i] === ch) {
          if (sql[i + 1] === ch) i += 2;
          else break;
        } else i++;
      }
      i++;
      out += ch + ch;
    } else {
      out += ch;
      i++;
    }
  }
  return out;
}
