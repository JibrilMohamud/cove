import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { transform } from "esbuild";

const source = readFileSync("src/lib/literary-budget-domain.server.ts", "utf8");
const { code } = await transform(source, { loader: "ts", format: "esm" });
const { reserveLiteraryBudget, resolveLiteraryBudgetDb } = await import(
  "data:text/javascript;base64," + Buffer.from(code).toString("base64")
);

function wrapper(sqlite) {
  return {
    prepare(sql) {
      const statement = sqlite.prepare(sql);
      return {
        bind(...args) {
          return {
            async first() {
              return statement.get(...args) ?? null;
            },
            async run() {
              return statement.run(...args);
            },
          };
        },
        async first() {
          return statement.get() ?? null;
        },
      };
    },
  };
}
const primaryDb = new DatabaseSync(":memory:");
primaryDb.exec(
  "CREATE TABLE cove_runtime_config(key TEXT PRIMARY KEY,value TEXT);" +
    "CREATE TABLE literary_profile_budget(day TEXT PRIMARY KEY,reserved_units INTEGER NOT NULL,calls INTEGER NOT NULL);",
);
const isolatedDb = new DatabaseSync(":memory:");
isolatedDb.exec(readFileSync("infra/content-budget/0001_ledger.sql", "utf8"));
const primary = wrapper(primaryDb);
const content = wrapper(isolatedDb);
const day = "2026-10-20";
const env = {
  DB: primary,
  CONTENT_DB: content,
  FORE_CONTENT_PROCESSOR_ROLE: "literary",
  FORE_CONTENT_PROCESSOR_ENABLED: "1",
  FORE_CONTENT_BUDGET_MODE: "primary",
};
assert.strictEqual(await resolveLiteraryBudgetDb(env, day), primary);
assert.ok(await reserveLiteraryBudget(primary, day, 120, 400, false));
assert.ok(await reserveLiteraryBudget(primary, day, 50, 400, false));
assert.equal(primaryDb.prepare("SELECT reserved_units FROM literary_profile_budget").get().reserved_units, 170);
assert.equal(await reserveLiteraryBudget(primary, day, 500, 400, false), null);

await assert.rejects(resolveLiteraryBudgetDb({ ...env, FORE_CONTENT_BUDGET_MODE: "isolated" }, day), /not_authorized/);
primaryDb.prepare("INSERT INTO cove_runtime_config(key,value) VALUES('literary_budget_domain','isolated')").run();
await assert.rejects(resolveLiteraryBudgetDb(env, day), /primary_fenced/);
assert.equal(await reserveLiteraryBudget(primary, day, 1, 400, false), null, "Late primary write must fail its atomic SQL fence");
assert.equal(primaryDb.prepare("SELECT reserved_units FROM literary_profile_budget").get().reserved_units, 170);

const external = { ...env, FORE_CONTENT_BUDGET_MODE: "isolated" };
await assert.rejects(resolveLiteraryBudgetDb(external, day), /not_seeded/);
await assert.rejects(resolveLiteraryBudgetDb({ ...external, CONTENT_DB: primary }, day), /not_authorized/);
await assert.rejects(resolveLiteraryBudgetDb({ ...external, FORE_CONTENT_PROCESSOR_ROLE: "assets" }, day), /not_authorized/);
await assert.rejects(resolveLiteraryBudgetDb({ ...external, FORE_CONTENT_PROCESSOR_ENABLED: "0" }, day), /not_authorized/);
isolatedDb.prepare(
  "INSERT INTO literary_profile_budget(day,reserved_units,calls) VALUES(?,?,?)",
).run(day, 170, 2);
isolatedDb.prepare(
  "INSERT INTO literary_budget_cutover(day,status,original_reserved_units,original_calls,prepared_at,activated_at,operator_receipt)" +
    " VALUES(?,'prepared',170,2,'2026-10-20T12:00Z',NULL,'stage-fixture')",
).run(day);
await assert.rejects(resolveLiteraryBudgetDb(external, day), /not_seeded/);
isolatedDb.prepare("UPDATE literary_budget_cutover SET status='active' WHERE day=?").run(day);
assert.strictEqual(await resolveLiteraryBudgetDb(external, day), content);
const debitResults = await Promise.all(
  Array.from({ length: 5 }, () => reserveLiteraryBudget(content, day, 60, 400, true)),
);
assert.equal(debitResults.filter(Boolean).length, 3, "Atomic second-domain reservation never exceeds seeded remaining budget");
assert.deepEqual(isolatedDb.prepare("SELECT reserved_units,calls FROM literary_profile_budget").get(), {
  reserved_units: 350,
  calls: 5,
});
assert.equal(primaryDb.prepare("SELECT reserved_units FROM literary_profile_budget").get().reserved_units, 170);
isolatedDb.prepare("UPDATE literary_budget_cutover SET status='closed' WHERE day=?").run(day);
assert.equal(await reserveLiteraryBudget(content, day, 1, 400, true), null, "SQL fence must prevent late debit after closure");
await assert.rejects(resolveLiteraryBudgetDb(external, day), /not_seeded/);
await assert.rejects(resolveLiteraryBudgetDb(external, "2026-10-21"), /not_seeded/);
await assert.rejects(resolveLiteraryBudgetDb(external, "garbage"), /Invalid/);
await assert.rejects(reserveLiteraryBudget(content, day, -1, 400, true), /Invalid/);

const literaryCode = readFileSync("src/features/fore/literary-profiles.server.ts", "utf8");
assert.match(literaryCode, /await resolveLiteraryBudgetDb\(env, day\)/);
assert.match(literaryCode, /await reserveLiteraryBudget\(/);
assert.match(literaryCode, /await settleLiteraryOutputReservation\(\s*budgetDb!/);
assert.ok(
  literaryCode.indexOf("await reserveLiteraryBudget(") <
    literaryCode.indexOf("await env.AI.run(PROFILE_MODEL"),
  "Never incur billable inference before a quota reservation",
);
primaryDb.close();
isolatedDb.close();
console.log("Separate D1 budget authority: primary fence, seeded day, atomic quotas, fail-closed cutover and R2 settlement routing passed.");
