import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const source = JSON.parse(
  fs.readFileSync("wrangler.storefront-strangler.stage.jsonc", "utf8"),
);
const producer = JSON.parse(
  fs.readFileSync("wrangler.storefront-candidate-producer.stage.jsonc", "utf8"),
);
const stageDb = "e4cbb0ef-6288-4fa1-9dbb-fb42fe01d4f3";
assert.equal(source.d1_databases?.[0]?.database_id, stageDb);
assert.equal(producer.d1_databases?.[0]?.database_id, stageDb);
assert.equal(source.services?.[0]?.service, "cove-thin-core-staging");
assert.equal(source.workers_dev, false);
assert.equal(source.preview_urls, false);
assert.ok(!source.routes && !source.route);
assert.equal(source.vars?.COVE_SSR_STAGING, "1");
assert.equal(source.vars?.COVE_STRANGLER_MODE, "isolated-evaluation");
const bucket = "cove-strangler-private-presentation-stage";
assert.equal(producer.r2_buckets?.[0]?.bucket_name, bucket);
assert.ok(!source.r2_buckets, "Committed config must remain private/unroutable and conservative");
const ephemeral = structuredClone(source);
ephemeral.workers_dev = true;
// Wrangler resolves main relative to the generated config directory.
ephemeral.main = "index.mjs";
ephemeral.preview_urls = false;
ephemeral.r2_buckets = [{ binding: "PRESENTATION", bucket_name: bucket }];
ephemeral.vars.COVE_STRANGLER_READ_MODEL = "0";
ephemeral.vars.FORE_PUBLIC_URL =
  "https://cove-strangler-m1-staging.cove-jibrilmohamud.workers.dev";
// One CI runner shares a source IP. Lift the synthetic-only per-IP limiter
// in this transient config so it measures capacity instead of abuse controls.
// Canonical production limiter behavior remains separately covered by tests.
ephemeral.ratelimits[0].simple.limit = 10000;
fs.mkdirSync(".output/strangler", { recursive: true });
const file = path.join(".output", "strangler", "protected-capacity.stage.jsonc");
fs.writeFileSync(file, JSON.stringify(ephemeral, null, 2));
console.log("COVE_STAGE_CAPACITY_CONFIG: synthetic D1, private R2, gated ingress; production config unchanged.");
