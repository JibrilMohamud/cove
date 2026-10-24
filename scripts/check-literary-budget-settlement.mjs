import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { transform } from "esbuild";
import fs from "node:fs";

const source = fs.readFileSync("src/lib/literary-budget-settlement.ts", "utf8");
const { code } = await transform(source, { loader: "ts", format: "esm" });
const { literaryOutputReservationRefund, settleLiteraryOutputReservation } = await import(
  "data:text/javascript;base64," + Buffer.from(code).toString("base64")
);

assert.equal(literaryOutputReservationRefund(6000, 1250, 12000), 10750);
assert.equal(literaryOutputReservationRefund(6000, 12000, 12000), 0);
assert.equal(literaryOutputReservationRefund(6000, 15000, 12000), 0);
assert.equal(literaryOutputReservationRefund(-1, 1000, 12000), 0);
assert.equal(literaryOutputReservationRefund(NaN, 1000, 12000), 0);

const sqlDb = new DatabaseSync(":memory:");
sqlDb.exec(
  "CREATE TABLE literary_profile_budget(day TEXT PRIMARY KEY,reserved_units INTEGER NOT NULL,calls INTEGER NOT NULL)",
);
sqlDb.exec(fs.readFileSync("drizzle/0079_literary_output_settlement_receipts.sql", "utf8"));
assert.equal(
  fs.readFileSync("drizzle/0079_literary_output_settlement_receipts.sql", "utf8"),
  fs.readFileSync("infra/content-budget/0005_literary_output_settlement_receipts.sql", "utf8"),
  "Canonical and isolated budget ledgers must use exactly the same schema",
);
sqlDb.prepare("INSERT INTO literary_profile_budget VALUES(?,?,?)").run("2026-10-20", 15000, 1);
const prepare = (sql, params = []) => ({
  bind(...v) {
    return prepare(sql, v);
  },
  async run() {
    const result = sqlDb.prepare(sql).run(...params);
    return { meta: { changes: Number(result.changes) } };
  },
});
let serialized = Promise.resolve();
const db = {
  prepare,
  batch(statements) {
    // The Node fixture shares one SQLite handle. Serialize explicit
    // transactions just as D1 serializes writes against one database.
    const execute = async () => {
      sqlDb.exec("BEGIN IMMEDIATE");
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        sqlDb.exec("COMMIT");
        return results;
      } catch (e) {
        sqlDb.exec("ROLLBACK");
        throw e;
      }
    };
    const operation = serialized.then(execute);
    serialized = operation.catch(() => {});
    return operation;
  },
};
const receipt = "literary/inference/cove-literary-v1/" + "a".repeat(64) + ".json";
const first = await settleLiteraryOutputReservation(db, "2026-10-20", 6000, 1250, 12000, receipt);
assert.deepEqual(first, { refunded: 10750 });
assert.equal(
  sqlDb.prepare("SELECT reserved_units FROM literary_profile_budget WHERE day='2026-10-20'").get()
    .reserved_units,
  4250,
);
const raced = await Promise.all(
  Array.from({ length: 12 }, () =>
    settleLiteraryOutputReservation(db, "2026-10-20", 6000, 1250, 12000, receipt),
  ),
);
assert.ok(
  raced.every((v) => v.refunded === 0),
  "Concurrent replays cannot refund a second time",
);
assert.equal(
  sqlDb.prepare("SELECT count(*) n FROM literary_output_settlement_receipts").get().n,
  1,
);
assert.equal(
  sqlDb
    .prepare("SELECT applied FROM literary_output_settlement_receipts WHERE receipt_key=?")
    .get(receipt).applied,
  1,
);
assert.equal(
  sqlDb.prepare("SELECT reserved_units FROM literary_profile_budget WHERE day='2026-10-20'").get()
    .reserved_units,
  4250,
);
assert.deepEqual(
  await settleLiteraryOutputReservation(
    db,
    "2026-10-21",
    6000,
    1250,
    12000,
    "literary/inference/cove-literary-v1/" + "b".repeat(64) + ".json",
  ),
  { refunded: 0 },
  "A non-existent daily reservation cannot create money/work credit",
);
assert.deepEqual(
  await settleLiteraryOutputReservation(db, "2026-10-20", 6000, 20000, 12000, receipt),
  { refunded: 0 },
);
await assert.rejects(
  settleLiteraryOutputReservation(db, "today", 6000, 1250, 12000, receipt),
  /Invalid literary budget settlement day/,
);
await assert.rejects(
  settleLiteraryOutputReservation(db, "2026-10-20", 6000, 1250, 12000, "untrusted"),
  /Invalid literary settlement receipt key/,
);
const literarySource = fs.readFileSync("src/features/fore/literary-profiles.server.ts", "utf8");
assert.match(literarySource, /FORE_LITERARY_ACTUAL_UNIT_SETTLEMENT === "1"/);
assert.ok(
  literarySource.indexOf("await env.BUCKET.put(cacheKey") <
    literarySource.indexOf("await settleLiteraryOutputReservation("),
  "R2 must publish validated output before an accounting refund",
);
assert.match(
  literarySource,
  /if \(!cached && env\.FORE_LITERARY_ACTUAL_UNIT_SETTLEMENT === "1"\)/,
  "R2 cache hits never receive additional credits",
);
assert.match(literarySource, /reservedOutput,\s*cacheKey,/);
sqlDb.close();
console.log(
  "Atomic exactly-once literary work-budget refund, concurrent replay and R2 gating passed.",
);
