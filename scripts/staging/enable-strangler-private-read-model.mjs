import assert from "node:assert/strict";
import fs from "node:fs";

const file = ".output/strangler/protected-capacity.stage.jsonc";
const config = JSON.parse(fs.readFileSync(file, "utf8"));
assert.equal(config.main, "index.mjs");
assert.equal(config.d1_databases?.[0]?.database_id, "e4cbb0ef-6288-4fa1-9dbb-fb42fe01d4f3");
assert.equal(config.vars?.COVE_SSR_STAGING, "1");
assert.equal(config.vars?.COVE_STRANGLER_MODE, "isolated-evaluation");
assert.equal(config.r2_buckets?.[0]?.bucket_name, "cove-strangler-private-presentation-stage");
const run = process.env.GITHUB_RUN_ID || "";
assert.match(run, /^[1-9][0-9]{7,14}$/);
assert.equal(config.workers_dev, true);
assert.equal(config.preview_urls, false);
assert.ok(!config.routes && !config.route);
assert.equal(config.r2_buckets.length, 1);
assert.ok(!config.kv_namespaces, "KV must be attached only to the transient protected trial");
const prefix = `campaign/${run}/synthetic/`;
config.vars.COVE_STRANGLER_READ_MODEL = "2";
config.vars.COVE_PRESENTATION_KV_ACCELERATE = "1";
config.vars.COVE_PRESENTATION_PREFIX = prefix;
config.kv_namespaces = [
  { binding: "PRESENTATION_KV", id: "8245d5f2116a445d9571405b41b7c8c3" },
];
fs.writeFileSync(file, JSON.stringify(config, null, 2));
console.log("COVE_READ_MODEL_STAGE_ENABLED: run-scoped v2 R2/KV, fresh primary rights per request");
