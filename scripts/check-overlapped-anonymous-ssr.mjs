import assert from "node:assert/strict";
import fs from "node:fs";
import { build } from "esbuild";

async function loadFile(path) {
  const output = await build({
    entryPoints: [path],
    platform: "node",
    format: "esm",
    bundle: true,
    write: false,
  });
  return import(
    "data:text/javascript;base64," + Buffer.from(output.outputFiles[0].text).toString("base64")
  );
}
const { canRunAnonymousHomepageBootstrap } = await loadFile(
  "src/features/fore/anonymous-bootstrap-eligibility.server.ts",
);
const {
  currentCoveRequestEnvironment,
  currentCoveRequestAnonymousBootstrap,
  withCoveRequestEnvironment,
} = await loadFile("src/lib/cove-request-env.server.ts");

const env = { DB: { prepare() {} }, COVE_STOREFRONT_READ_LIMITER: { limit() {} } };
const base = { "cf-connecting-ip": "203.0.113.10", "x-cove-client-country": "US" };
const valid = (path = "/", method = "GET", headers = {}) =>
  new Request("https://cove.test" + path, { method, headers: { ...base, ...headers } });
assert.equal(canRunAnonymousHomepageBootstrap(valid(), env, "/"), true);
assert.equal(
  canRunAnonymousHomepageBootstrap(
    valid("/api/fore/storefront/bootstrap"),
    env,
    "/api/fore/storefront/bootstrap",
  ),
  true,
);
for (const test of [
  valid("/?q=books"),
  valid("/store"),
  valid("/", "POST"),
  valid("/", "GET", { Cookie: "session=private" }),
  valid("/", "GET", { Authorization: "Bearer private" }),
  valid("/", "GET", { "oai-authenticated-user-id": "user" }),
  valid("/", "GET", { "oai-authenticated-user-email": "private" }),
  valid("/", "GET", { "x-fore-authenticated-user-id": "user" }),
  valid("/", "GET", { "x-cove-client-country": "invalid" }),
  valid("/", "GET", { "cf-connecting-ip": "" }),
]) {
  assert.equal(canRunAnonymousHomepageBootstrap(test, env, "/"), false);
}
assert.equal(canRunAnonymousHomepageBootstrap(valid(), { DB: env.DB }, "/"), false);
assert.equal(
  canRunAnonymousHomepageBootstrap(
    valid(),
    { COVE_STOREFRONT_READ_LIMITER: env.COVE_STOREFRONT_READ_LIMITER },
    "/",
  ),
  false,
);

// Two interleaved visitors must never receive one another's prestarted
// rights response or environment even if the first request waits longer.
const alice = Promise.resolve(new Response("alice-rights"));
const bob = Promise.resolve(new Response("bob-rights"));
const tasks = [
  withCoveRequestEnvironment(
    { requestId: "alice" },
    async () => {
      await Promise.resolve();
      assert.equal(currentCoveRequestEnvironment()?.requestId, "alice");
      assert.strictEqual(currentCoveRequestAnonymousBootstrap(), alice);
      assert.equal(await (await currentCoveRequestAnonymousBootstrap()).text(), "alice-rights");
    },
    undefined,
    alice,
  ),
  withCoveRequestEnvironment(
    { requestId: "bob" },
    async () => {
      assert.equal(currentCoveRequestEnvironment()?.requestId, "bob");
      assert.strictEqual(currentCoveRequestAnonymousBootstrap(), bob);
      await Promise.resolve();
      assert.equal(currentCoveRequestEnvironment()?.requestId, "bob");
      assert.equal(await (await currentCoveRequestAnonymousBootstrap()).text(), "bob-rights");
    },
    undefined,
    bob,
  ),
];
await Promise.all(tasks);
assert.equal(currentCoveRequestAnonymousBootstrap(), undefined);
assert.equal(currentCoveRequestEnvironment(), undefined);

// Fail closed. The request-scoped result must never be converted into public
// HTML on an error, nor shared with a subsequent request.
const failure = Promise.reject(new Error("D1 rights query unavailable"));
void failure.catch(() => {});
await withCoveRequestEnvironment(
  {},
  async () => {
    assert.strictEqual(currentCoveRequestAnonymousBootstrap(), failure);
    await assert.rejects(currentCoveRequestAnonymousBootstrap(), /D1 rights query unavailable/);
  },
  undefined,
  failure,
);
assert.equal(currentCoveRequestAnonymousBootstrap(), undefined);

const entry = fs.readFileSync("src/server.ts", "utf8");
const loader = fs.readFileSync("src/features/fore/storefront-loader.ts", "utf8");
const lean = fs.readFileSync("src/features/fore/storefront-anonymous-bootstrap.server.ts", "utf8");
assert.match(entry, /canRunAnonymousHomepageBootstrap\(/);
assert.match(entry, /prefetchedBootstrap\s*=\s*import\(/);
assert.match(entry, /const handler = await getServerEntry\(\)/);
assert.ok(
  entry.indexOf("prefetchedBootstrap = import(") <
    entry.indexOf("const handler = await getServerEntry()"),
  "D1 must start ahead of the SSR framework entry",
);
assert.match(entry, /void prefetchedBootstrap\.catch\(\(\) => \{\}\)/);
assert.match(loader, /currentCoveRequestAnonymousBootstrap\(\) \?\?/);
assert.match(loader, /canUseLeanAnonymousBootstrap\(/);
assert.match(lean, /firstPaintStorefrontShelf\(env, null, trustedCountry, d1Metrics\)/);
assert.doesNotMatch(entry, /(?:catalog|rights)Cache\.set\(/);
console.log("Anonymous early SSR concurrency, rights authority, and rejection isolation PASS");
