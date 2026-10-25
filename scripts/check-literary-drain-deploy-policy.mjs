import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const workflow = readFileSync(".github/workflows/literary-drain-worker-deploy.yml", "utf8");
const preflight = readFileSync("scripts/staging/verify-literary-drain-predeploy.mjs", "utf8");
const verifier = readFileSync("scripts/staging/verify-literary-drain-workers.mjs", "utf8");
assert.ok(workflow.includes("needs: static"));
assert.ok(workflow.includes("github.ref == 'refs/heads/main'"));
assert.ok(workflow.includes("persist-credentials: false"));
assert.ok(workflow.includes("cancel-in-progress: false"));
assert.ok(workflow.includes("node scripts/staging/verify-literary-drain-predeploy.mjs"));
assert.ok(workflow.includes("node scripts/staging/verify-literary-drain-workers.mjs"));
assert.ok(!workflow.includes("github.event.pull_request.head.ref =="));
for (const [path, role] of [
  ["wrangler.content-literary-handoff.prod-draining.jsonc", "literary-handoff"],
  ["wrangler.content-literary-prepare.prod-draining.jsonc", "literary-prepare"],
]) {
  const cfg = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(cfg.vars.FORE_CONTENT_PROCESSOR_ROLE, role);
  assert.equal(cfg.vars.FORE_CONTENT_PROCESSOR_ENABLED, "1");
  assert.equal(cfg.vars.FORE_CONTENT_PREPARE_ENABLED, "1");
  assert.equal(cfg.workers_dev, false);
  assert.equal(cfg.preview_urls, false);
  assert.deepEqual(cfg.triggers?.crons, ["* * * * *"]);
  assert.ok(!cfg.routes && !cfg.route && !cfg.queues);
}
assert.ok(preflight.includes('assert.deepEqual(owner, []'));
assert.ok(preflight.includes('assert.deepEqual(frontier, [{ status: "disarmed"'));
assert.ok(preflight.includes("sourceObjects.find"));
assert.ok(preflight.includes("sourceMetadata[0]?.content_hash"));
assert.ok(verifier.includes('settings.routes?.length || 0'));
assert.ok(verifier.includes('FORE_LITERARY_DRAIN_RECONCILE_ENABLED'));
console.log("LITERARY_DRAIN_DEPLOY_POLICY_PASS protected owner-fenced no-public-ingress deployment");
