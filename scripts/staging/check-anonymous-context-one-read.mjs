import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { build } from "esbuild";

const dir = fs.mkdtempSync(path.join(process.cwd(), ".cove-anon-context-"));
const sqlite = new DatabaseSync(":memory:");
try {
  sqlite.exec("PRAGMA foreign_keys=ON");
  for (const file of fs.readdirSync("drizzle").filter((f) => /^\\d+.*\\.sql$/.test(f)).sort())
    sqlite.exec(fs.readFileSync("drizzle/" + file, "utf8"));
  await build({
    entryPoints: ["src/features/fore/localization.server.ts"], bundle: true,
    platform: "node", format: "esm", packages: "external",
    outfile: path.join(dir, "localization.mjs"), logLevel: "silent",
  });
  const { resolveStorefrontContext: original, resolveAnonymousStorefrontContext: optimized } =
    await import(path.join(dir, "localization.mjs"));
  let trips = 0;
  function statement(sql, params = []) {
    assert.match(sql.trim(), /^(SELECT|WITH)\\b/i, "Presentation read must never mutate D1");
    assert.doesNotMatch(sql, /rights_grants|entitlements|commerce_orders/i,
      "Presentation configuration cannot authorize customer access");
    return {
      sql, params,
      bind(...values) { return statement(sql, values); },
      async first() { trips++; return sqlite.prepare(sql).get(...params) || null; },
      async all() { trips++; return { results: sqlite.prepare(sql).all(...params) }; },
      async run() { throw Error("Presentation resolver cannot write"); },
    };
  }
  const db = {
    prepare: statement,
    async batch(statements) {
      trips++;
      return statements.map((q) => ({ results: sqlite.prepare(q.sql).all(...q.params) }));
    },
  };
  const request = (country = "US", language = "", extra = {}) => new Request("https://cove.invalid/", {
    headers: { ...(country ? { "x-cove-client-country": country } : {}),
      "accept-language": language, ...extra },
  });
  let checked = 0;
  async function parity(req, includeMarkets = false, fallback = "US") {
    const expected = await original(db, req, null, fallback, includeMarkets)
      .then((value) => ({ value }), (error) => ({ error: error.message, status: error.status }));
    trips = 0;
    const actual = await optimized(db, req, fallback, includeMarkets)
      .then((value) => ({ value }), (error) => ({ error: error.message, status: error.status }));
    assert.deepEqual(actual, expected, "Canonical locale, currency, payment and translation parity");
    assert.equal(trips, 1, "Exactly one D1 service trip per anonymous context");
    checked++;
    return actual;
  }
  const countries = sqlite.prepare("SELECT country_code FROM storefront_markets WHERE market_status='active'")
    .all().map((m) => m.country_code);
  const languages = ["", "en-US", "fr-FR", "ar-SA", "de-DE", "es-MX", "fr-CA,en;q=0.7",
    "xx-YY,pt_BR;q=0.9,en;q=0.2", "en-GB,en-US;q=0.9", "*;q=0.8", "zz;q=1,fr;q=0"];
  for (const country of [...countries, "ZZ", "NZ"])
    for (const language of languages)
      for (const include of [false, true]) await parity(request(country, language), include);
  await parity(request(null, "fr"), true);
  await parity(request(null, "ar"), false, "SA");

  async function mutation(action, verify) {
    sqlite.exec("SAVEPOINT parity");
    try { action(); await verify(); }
    finally { sqlite.exec("ROLLBACK TO parity"); sqlite.exec("RELEASE parity"); }
  }
  await mutation(() => sqlite.exec("UPDATE storefront_markets SET market_status='paused' WHERE country_code='US'"),
    async () => { await parity(request("US"), true); });
  await mutation(() => sqlite.exec("UPDATE storefront_market_locales SET active=0 WHERE country_code='US'"),
    async () => { await parity(request("US", "en-US"), true); });
  await mutation(() => sqlite.exec(
    "UPDATE storefront_locales SET fallback_locale='fr-FR' WHERE locale='en-US';" +
    "UPDATE storefront_locales SET fallback_locale='en-US' WHERE locale='fr-FR'"),
    async () => { await parity(request("FR", "fr-FR"), true); await parity(request("US"), false); });
  await mutation(() => sqlite.exec(
    "UPDATE ui_translation_messages SET message_value='Updated public copy' WHERE bundle_id IN " +
    "(SELECT id FROM ui_translation_bundles WHERE locale='en-US' AND status='active')"),
    async () => { const result = await parity(request("US"), true);
      assert.ok(Object.values(result.value.messages).includes("Updated public copy")); });
  await mutation(() => sqlite.exec("UPDATE storefront_markets SET market_status='paused'"),
    async () => { const result = await parity(request("US"), true); assert.ok(result.error); });
  for (const header of ["cookie", "authorization", "oai-authenticated-user-id",
    "oai-authenticated-user-email", "x-fore-authenticated-user-id", "x-fore-authenticated-user-email"]) {
    trips = 0;
    await assert.rejects(optimized(db, request("US", "", { [header]: "present" })), /Anonymous context/);
    assert.equal(trips, 0, "Private requests never start anonymous SQL");
  }
  await assert.rejects(optimized(db, new Request("https://cove.invalid/", { method: "POST" })),
    /Anonymous context/);
  await assert.rejects(optimized({ prepare() { throw Error("D1 unavailable"); } }, request()), /D1 unavailable/);
  assert.deepEqual(sqlite.prepare("PRAGMA foreign_key_check").all(), []);
  console.log(JSON.stringify({ pass: true, canonicalComparisons: checked,
    serviceTripsPerContext: 1, privateRequestsDenied: true, translationUpdatesVisible: true }));
} finally {
  sqlite.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
