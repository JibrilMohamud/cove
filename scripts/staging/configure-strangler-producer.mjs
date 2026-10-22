import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

// All changes live under .output/strangler, never mutate checked config.
const mode = process.argv[2];
assert.ok(["enable", "disable"].includes(mode), "Only enable/disable modes are supported.");
const config = JSON.parse(
  fs.readFileSync("wrangler.storefront-candidate-producer.stage.jsonc", "utf8"),
);
const dbId = "e4cbb0ef-6288-4fa1-9dbb-fb42fe01d4f3";
assert.equal(config.d1_databases?.[0]?.database_id, dbId);
assert.equal(config.workers_dev, false);
assert.equal(config.preview_urls, false);
assert.ok(!config.routes && !config.route);
assert.equal(config.r2_buckets?.[0]?.bucket_name, "cove-strangler-private-presentation-stage");
// The generated config is alongside producer.mjs, not the repository root.
config.main = "producer.mjs";
config.triggers = { crons: mode === "enable" ? ["*/5 * * * *"] : [] };
fs.mkdirSync(".output/strangler", { recursive: true });
const filename = path.join(".output", "strangler", "producer-" + mode + ".stage.jsonc");
fs.writeFileSync(filename, JSON.stringify(config, null, 2));
console.log("COVE_PRODUCER_CONFIGURATION " + mode + " synthetic-only, private, no public route");
