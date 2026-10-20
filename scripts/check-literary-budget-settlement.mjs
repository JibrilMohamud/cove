import assert from "node:assert/strict";
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

const updates = [];
const db = {
  prepare(sql) {
    assert.match(sql, /^UPDATE literary_profile_budget SET reserved_units=MAX/);
    return {
      bind(refund, day) {
        return {
          async run() {
            updates.push({ refund, day });
          },
        };
      },
    };
  },
};
assert.deepEqual(await settleLiteraryOutputReservation(db, "2026-10-20", 6000, 1250, 12000), {
  refunded: 10750,
});
assert.deepEqual(updates, [{ refund: 10750, day: "2026-10-20" }]);
assert.deepEqual(await settleLiteraryOutputReservation(db, "2026-10-20", 6000, 20000, 12000), {
  refunded: 0,
});
assert.equal(updates.length, 1);
await assert.rejects(
  settleLiteraryOutputReservation(db, "today", 6000, 1250, 12000),
  /Invalid literary budget settlement day/,
);
const literarySource = fs.readFileSync("src/features/fore/literary-profiles.server.ts", "utf8");
assert.match(literarySource, /FORE_LITERARY_ACTUAL_UNIT_SETTLEMENT === "1"/);
assert.ok(
  literarySource.indexOf("await env.BUCKET.put(cacheKey") <
    literarySource.indexOf("await settleLiteraryOutputReservation("),
  "R2 must publish verified canonical output before a budget refund",
);
assert.match(
  literarySource,
  /if \(!cached && env\.FORE_LITERARY_ACTUAL_UNIT_SETTLEMENT === "1"\)/,
  "R2 cache hits must never refund previously reserved work again",
);
console.log("Literary bounded work-budget settlement, cache order, and opt-in gates passed.");
