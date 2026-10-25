import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(path, "utf8");
const workflow = read(".github/workflows/literary-progressive-canonical-publication.yml");
const inference = JSON.parse(read("wrangler.content-literary-infer.prod-isolated.jsonc"));
const publisher = JSON.parse(read("wrangler.literary-publisher.prod-isolated.jsonc"));
const preflight = read("scripts/staging/preflight-literary-isolated-publication.mjs");
const promotion = read("scripts/staging/promote-literary-isolated-owner.mjs");
const validation = read("scripts/staging/verify-literary-real-publication.mjs");
const rollback = read("scripts/staging/rollback-literary-isolated-publication.mjs");
for (const cfg of [inference, publisher]) {
  assert.equal(cfg.workers_dev, false);
  assert.equal(cfg.preview_urls, false);
  assert.ok(!cfg.routes && !cfg.route && !cfg.queues);
  assert.deepEqual(
    cfg.d1_databases.map((x) => x.database_id),
    ["4bd657ac-8789-403e-a28c-93aba8d0a989", "400c3af3-5d40-41fd-83cc-98228e40ddac"],
  );
  assert.equal(cfg.secrets.required.length, 2);
}
assert.equal(inference.name, "cove-literary-infer-isolated-disabled");
assert.equal(publisher.name, "cove-literary-publisher-isolated-disabled");
assert.deepEqual(inference.triggers.crons, ["* * * * *"]);
assert.ok(!publisher.triggers);
assert.equal(inference.vars.FORE_LITERARY_AUTOPUBLISH_ENABLED, "1");
assert.equal(publisher.vars.FORE_LITERARY_INFERENCE_PUBLISH_ENABLED, "1");
assert.equal(inference.vars.FORE_CONTENT_D1_ADMISSION_MAX_MS, "100");
assert.equal(inference.vars.FORE_CONTENT_BUDGET_MODE, "isolated");
for (const flag of [
  "FORE_CONTENT_PROCESSOR_ENABLED",
  "FORE_CONTENT_PREPARE_ENABLED",
  "FORE_CONTENT_INFERENCE_ENABLED",
]) assert.equal(inference.vars[flag], "1");
assert.ok(inference.services.some((x) => x.binding === "LITERARY_PUBLISHER" && x.service === publisher.name));
for (const fragment of [
  "github.ref == 'refs/heads/main'",
  "cancel-in-progress: false",
  "persist-credentials: false",
  "needs: static",
  "steps.preflight.outcome == 'success'",
  "rollback-literary-isolated-publication.mjs",
  "verify-literary-real-publication.mjs",
]) assert.ok(workflow.includes(fragment));
assert.ok(preflight.includes('literary_processing_owner: "draining"'));
assert.ok(preflight.includes('stage[0]?.result, "passed"'));
assert.ok(promotion.includes("status='done'"));
assert.ok(promotion.includes("value='isolated'"));
assert.ok(validation.includes('coverage: "isolated_samples"'));
assert.ok(validation.includes("job.profile_revision + 1"));
assert.ok(rollback.includes("literary_processing_owner' AND value='isolated'"));
assert.ok(rollback.includes("earlierInference"));
console.log("LITERARY_PROGRESSIVE_PUBLICATION_POLICY_PASS scoped no-route Workers, budget fence, revision proof, rollback");
