import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const cfg = JSON.parse(readFileSync("wrangler.content-literary-infer.prod-draining.jsonc", "utf8"));
const workflow = readFileSync(".github/workflows/literary-infer-draining-canary.yml", "utf8");
const activate = readFileSync(
  "scripts/staging/activate-literary-draining-inference-budget.mjs",
  "utf8",
);
const verify = readFileSync("scripts/staging/verify-literary-draining-inference.mjs", "utf8");
const stop = readFileSync("scripts/staging/stop-literary-draining-infer.mjs", "utf8");
assert.equal(cfg.workers_dev, false);
assert.equal(cfg.preview_urls, false);
assert.ok(!cfg.routes && !cfg.route && !cfg.queues);
assert.deepEqual(cfg.triggers.crons, [], "Retired Worker must have no scheduled execution");
assert.equal(cfg.vars.FORE_CONTENT_PROCESSOR_ROLE, "literary-infer");
assert.equal(cfg.vars.FORE_LITERARY_AUTOPUBLISH_ENABLED, "0");
assert.equal(cfg.vars.FORE_CONTENT_BUDGET_MODE, "isolated");
assert.equal(cfg.vars.FORE_CONTENT_D1_ADMISSION_MAX_MS, "100");
for (const key of [
  "FORE_CONTENT_PROCESSOR_ENABLED",
  "FORE_CONTENT_PREPARE_ENABLED",
  "FORE_CONTENT_INFERENCE_ENABLED",
])
  assert.equal(cfg.vars[key], "0", "Retired Worker must never resume inference");
assert.deepEqual(
  cfg.d1_databases.map((x) => x.database_id),
  ["400c3af3-5d40-41fd-83cc-98228e40ddac"],
);
assert.ok(workflow.includes("github.ref == 'refs/heads/main'"));
assert.ok(workflow.includes("cancel-in-progress: false"));
assert.ok(workflow.includes("persist-credentials: false"));
assert.ok(!workflow.includes("wrangler deploy --config wrangler.content-literary-infer.prod-draining.jsonc"), "Retired Worker must never be redeployed by legacy QA canary");
assert.ok(workflow.includes("node --check scripts/staging/stop-literary-draining-infer.mjs"));
assert.ok(!workflow.includes("node scripts/staging/activate-literary-draining-inference-budget.mjs"), "Retired canary must not reactivate work");
assert.ok(activate.includes("legacyLeases"));
assert.ok(activate.includes("original_reserved_units"));
assert.ok(activate.includes("status='prepared'"));
assert.ok(activate.includes("status='active'"));
assert.ok(verify.includes("literary_processing_owner"));
assert.ok(verify.includes("FORE_LITERARY_AUTOPUBLISH_ENABLED"));
assert.ok(stop.includes('request("PUT", [])'));
console.log(
  "LITERARY_RETIRED_INFER_POLICY_PASS no canonical D1 access, cron, ingress or reactivation",
);
