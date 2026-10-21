import assert from "node:assert/strict";
import fs from "node:fs";

const file = ".output/strangler/protected-capacity.stage.jsonc";
const config = JSON.parse(fs.readFileSync(file, "utf8"));
assert.equal(config.main, "index.mjs");
assert.equal(config.d1_databases?.[0]?.database_id, "e4cbb0ef-6288-4fa1-9dbb-fb42fe01d4f3");
assert.equal(config.vars?.COVE_SSR_STAGING, "1");
assert.equal(config.vars?.COVE_STRANGLER_MODE, "isolated-evaluation");
assert.equal(config.r2_buckets?.[0]?.bucket_name, "cove-strangler-private-presentation-stage");
config.vars.COVE_STRANGLER_READ_MODEL = "1";
fs.writeFileSync(file, JSON.stringify(config, null, 2));
console.log("COVE_READ_MODEL_STAGE_ENABLED: private candidates still require live primary rights");
