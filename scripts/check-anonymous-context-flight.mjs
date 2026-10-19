import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";

// Exercise the actual TypeScript implementation, but replace only the two
// injected Cloudflare data sources. No live database, grant cache or key leak.
const source = fs.readFileSync("src/features/fore/anonymous-context-flight.server.ts", "utf8");
const js = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
let calls = 0;
let tick = 1000;
let rejectNext = false;
let holdNext = false;
let releaseHeld = null;
const FakeDate = class extends Date {
  static now() {
    return tick;
  }
};
const cjs = { exports: {} };
const context = {
  exports: cjs.exports,
  Date: FakeDate,
  Request,
  URL,
  require: (name) => {
    assert.equal(name, "./localization.server");
    return {
      networkCountry: (request) => ({
        country: request.headers.get("x-cove-client-country") || "US",
        source: "network",
      }),
      resolveAnonymousHomepageContext: async (_db, request) => {
        calls++;
        if (holdNext) {
          holdNext = false;
          return new Promise((resolve) => {
            releaseHeld = resolve;
          });
        }
        if (rejectNext) {
          rejectNext = false;
          throw Error("temporary read failure");
        }
        return {
          rightsCountry: request.headers.get("x-cove-client-country") || "US",
          locale: request.headers.get("accept-language") || "en-US",
        };
      },
    };
  },
};
vm.runInNewContext(js, context, { filename: "anonymous-context-flight.server.ts" });
const shared = cjs.exports.sharedAnonymousHomepageContext;
assert.equal(typeof shared, "function");
const make = (country = "US", locale = "en-US", cookie = "") => {
  const headers = { "x-cove-client-country": country, "accept-language": locale };
  if (cookie) headers.cookie = cookie;
  return new Request("https://internal.invalid/", { headers });
};
const db = {};
const request = make();
const first = Array.from({ length: 32 }, () => shared(db, request, "US"));
assert.equal(new Set(first).size, 1, "Same public cohort must share pending metadata");
assert.equal(calls, 1, "Thirty-two requests must not enqueue 32 presentation reads");
await Promise.all(first);
assert.equal((await shared(db, request, "US")).rightsCountry, "US");
assert.equal(calls, 1, "Success should be reused within two seconds");
assert.equal((await shared(db, make("CA"), "US")).rightsCountry, "CA");
assert.equal((await shared(db, make("US", "fr-FR"), "US")).locale, "fr-FR");
assert.equal(calls, 3, "Country and locale must be distinct coalescing keys");
await shared(db, make("US", "en-US", "session=1"), "US");
await shared(db, make("US", "en-US", "session=2"), "US");
assert.equal(calls, 5, "Identity-bearing requests must never share cache");
tick += 2001;
await shared(db, request, "US");
assert.equal(calls, 6, "Expired metadata must be re-read");
rejectNext = true;
await assert.rejects(shared(db, make("GB"), "US"), /temporary read failure/);
await shared(db, make("GB"), "US");
assert.equal(calls, 8, "Rejected reads must never poison later requests");
const oversizeLanguage = "a".repeat(257);
await shared(db, make("US", oversizeLanguage), "US");
await shared(db, make("US", oversizeLanguage), "US");
assert.equal(calls, 10, "Overlong locale preferences must bypass the cache");
holdNext = true;
const blocked = make("DE");
const stuck = shared(db, blocked, "US");
assert.equal(shared(db, blocked, "US"), stuck, "Pending calls should coalesce");
assert.equal(calls, 11);
tick += 3001;
const retried = shared(db, blocked, "US");
assert.notEqual(retried, stuck, "Pending metadata sessions must expire");
assert.equal(calls, 12, "A stale pending flight must not block subsequent guests");
releaseHeld({ rightsCountry: "DE", locale: "en-US" });
await Promise.all([stuck, retried]);
console.log("Public metadata flight tests passed; all book rights remain individually rechecked");
