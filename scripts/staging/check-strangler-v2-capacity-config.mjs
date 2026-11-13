import assert from "node:assert/strict";
import fs from "node:fs";

// Source-only CI check. Do not publish, provision, query D1 or contact R2/KV.
const stage = "e4cbb0ef-6288-4fa1-9dbb-fb42fe01d4f3";
const production = "4bd657ac-8789-403e-a28c-93aba8d0a989";
const run = "43419027989";
const original = JSON.parse(fs.readFileSync("wrangler.storefront-strangler.stage.jsonc", "utf8"));
assert.equal(original.workers_dev, false);
assert.equal(original.preview_urls, false);
assert.equal(original.d1_databases?.[0]?.database_id, stage);
assert.ok(!original.r2_buckets && !original.kv_namespaces && !original.routes);
const prior = process.env.GITHUB_RUN_ID;
process.env.GITHUB_RUN_ID = run;
try {
  await import("./prepare-strangler-capacity-config.mjs");
  await import("./enable-strangler-private-read-model.mjs");
} finally {
  if (prior === undefined) delete process.env.GITHUB_RUN_ID;
  else process.env.GITHUB_RUN_ID = prior;
}
const ephemeral = JSON.parse(
  fs.readFileSync(".output/strangler/protected-capacity.stage.jsonc", "utf8"),
);
assert.equal(ephemeral.workers_dev, true);
assert.equal(ephemeral.preview_urls, false);
assert.ok(!ephemeral.routes && !ephemeral.route);
assert.equal(ephemeral.d1_databases?.[0]?.database_id, stage);
assert.notEqual(ephemeral.d1_databases?.[0]?.database_id, production);
assert.equal(ephemeral.r2_buckets?.length, 1);
assert.equal(ephemeral.r2_buckets?.[0]?.binding, "PRESENTATION");
assert.equal(
  ephemeral.r2_buckets?.[0]?.bucket_name,
  "cove-strangler-private-presentation-stage",
);
assert.deepEqual(ephemeral.kv_namespaces, [
  { binding: "PRESENTATION_KV", id: "8245d5f2116a445d9571405b41b7c8c3" },
]);
assert.equal(ephemeral.vars?.COVE_STRANGLER_READ_MODEL, "2");
assert.equal(ephemeral.vars?.COVE_PRESENTATION_KV_ACCELERATE, "1");
assert.equal(ephemeral.vars?.COVE_SSR_STAGING, "1");
assert.equal(ephemeral.vars?.COVE_STRANGLER_MODE, "isolated-evaluation");
assert.equal(ephemeral.vars?.COVE_PRESENTATION_PREFIX, "campaign/" + run + "/synthetic/");
assert.ok(!JSON.stringify(ephemeral).includes("production/current/"));
assert.equal(ephemeral.ratelimits?.[0]?.simple?.limit, 10000);
assert.equal(original.ratelimits?.[0]?.simple?.limit, 180);
const seed = fs.readFileSync("scripts/staging/seed-strangler-v2-capacity.mjs", "utf8");
const cleanup = fs.readFileSync("scripts/staging/cleanup-strangler-v2-capacity.mjs", "utf8");
for (const source of [seed, cleanup]) {
  assert.ok(source.includes(stage) || source.includes("cove.stage.v2.cleanup.v1"));
  assert.ok(!source.includes(production));
  assert.ok(!source.includes("production/current/"));
  assert.ok(!source.includes("cove-production-private-presentation"));
}
assert.match(seed, /produceHomepagePresentation\(db, country, store\)/);
assert.match(seed, /(?:SELECT\|WITH)/);
assert.match(cleanup, /assert\.equal\(objectKey, prefix/);
console.log(
  "PASS: private v2 capacity config, synthetic-only read seed, exact per-run KV/R2 cleanup, no production routing",
);
