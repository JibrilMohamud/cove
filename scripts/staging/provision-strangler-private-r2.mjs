import assert from "node:assert/strict";
import fs from "node:fs";

// One strictly named private R2 bucket, synthetic staging account only.
// No object writes, D1 mutations, Worker deployments, routes or domains.
const producer = JSON.parse(
  fs.readFileSync("wrangler.storefront-candidate-producer.stage.jsonc", "utf8"),
);
const service = JSON.parse(
  fs.readFileSync("wrangler.storefront-strangler.stage.jsonc", "utf8"),
);
const bucket = "cove-strangler-private-presentation-stage";
const dbId = "e4cbb0ef-6288-4fa1-9dbb-fb42fe01d4f3";
assert.equal(producer.r2_buckets?.[0]?.bucket_name, bucket);
assert.equal(producer.d1_databases?.[0]?.database_id, dbId);
assert.equal(service.d1_databases?.[0]?.database_id, dbId);
assert.equal(producer.workers_dev, false);
assert.equal(service.workers_dev, false);
assert.equal(producer.preview_urls, false);
assert.equal(service.preview_urls, false);
assert.ok(!producer.routes && !producer.triggers && !service.routes);
const account = process.env.CLOUDFLARE_ACCOUNT_ID || "";
const token = process.env.CLOUDFLARE_API_TOKEN || "";
if (!/^[0-9a-f]{32}$/.test(account) || !token)
  throw Error("Missing staging Cloudflare CI credentials");
const base = `https://api.cloudflare.com/client/v4/accounts/${account}`;
async function api(method, path, body) {
  const response = await fetch(base + path, {
    method,
    headers: {
      Authorization: "Bearer " + token,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(15000),
  });
  const data = await response.json();
  return { status: response.status, data };
}
const stage = await api("GET", "/d1/database/" + dbId);
if (!stage.data.success || stage.data.result?.uuid !== dbId)
  throw Error("Isolated staging D1 unavailable; no bucket may be created.");
const path = "/r2/buckets/" + bucket;
const existing = await api("GET", path);
if (existing.status === 200 && existing.data.success) {
  console.log("COVE_PRIVATE_STAGE_BUCKET: already exists");
} else if (existing.status === 404) {
  const result = await api("POST", "/r2/buckets", { name: bucket });
  console.log("COVE_PRIVATE_STAGE_BUCKET_CREATE " + result.status);
  if (!result.data.success || ![200, 201].includes(result.status) || result.data.result?.name !== bucket)
    throw Error("Staging bucket provisioning refused; no additional resources changed.");
} else {
  throw Error("Cannot verify bucket absence: HTTP " + existing.status);
}
const verify = await api("GET", path);
if (verify.status !== 200 || !verify.data.success || verify.data.result?.name !== bucket)
  throw Error("Dedicated stage bucket verification failed after creation");
console.log("COVE_PRIVATE_STAGE_BUCKET_PASS: isolated R2 exists; no public access or route was configured.");
