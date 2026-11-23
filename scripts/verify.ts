/**
 * Data-layer and TattvaAI verification against the loaded synthetic dataset.
 * Run with `npm run verify`. Exits non-zero on any failed check.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { parse } from "csv-parse/sync";
import { getStore, validateReadOnlySql } from "../src/modules/procurement/server/db";
import { listCases, caseDetail, vendorDetail } from "../src/modules/procurement/server/entities";
import { getModule } from "../src/modules/procurement/server/modules";
import { MODULE_IDS } from "../src/modules/procurement/shared/types";
import { enterContext } from "../src/modules/procurement/server/platform/context";
import { DemoIdentityProvider } from "../src/modules/procurement/server/platform/identity";

let passed = 0;
function check(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  ok   ${name}`);
  } catch (error) {
    console.error(`  FAIL ${name}\n       ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  }
}

const store = getStore();
process.env.DEMO_LOGIN_PASSWORD = "verify-only";
enterContext({ principal: new DemoIdentityProvider().authenticate("cmd", "verify-only")!, requestId: "verify" });
const csvRows = (name: string) =>
  parse(readFileSync(path.join(store.dataDir, `${name}.csv`), "utf8"), { bom: true, columns: true, skip_empty_lines: true }) as Array<Record<string, string>>;

console.log(`Dataset: ${store.dataDir} (as of ${store.asOf}, ${store.tables.length} tables)`);

console.log("\nLoad fidelity");
for (const table of ["procurement_cases", "tender_master", "purchase_orders", "invoice_register", "payment_register", "approvals"]) {
  check(`${table}: SQLite row count equals CSV row count`, () => {
    const expected = csvRows(table).length;
    const actual = Number(store.query<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`)[0].n);
    assert.equal(actual, expected);
  });
}
check("sum of payment amounts equals CSV sum", () => {
  const expected = csvRows("payment_register").reduce((sum, row) => sum + Number(row.amount), 0);
  const actual = Number(store.query<{ s: number }>("SELECT SUM(amount) AS s FROM payment_register")[0].s);
  assert.ok(Math.abs(actual - expected) < 1, `${actual} vs ${expected}`);
});

console.log("\nModules and drill-downs");
const drills = new Set<string>();
for (const id of MODULE_IDS) {
  check(`module ${id} builds with KPIs and tables`, () => {
    const view = getModule(id);
    assert.ok(view && view.kpis.length > 0 && view.tables.length > 0);
    view.kpis.forEach((k) => k.drill && drills.add(k.drill));
    view.charts.forEach((c) => c.data.forEach((d) => d.drill && drills.add(d.drill)));
  });
}
check(`all ${drills.size} drill keys resolve to a case list`, () => {
  for (const key of drills) listCases({ drill: key, limit: 1 });
});
check("overview KPI 'Active cases' equals drill total", () => {
  const kpi = getModule("overview")!.kpis.find((k) => k.label === "Active cases")!;
  assert.equal(listCases({ drill: kpi.drill }).total, kpi.value);
});
check("case and vendor detail load with documents", () => {
  const detail = caseDetail("ADV-DEMO-2026-000001");
  assert.ok(detail && detail.sections.length >= 6 && detail.documents.length > 0);
  assert.ok(vendorDetail("ADV-V-0019"));
});

console.log("\nSQL guard");
for (const [sql, ok] of [
  ["SELECT COUNT(*) FROM procurement_cases", true],
  ["SELECT 'a;b' AS x FROM procurement_cases", true],
  ["DELETE FROM procurement_cases", false],
  ["SELECT 1; DROP TABLE vendor_master", false],
  ["SELECT * FROM not_a_table", false],
  ["WITH x AS (SELECT 1 AS n) SELECT * FROM x", true],
] as const) {
  check(`${ok ? "accepts" : "rejects"}: ${sql}`, () => assert.equal(validateReadOnlySql(sql, store).ok, ok));
}
check("store is read-only at the database level", () => {
  assert.throws(() => store.query("DELETE FROM vendor_master"));
});

console.log(`\n${passed} checks passed${process.exitCode ? ", some FAILED" : ""}`);
