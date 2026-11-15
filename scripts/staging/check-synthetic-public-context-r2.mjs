import assert from "node:assert/strict";
import { build } from "esbuild";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cove-guest-context-r2-"));
try {
  await build({
    entryPoints: ["src/features/fore/synthetic-public-context-r2.stage.ts"],
    outfile: path.join(dir, "context.mjs"),
    bundle: true,
    platform: "node",
    format: "esm",
    logLevel: "silent",
  });
  const { eligibleStageContextRequest, resolveStagePublicContext } = await import(
    path.join(dir, "context.mjs")
  );
  let objects = new Map();
  let gets = 0;
  let puts = 0;
  const bucket = {
    async get(key) {
      gets++;
      const entry = objects.get(key);
      return entry
        ? { etag: entry.etag, size: entry.value.length, text: async () => entry.value }
        : null;
    },
    async put(key, value, options) {
      puts++;
      const old = objects.get(key);
      if (old && options.onlyIf.etagMatches !== old.etag) return null;
      if (!old && options.onlyIf.etagDoesNotMatch !== "*") return null;
      const etag = "fixture-" + puts;
      objects.set(key, { value, etag });
      return { etag };
    },
  };
  const env = {
    FORE_ENVIRONMENT: "production",
    COVE_SYNTHETIC_STAGING_ONLY: "e4cbb0ef-6288-4fa1-9dbb-fb42fe01d4f3",
    FORE_GUEST_COMPACT_STAGE: "1",
    FORE_GUEST_CONTEXT_R2_STAGE: "1",
    FORE_GUEST_COMPACT_SYNTHETIC_D1_ID: "e4cbb0ef-6288-4fa1-9dbb-fb42fe01d4f3",
    COVE_PUBLIC_PRESENTATION_CACHE: bucket,
  };
  const request = (headers = {}, url = "https://cove.invalid/api/fore/catalog?sort=popular&page=1&currency=USD") =>
    new Request(url, { headers: { "x-cove-client-country": "US", ...headers } });
  const context = {
    storefrontCountry: "US",
    rightsCountry: "US",
    networkCountry: "US",
    locale: "en-US",
    language: "en",
    currency: "USD",
    direction: "ltr",
    taxInclusive: false,
    recommendationRegion: "north-america",
    merchandisingRegion: "north-america",
    checkoutEnabled: true,
    source: { country: "network", locale: "negotiated", currency: "market" },
    paymentMethods: [
      { paymentMethod: "card", provider: "stripe", currency: "USD", availability: "available", priority: 1 },
    ],
    messages: { "catalog.title": "Catalog" },
    uiMessages: { greeting: "Hello" },
    availableMarkets: [
      { countryCode: "US", displayName: "United States", defaultLocale: "en-US", defaultCurrency: "USD", locales: ["en-US"], checkoutEnabled: true, taxInclusive: false },
    ],
  };
  let now = 500000;
  let liveReads = 0;
  const live = async () => {
    liveReads++;
    return structuredClone(context);
  };
  const req = request();
  assert.equal(eligibleStageContextRequest(env, req, null), true);
  assert.deepEqual(await resolveStagePublicContext(env, req, null, live, () => now), context);
  assert.equal(liveReads, 1);
  assert.equal(puts, 1);
  assert.deepEqual(await resolveStagePublicContext(env, req, null, live, () => now + 5), context);
  assert.equal(liveReads, 1, "Warm synthetic R2 hit must not call primary D1");
  assert.equal(puts, 1, "Warm hit must not rewrite presentation storage");
  now += 120_500;
  assert.deepEqual(await resolveStagePublicContext(env, req, null, live, () => now), context);
  assert.equal(liveReads, 2, "Expired projection must fail over to fresh D1 context");
  assert.equal(puts, 2, "Expired object is updated only with its etag");
  const secureCases = [
    [{ ...env, COVE_SYNTHETIC_STAGING_ONLY: undefined }, req, null],
    [{ ...env, FORE_GUEST_CONTEXT_R2_STAGE: "0" }, req, null],
    [{ ...env, FORE_GUEST_COMPACT_STAGE: "0" }, req, null],
    [{ ...env, FORE_GUEST_COMPACT_SYNTHETIC_D1_ID: "4bd657ac-8789-403e-a28c-93aba8d0a989" }, req, null],
    [env, request({ cookie: "user=private" }), null],
    [env, request({ authorization: "Bearer secret" }), null],
    [env, request({ "accept-language": "es-ES" }), null],
    [env, request({ "x-cove-client-country": "GB" }), null],
    [env, request({}, "https://cove.invalid/api/fore/catalog?sort=recent&page=1&currency=USD"), null],
    [env, req, "authenticated-user"],
  ];
  const before = gets;
  for (const [settings, r, principal] of secureCases) {
    assert.equal(eligibleStageContextRequest(settings, r, principal), false);
    await resolveStagePublicContext(settings, r, principal, live, () => now);
  }
  assert.equal(gets, before, "All protected, other-territory and non-default cases must avoid R2");
  assert.equal(liveReads, 2 + secureCases.length);

  // The public R2 context can remain warm after a market-status change.
  // It must NOT authorize books: the fresh primary D1 market fence is inside
  // the same live query that proves each book's territorial retail rights.
  const search = fs.readFileSync("src/features/fore/search.server.ts", "utf8");
  assert.match(search, /FORE_GUEST_CONTEXT_R2_STAGE === "1"/);
  assert.match(search, /part\.where\.push\(/);
  assert.match(search, /sm\.market_status='active'/);
  assert.match(search, /upper\(sm\.default_currency\)=upper\(\?\)/);
  assert.match(search, /part\.binds\.push\(input\.territory, input\.currency\)/);
  assert.match(search, /canonicalBoundedPopularPageByLiveRights\(env\.DB, part, 24\)/);
  const sql = new DatabaseSync(":memory:");
  try {
    sql.exec("CREATE TABLE storefront_markets(country_code TEXT,market_status TEXT,default_currency TEXT)");
    sql.prepare("INSERT INTO storefront_markets VALUES (?,?,?)").run("US", "active", "USD");
    const gate = sql.prepare(
      "SELECT EXISTS(SELECT 1 FROM storefront_markets sm WHERE sm.country_code=upper(?) AND sm.market_status='active' AND upper(sm.default_currency)=upper(?)) valid",
    );
    assert.equal(gate.get("US", "USD").valid, 1);
    sql.prepare("UPDATE storefront_markets SET market_status='paused' WHERE country_code='US'").run();
    assert.equal(gate.get("US", "USD").valid, 0, "A paused market must immediately lose live authority");
    sql.prepare("UPDATE storefront_markets SET market_status='active',default_currency='CAD'").run();
    assert.equal(gate.get("US", "USD").valid, 0, "Currency changes cannot borrow prior catalog rights");
  } finally {
    sql.close();
  }

  const api = fs.readFileSync("src/features/fore/api.server.ts", "utf8");
  assert.match(api, /resolveStagePublicContext\(/);
  assert.match(api, /resolveStorefrontContext\(/);
  for (const config of [
    "wrangler.backend.production.toml",
    "wrangler.backend.presentation-stage.toml",
  ]) {
    const source = fs.readFileSync(config, "utf8");
    assert.doesNotMatch(source, /FORE_GUEST_CONTEXT_R2_STAGE|COVE_SYNTHETIC_STAGING_ONLY/);
  }
  console.log(
    "PASS: synthetic R2 public context hit/miss/expiry, producer CAS, principal/territory denial and fresh primary active-market rights fence",
  );
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
