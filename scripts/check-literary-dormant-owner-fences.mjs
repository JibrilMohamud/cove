import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(path, "utf8");
const worker = read("src/content-processing.worker.ts");
const handoff = read("src/lib/literary-prepare-outbox.server.ts");
const publisher = read("src/lib/literary-isolated-inference.server.ts");

// Deployment must contain all three independent owner boundaries. Config-only
// checks cannot certify that the built code actually enforces canonical D1.
assert.ok(worker.includes("readLiteraryProcessingOwner(env)"));
assert.ok(worker.includes("canonical_literary_owner_not_ready"));
for (const role of ["literary-prepare", "literary-handoff", "literary-infer"])
  assert.ok(worker.includes(`role === "${role}"`));
assert.ok(handoff.includes("canonical_owner_not_handoff"));
assert.ok(handoff.includes("canonical_owner_changed_after_claim"));
assert.ok(handoff.includes("activeHandoffFence"));
assert.ok(handoff.includes("value IN ('draining','isolated')"));
assert.ok(publisher.includes("canonical_owner_not_isolated"));
assert.ok(publisher.includes("WHERE key='literary_processing_owner' AND value='isolated'"));

for (const [path, switches] of [
  [
    "wrangler.content-literary-handoff.prod-disabled.jsonc",
    [
      "FORE_CONTENT_PROCESSOR_ENABLED",
      "FORE_CONTENT_PREPARE_ENABLED",
      "FORE_CONTENT_HANDOFF_ENABLED",
    ],
  ],
  [
    "wrangler.content-literary-prepare.prod-disabled.jsonc",
    ["FORE_CONTENT_PROCESSOR_ENABLED", "FORE_CONTENT_PREPARE_ENABLED"],
  ],
  [
    "wrangler.content-literary-infer.prod-disabled.jsonc",
    [
      "FORE_CONTENT_PROCESSOR_ENABLED",
      "FORE_CONTENT_PREPARE_ENABLED",
      "FORE_CONTENT_INFERENCE_ENABLED",
    ],
  ],
]) {
  const config = JSON.parse(read(path));
  assert.equal(config.workers_dev, false);
  assert.equal(config.preview_urls, false);
  assert.ok(!config.routes && !config.route && !config.triggers && !config.queues);
  for (const key of switches) assert.equal(config.vars[key], "0");
  if (path === "wrangler.content-literary-prepare.prod-disabled.jsonc") {
    assert.deepEqual(config.r2_buckets, [
      { binding: "BUCKET", bucket_name: "cove-literary-originals-isolated-20261024" },
      { binding: "SOURCE_BUCKET", bucket_name: "cove-production-media" },
    ]);
  }
  if (path === "wrangler.content-literary-infer.prod-disabled.jsonc") {
    assert.equal(config.vars.FORE_LITERARY_AUTOPUBLISH_ENABLED, "0");
    assert.deepEqual(config.services, [
      { binding: "LITERARY_PUBLISHER", service: "cove-literary-publisher-isolated-disabled" },
    ]);
  }
}
console.log(
  "LITERARY_DORMANT_OWNER_FENCES_PASS legacy denial, atomic claim, isolated-only canonical publication, no triggers",
);
