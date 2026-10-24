import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(path, "utf8");
const config = JSON.parse(read("wrangler.literary-publisher.prod-disabled.jsonc"));
assert.equal(config.name, "cove-literary-publisher-isolated-disabled");
assert.equal(config.main, "literary-publisher-dist/worker.js");
assert.equal(config.workers_dev, false);
assert.equal(config.preview_urls, false);
assert.equal(config.vars.FORE_LITERARY_INFERENCE_PUBLISH_ENABLED, "0");
assert.ok(!config.routes && !config.route && !config.triggers && !config.queues);
assert.deepEqual(
  config.d1_databases.map((x) => x.database_id),
  ["4bd657ac-8789-403e-a28c-93aba8d0a989", "400c3af3-5d40-41fd-83cc-98228e40ddac"],
);
assert.deepEqual(
  config.r2_buckets.map((x) => x.bucket_name),
  ["cove-literary-originals-isolated-20261024"],
);
assert.ok(!config.vars.FORE_LITERARY_INFERENCE_PUBLISH_TOKEN_SHA256);
assert.ok(!config.vars.FORE_LITERARY_INFERENCE_BACKEND_TOKEN_SHA256);
const gateway = read("src/literary-inference-publisher.worker.ts");
const publisher = read("src/lib/literary-isolated-inference.server.ts");
assert.ok(gateway.includes('env.FORE_LITERARY_INFERENCE_PUBLISH_ENABLED !== "1"'));
assert.ok(gateway.includes("literary_publisher_unauthorized"));
assert.ok(gateway.includes("primary_d1_busy"));
assert.ok(publisher.includes('owner?.value !== "isolated"'));
assert.ok(publisher.includes("WHERE key='literary_processing_owner' AND value='isolated'"));
assert.ok(publisher.includes("literarySourceRightsPredicate"));
console.log(
  "LITERARY_DORMANT_PUBLISHER_CONFIG_PASS no ingress, triggers or keys; isolated-only canonical publication",
);
