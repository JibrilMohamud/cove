import assert from "node:assert/strict";
import fs from "node:fs";
import { transform } from "esbuild";

const source = fs.readFileSync("src/features/fore/storefront-inflight-public-metadata.ts", "utf8");
const bootstrap = fs.readFileSync("src/features/fore/storefront-anonymous-bootstrap.server.ts", "utf8");
assert.match(bootstrap, /withCompletedAnonymousMarketReads\(/);
assert.match(bootstrap, /env\.COVE_SSR_STAGING === "1"/);
assert.match(bootstrap, /firstPaintStorefrontShelf\(readEnv, null, trustedCountry, d1Metrics/);
assert.match(bootstrap, /env\.DB : undefined/);
const { code } = await transform(source, { loader: "ts", format: "esm" });
const { withCompletedAnonymousMarketReads: completed, safeMarketKey } = await import(
  "data:text/javascript;base64," + Buffer.from(code).toString("base64")
);
const sql = `WITH RECURSIVE active_market AS MATERIALIZED (SELECT 1),
chosen_locale AS MATERIALIZED (SELECT 1)
SELECT m.*,l.locale FROM active_market m LEFT JOIN chosen_locale l ON 1=1`;
const parameters = (country = "US", locales = ["en-US"]) => [
  country,
  JSON.stringify(locales),
];
assert.equal(safeMarketKey(sql, parameters()), 'US:["en-US"]');
assert.equal(safeMarketKey("SELECT 1", parameters()), null);

let reads = 0;
let currentValue = "version-1";
const db = {
  prepare(statement) {
    return {
      bind(...args) {
        return {
          async all() {
            reads++;
            return {
              success: true,
              results: [
                {
                  country: args[0],
                  locales: args[1],
                  paymentMethods: [],
                  publicTitle: currentValue,
                },
              ],
              meta: { rows_read: 123 },
            };
          },
        };
      },
    };
  },
};
const scope = {};
let hits = 0;
const read = async (country = "US", locales = ["en-US"], bindingScope = scope) => {
  const reader = completed(db, bindingScope, () => hits++);
  return reader.prepare(sql).bind(...parameters(country, locales)).all();
};
const first = await read();
assert.equal(reads, 1);
currentValue = "version-2";
const second = await read();
assert.equal(reads, 1, "Only completed public data is reused");
assert.equal(hits, 1);
assert.deepEqual(second.results, first.results);
second.results[0].publicTitle = "poison";
assert.equal((await read()).results[0].publicTitle, "version-1", "Clone every hit");
await read("CA", ["fr-CA"]);
await read("US", ["fr-CA"]);
await read("US", ["en-US"], {});
assert.equal(reads, 4, "Country, locale and D1 binding scopes are isolated");

// Never store pending work across visitors, even with identical public params.
let unblock;
const gate = new Promise((resolve) => {
  unblock = resolve;
});
let concurrent = 0;
const slowDb = {
  prepare() {
    return {
      bind() {
        return {
          async all() {
            concurrent++;
            await gate;
            return { results: [{ publicTitle: "completed" }], success: true };
          },
        };
      },
    };
  },
};
const slowScope = {};
const a = completed(slowDb, slowScope).prepare(sql).bind(...parameters()).all();
const b = completed(slowDb, slowScope).prepare(sql).bind(...parameters()).all();
assert.equal(concurrent, 2, "Each concurrent miss must own its D1 I/O");
unblock();
await Promise.all([a, b]);
assert.equal(
  (await completed(slowDb, slowScope).prepare(sql).bind(...parameters()).all()).results[0]
    .publicTitle,
  "completed",
);
assert.equal(concurrent, 2);

const realNow = Date.now;
try {
  Date.now = () => realNow() + 2_001;
  assert.equal((await read()).results[0].publicTitle, "version-2", "Expired data rereads D1");
  assert.equal(reads, 5);
} finally {
  Date.now = realNow;
}
let failures = 0;
const broken = {
  prepare() {
    return {
      bind() {
        return {
          async all() {
            failures++;
            throw Error("private provider failure");
          },
        };
      },
    };
  },
};
const invalid = completed(broken, {});
await assert.rejects(invalid.prepare(sql).bind(...parameters()).all(), /private provider failure/);
await assert.rejects(invalid.prepare(sql).bind(...parameters()).all(), /private provider failure/);
assert.equal(failures, 2, "Failed public reads never populate cache");

let largeReads = 0;
const large = {
  prepare() {
    return {
      bind() {
        return {
          async all() {
            largeReads++;
            return { results: [{ oversized: "x".repeat(130 * 1024) }] };
          },
        };
      },
    };
  },
};
const bounded = completed(large, {});
await bounded.prepare(sql).bind(...parameters()).all();
await bounded.prepare(sql).bind(...parameters()).all();
assert.equal(largeReads, 2, "Oversized public payload must be re-read");
await completed(db, scope).prepare("SELECT 1").bind(...parameters()).all();
assert.equal(reads, 6, "Unrecognized SQL must bypass completed cache");
console.log("Completed public market cache: cloned short TTL, no pending I/O, country/locale/scope, failure and limits PASS");
