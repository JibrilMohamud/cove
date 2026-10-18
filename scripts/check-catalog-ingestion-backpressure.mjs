import assert from "node:assert/strict";
import fs from "node:fs";
import { transform } from "esbuild";

const helperSource = fs.readFileSync("src/lib/catalog-ingestion-backpressure.ts", "utf8");
const workerSource = fs.readFileSync("src/persistence-backend.worker.ts", "utf8");
const { code } = await transform(helperSource, { loader: "ts", format: "esm" });
const { admitCatalogBatch, catalogAdmissionBudget } = await import(
  "data:text/javascript;base64," + Buffer.from(code).toString("base64")
);

assert.equal(catalogAdmissionBudget(undefined), 300);
assert.equal(catalogAdmissionBudget("0"), 300);
assert.equal(catalogAdmissionBudget("20"), 100);
assert.equal(catalogAdmissionBudget("50000"), 1000);
assert.equal(catalogAdmissionBudget("400"), 400);

let current = 0;
const clock = () => current;
const queries = [];
function db(result, elapsed, error) {
  return {
    prepare(sql) {
      assert.equal(sql, "SELECT 1 AS ok", "Admission must be a read-only primary D1 probe");
      queries.push(sql);
      return {
        async first() {
          current += elapsed;
          if (error) throw Error("D1 unavailable");
          return result;
        },
      };
    },
  };
}
const healthy = await admitCatalogBatch(db({ ok: 1 }, 40), 300, clock);
assert.deepEqual(healthy, { allowed: true, reason: "healthy", probeMs: 40 });
const busy = await admitCatalogBatch(db({ ok: 1 }, 420), 300, clock);
assert.deepEqual(busy, { allowed: false, reason: "primary_busy", probeMs: 420 });
const unavailable = await admitCatalogBatch(db(null, 2), 300, clock);
assert.deepEqual(unavailable, { allowed: false, reason: "primary_unavailable", probeMs: 2 });
const thrown = await admitCatalogBatch(db(null, 1, true), 300, clock);
assert.deepEqual(thrown, { allowed: false, reason: "primary_unavailable", probeMs: 1 });
assert.equal(queries.length, 4);

const batchStart = workerSource.indexOf("async function catalogBatch(");
const batchEnd = workerSource.indexOf("\nasync function maintenance(", batchStart);
assert.ok(batchStart >= 0 && batchEnd > batchStart);
const batch = workerSource.slice(batchStart, batchEnd);
assert.match(batch, /const deferred = await checkPrimaryBeforeBulkWork\("metadata"\)/);
assert.match(batch, /const deferred = await checkPrimaryBeforeBulkWork\("regional"\)/);
assert.match(batch, /const deferred = await checkPrimaryBeforeBulkWork\("epubs"\)/);
assert.match(batch, /const deferred = await checkPrimaryBeforeBulkWork\("search"\)/);
assert.ok(
  batch.indexOf('checkPrimaryBeforeBulkWork("metadata")') <
    batch.indexOf("runCatalogIngestion(env"),
);
assert.ok(
  batch.indexOf('checkPrimaryBeforeBulkWork("search")') < batch.indexOf("syncSearchIndex(env"),
);
assert.match(batch, /skipped: "primary_busy"/);
assert.match(batch, /pagesAttempted: results.length/);
// Primary rights, revocations, account deletion, checkout and reading must
// never be held behind ingestion backpressure.
assert.doesNotMatch(workerSource.slice(0, batchStart), /checkPrimaryBeforeBulkWork/);
assert.equal(workerSource.match(/checkPrimaryBeforeBulkWork/g)?.length, 5);
console.log(
  "Background catalog admission: bounded budget, healthy/busy/error cases, phase ordering, fail-closed deferral PASS",
);
