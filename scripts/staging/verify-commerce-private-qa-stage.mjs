import assert from "node:assert/strict";

const account = "d26430caa63ec55f6612e32f36aca5e9";
const token = process.env.CLOUDFLARE_API_TOKEN;
assert.ok(token && process.env.CLOUDFLARE_ACCOUNT_ID === account);
async function api(method, path, data) {
  const response = await fetch("https://api.cloudflare.com/client/v4" + path, {
    method,
    headers: {
      authorization: "Bearer " + token,
      ...(data ? { "content-type": "application/json" } : {}),
    },
    ...(data ? { body: JSON.stringify(data) } : {}),
    signal: AbortSignal.timeout(20000),
  });
  const payload = await response.json();
  assert.ok(response.ok && payload.success, "Private QA Cloudflare inspection rejected");
  return payload.result;
}
const name = "cove-commerce-customer-qa-stage";
const settings = await api("GET", "/accounts/" + account + "/workers/scripts/" + name + "/settings");
const details = await api("GET", "/accounts/" + account + "/workers/workers/" + name);
const binds = settings.bindings || [];
for (const secret of [
  "COVE_SSR_STAGING_GATE_KEY",
  "STRIPE_SECRET_KEY",
  "STRIPE_PUBLISHABLE_KEY",
]) {
  assert.ok(
    binds.some((b) => b.name === secret && b.type === "secret_text"),
    "Dedicated TEST staging credential not installed: " + secret,
  );
}
assert.ok(
  binds.some(
    (b) =>
      b.name === "DB" && b.type === "d1" &&
      b.id === "5be15110-44a6-4090-b0a1-36599d809b28",
  ),
);
assert.ok(
  binds.some(
    (b) =>
      b.name === "BUCKET" && b.type === "r2_bucket" &&
      b.bucket_name === "cove-commerce-original-media-qa-20261022",
  ),
);
assert.ok(
  binds.some(
    (b) => b.name === "STRIPE_LIVEMODE" && b.text === "false",
  ),
);
assert.equal(details.subdomain?.enabled, false, "QA must not yet have an unauthenticated URL");
assert.equal(details.subdomain?.previews_enabled, false);
const database = "5be15110-44a6-4090-b0a1-36599d809b28";
const query = await api("POST", "/accounts/" + account + "/d1/database/" + database + "/query", {
  sql: "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('products','auth_accounts','entitlements','asset_versions','commerce_orders','commercial_audio_chapters')",
});
const schema = new Set(query?.[0]?.results?.map((x) => x.name) || []);
for (const table of ["products","auth_accounts","entitlements","asset_versions","commerce_orders","commercial_audio_chapters"])
  assert.ok(schema.has(table), "Incomplete dedicated QA D1 migration: " + table);
console.log("PASS: isolated QA full app schema deployed privately with authenticated test-only keys; no public route.");
