import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";

const js = ts.transpileModule(
  fs.readFileSync("src/features/fore/anonymous-presentation-cache.server.ts", "utf8"),
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } },
).outputText;
let tick = 1000;
let calls = 0;
let sessions = 0;
let mode = "ok";
const held = [];
const context = {
  exports: {},
  Date: class extends Date {
    static now() {
      return tick;
    }
  },
  structuredClone,
  require: () => ({
    networkCountry: (r, fallback) => ({
      country: r.headers.get("x-cove-client-country") || fallback,
      source: "network",
    }),
    resolveAnonymousHomepageContext: async (_db, r, fallback) => {
      calls++;
      if (mode === "fail") throw Error("D1 unavailable");
      if (mode === "hold") return new Promise((resolve) => held.push(resolve));
      return {
        rightsCountry: r.headers.get("x-cove-client-country") || fallback,
        locale: r.headers.get("accept-language"),
        messages: { hello: "Hi" },
      };
    },
  }),
};
vm.runInNewContext(js, context);
const cached = context.exports.anonymousPresentationContext;
const db = {};
const req = (country = "US", language = "en-US", extra = {}) =>
  new Request("https://cove.test/", {
    headers: { "x-cove-client-country": country, "accept-language": language, ...extra },
  });
const read = () => {
  sessions++;
  return {};
};
const get = (r = req(), database = db, fallback = "US") => cached(database, r, fallback, read);
mode = "hold";
const misses = Array.from({ length: 32 }, () => get());
assert.equal(calls, 32, "Cold concurrent invocations must each own their I/O");
assert.equal(new Set(misses).size, 32, "No cross-request pending promise sharing");
mode = "ok";
for (const resolve of held) resolve({ rightsCountry: "US", messages: { hello: "Hi" } });
await Promise.all(misses);
const snapshots = await Promise.all(Array.from({ length: 32 }, () => get()));
assert.equal(calls, 32, "Completed public snapshots should avoid redundant D1 reads");
assert.equal(sessions, 32, "Cache hits must not create database sessions");
snapshots[0].messages.hello = "changed";
assert.equal((await get()).messages.hello, "Hi", "Callers cannot mutate shared data");
for (const r of [
  req("CA"),
  req("US", "fr-FR"),
  req("US", "en-US", { cookie: "a=1" }),
  req("US", "en-US", { authorization: "Bearer x" }),
  req("US", "en-US", { "oai-authenticated-user-id": "u" }),
])
  await get(r);
assert.equal(calls, 37, "Country, locale and identity isolation");
await get(req(), {});
await get(req(), db, "CA");
assert.equal(calls, 39, "Database bindings and fallback configuration are separate");
await get(req("US", "a".repeat(257)));
await get(req("US", "a".repeat(257)));
assert.equal(calls, 41, "Overlong language headers bypass without truncation");
tick += 2000;
mode = "fail";
await assert.rejects(get(), /D1 unavailable/);
mode = "ok";
await get();
assert.equal(calls, 43, "Expired cache cannot hide errors or poison retries");
mode = "hold";
const slow = get(req("GB"));
tick += 2001;
held.at(-1)({ rightsCountry: "GB", messages: {} });
await slow;
mode = "ok";
const before = calls;
await get(req("GB"));
assert.equal(calls, before + 1, "A slow read must not extend the freshness limit");
// Eviction bounds memory even with adversarial distinct locale headers.
for (let i = 0; i < 33; i++) await get(req("US", "en-US,x-" + i));
const bounded = calls;
await get(req("US", "en-US,x-0"));
assert.equal(calls, bounded + 1, "Cache must evict beyond 32 entries");
console.log(
  "Completed-only public presentation cache: isolation, failures, expiry, no shared I/O passed",
);
