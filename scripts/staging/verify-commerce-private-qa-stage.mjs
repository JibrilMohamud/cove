import assert from "node:assert/strict";
import {
  originalQaRoyaltyCoverageSql,
  assertOriginalQaRoyaltyCoverage,
} from "./original-commerce-qa-royalties.mjs";

const account = "f51e8ccbc394e2d6016ff8c2c303d54b";
const token = process.env.CLOUDFLARE_API_TOKEN;
const d1Token = process.env.COVE_CF_QA_D1_MUTATION_TOKEN;
assert.ok(token && d1Token && token !== d1Token && process.env.CLOUDFLARE_ACCOUNT_ID === account);
async function api(method, path, data) {
  const response = await fetch("https://api.cloudflare.com/client/v4" + path, {
    method,
    headers: {
      authorization: "Bearer " + (path.includes("/d1/database/") ? d1Token : token),
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
const settings = await api(
  "GET",
  "/accounts/" + account + "/workers/scripts/" + name + "/settings",
);
const details = await api("GET", "/accounts/" + account + "/workers/workers/" + name);
const binds = settings.bindings || [];
for (const secret of [
  "COVE_SSR_STAGING_GATE_KEY",
  "STRIPE_SECRET_KEY",
  "STRIPE_PUBLISHABLE_KEY",
  "SUPABASE_PUBLISHABLE_KEY",
]) {
  assert.ok(
    binds.some((b) => b.name === secret && b.type === "secret_text"),
    "Dedicated TEST staging credential not installed: " + secret,
  );
}
assert.ok(
  binds.some(
    (b) =>
      b.name === "DB" &&
      b.type === "d1" &&
      (b.id || b.database_id) === "f9354381-bd9f-496b-bd05-d6f62a32ec0c",
  ),
);
assert.ok(
  binds.some(
    (b) =>
      b.name === "BUCKET" &&
      b.type === "r2_bucket" &&
      b.bucket_name === "cove-commerce-detached-media-qa",
  ),
);
assert.equal(binds.filter((b) => b.type === "d1").length, 1);
assert.equal(binds.filter((b) => b.type === "r2_bucket").length, 1);
assert.equal(settings.routes?.length || 0, 0);
assert.ok(binds.some((b) => b.name === "STRIPE_LIVEMODE" && b.text === "false"));
assert.equal(details.subdomain?.enabled, false, "QA must not yet have an unauthenticated URL");
assert.equal(details.subdomain?.previews_enabled, false);
const database = "f9354381-bd9f-496b-bd05-d6f62a32ec0c";
const query = await api("POST", "/accounts/" + account + "/d1/database/" + database + "/query", {
  sql: "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('products','auth_accounts','entitlements','asset_versions','commerce_orders','commercial_audio_chapters')",
});
const schema = new Set(query?.[0]?.results?.map((x) => x.name) || []);
for (const table of [
  "products",
  "auth_accounts",
  "entitlements",
  "asset_versions",
  "commerce_orders",
  "commercial_audio_chapters",
])
  assert.ok(schema.has(table), "Incomplete dedicated QA D1 migration: " + table);
const royalty = await api("POST", "/accounts/" + account + "/d1/database/" + database + "/query", {
  sql: originalQaRoyaltyCoverageSql(new Date().toISOString()),
});
assertOriginalQaRoyaltyCoverage(royalty[0].results);
console.log(
  "PASS: isolated QA full app schema and exact royalty prerequisites verified; test-only keys; no public route.",
);
