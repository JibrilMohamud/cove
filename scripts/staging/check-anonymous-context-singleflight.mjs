import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { transform } from "esbuild";

const source = readFileSync("src/features/fore/anonymous-context-singleflight.server.ts", "utf8");
const { code } = await transform(source, { loader: "ts", format: "esm" });
const { singleflightAnonymousPresentation: run } = await import(
  "data:text/javascript;base64," + Buffer.from(code).toString("base64")
);
const db = {};
const anonymous = (country = "US", lang = "en-US", other = {}) =>
  new Request("https://cove.invalid/", {
    headers: { "accept-language": lang, ...other },
  });
let calls = 0;
let resolve;
const slow = () => {
  calls++;
  return new Promise((r) => {
    resolve = r;
  });
};
const us = anonymous();
const first = run(db, us, "US", true, slow);
const same = run(db, anonymous(), "US", true, slow);
assert.strictEqual(
  same,
  first,
  "Concurrent, identical public presentation calls share one promise",
);
await Promise.resolve();
assert.equal(calls, 1);
resolve({ market: "US", rights: "not-checked-here" });
const [one, two] = await Promise.all([first, same]);
assert.deepEqual(one, two);
await run(db, us, "US", true, async () => {
  calls++;
  return { market: "US" };
});
assert.equal(calls, 2, "A completed presentation result is NOT cached");

let active = 0;
const releases = [];
const pause = () => {
  active++;
  return new Promise((r) => {
    releases.push(r);
  });
};
const australia = run(db, anonymous("AU"), "AU", true, pause);
const canada = run(db, anonymous("CA"), "CA", true, pause);
await Promise.resolve();
assert.equal(active, 2, "Territories cannot share one presentation operation");
for (const finish of releases) finish("market");
await Promise.all([australia, canada]);

const personalized = anonymous("US", "en-US", { Cookie: "fore-currency=USD" });
let privateCalls = 0;
const cookieA = run(db, personalized, "US", true, async () => ++privateCalls);
const cookieB = run(db, personalized, "US", true, async () => ++privateCalls);
await Promise.all([cookieA, cookieB]);
assert.equal(privateCalls, 2, "Cookies forbid request coalescing");
const idRequest = anonymous("US", "en-US", { "x-fore-authenticated-user-id": "user" });
const identityA = run(db, idRequest, "US", true, async () => ++privateCalls);
const identityB = run(db, idRequest, "US", true, async () => ++privateCalls);
await Promise.all([identityA, identityB]);
assert.equal(privateCalls, 4, "Explicit identity headers forbid coalescing");

let faults = 0;
const reject1 = run(db, anonymous("US", "fr-CA"), "US", false, async () => {
  faults++;
  throw new Error("temporary unavailable");
});
const reject2 = run(db, anonymous("US", "fr-CA"), "US", false, async () => {
  faults++;
  return 1;
});
assert.strictEqual(reject1, reject2, "Concurrent failures share the same in-flight call");
await assert.rejects(reject1, /temporary unavailable/);
await Promise.resolve();
await run(db, anonymous("US", "fr-CA"), "US", false, async () => ++faults);
assert.equal(faults, 2, "Failures never remain cached");

console.log(
  "Anonymous singleflight: concurrent-only, country/locale/private isolation and fail-open retry PASS",
);
