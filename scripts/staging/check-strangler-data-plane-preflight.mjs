import assert from "node:assert/strict";
import fs from "node:fs";

// Read-only Cloudflare control-plane verification. No D1 queries, migrations,
// R2 writes, deployments, routes, Worker publish or cron activation.
const storefront = JSON.parse(
  fs.readFileSync("wrangler.storefront-strangler.stage.jsonc", "utf8"),
);
const producer = JSON.parse(
  fs.readFileSync("wrangler.storefront-candidate-producer.stage.jsonc", "utf8"),
);
const stageDbId = "e4cbb0ef-6288-4fa1-9dbb-fb42fe01d4f3";
const productionDbId = "4bd657ac-8789-403e-a28c-93aba8d0a989";
const db = storefront.d1_databases?.[0];
const producerDb = producer.d1_databases?.[0];
assert.equal(db?.database_id, stageDbId);
assert.equal(producerDb?.database_id, stageDbId);
assert.notEqual(db?.database_id, productionDbId);
assert.notEqual(producerDb?.database_id, productionDbId);
assert.equal(storefront.workers_dev, false);
assert.equal(producer.workers_dev, false);
assert.equal(storefront.preview_urls, false);
assert.equal(producer.preview_urls, false);
assert.ok(!storefront.routes && !producer.routes && !producer.triggers);
assert.notEqual(storefront.vars?.COVE_STRANGLER_READ_MODEL, "1");
const bucket = producer.r2_buckets?.find((x) => x.binding === "PRESENTATION")?.bucket_name;
const core = storefront.services?.find((x) => x.binding === "CORE")?.service;
assert.match(bucket || "", /^cove-strangler-private-presentation-stage$/);
assert.match(core || "", /^cove-thin-core-staging$/);
const account = process.env.CLOUDFLARE_ACCOUNT_ID || "";
const token = process.env.CLOUDFLARE_API_TOKEN || "";
if (!/^[0-9a-f]{32}$/.test(account) || !token)
  throw Error("Missing authorized Cloudflare staging read credentials in CI.");

async function check(label, endpoint, expectedId = "") {
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${account}${endpoint}`,
    {
      headers: { Authorization: "Bearer " + token },
      signal: AbortSignal.timeout(15000),
    },
  );
  // Log only component type and HTTP status, never token, response body,
  // account-specific contents or Worker source.
  console.log("COVE_STAGE_PREFLIGHT " + JSON.stringify({ component: label, status: response.status }));
  if (!response.ok) throw Error(label + " inaccessible (" + response.status + ")");
  if (expectedId) {
    const data = await response.json();
    if (!data.success || String(data.result?.uuid || data.result?.id || "") !== expectedId)
      throw Error(label + " returned a mismatched resource");
  }
}
await check("isolated_d1", "/d1/database/" + stageDbId, stageDbId);
await check("private_r2", "/r2/buckets/" + encodeURIComponent(bucket));
await check("staging_core", "/workers/scripts/" + encodeURIComponent(core));
console.log(
  "COVE_STAGE_PREFLIGHT PASS: existing isolated D1, private presentation bucket, staging CORE Worker; no resources changed.",
);
