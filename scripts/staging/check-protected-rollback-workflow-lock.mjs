import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const PATH = ".github/workflows/cove-stage-protected-worker-rollback.yml";
export function assertProtectedRollbackWorkflow(yaml) {
  assert.equal(typeof yaml, "string");
  const events = yaml.match(/^on:\n([\s\S]*?)(?=^permissions:)/m)?.[1];
  assert.ok(events, "Missing explicit workflow event permissions boundary");
  assert.match(events, /^  workflow_dispatch:\s*$/m);
  assert.doesNotMatch(
    events,
    /^  (?:push|pull_request|schedule|repository_dispatch|workflow_run):/m,
  );
  assert.match(events, /^      reviewed_main_sha:\s*$/m);
  assert.match(events, /^        required: true\s*$/m);
  assert.match(events, /^      confirm_isolated_worker_rehearsal:\s*$/m);
  assert.match(events, /^        default: false\s*$/m);

  const job = yaml.match(/^  isolate-deploy-two-versions-and-restore:\n([\s\S]*)$/m)?.[1];
  assert.ok(job, "Missing reviewable isolation job");
  const gate = job.match(/^    if: >-\n([\s\S]*?)(?=^    runs-on:)/m)?.[1] ?? "";
  for (const condition of [
    "github.repository == 'JibrilMohamud/cove'",
    "github.event_name == 'workflow_dispatch'",
    "github.ref == 'refs/heads/main'",
    "inputs.confirm_isolated_worker_rehearsal == true",
    "inputs.reviewed_main_sha == github.sha",
  ]) {
    assert.ok(gate.includes(condition), "Missing protected branch gate: " + condition);
  }
  assert.match(job, /^    environment: cove-production-release-audit\s*$/m);
  assert.match(job, /^    timeout-minutes: 15\s*$/m);
  assert.match(job, /CLOUDFLARE_ACCOUNT_ID: f51e8ccbc394e2d6016ff8c2c303d54b/);
  assert.ok(job.includes("secrets.COVE_CF_QA_WORKERS_DEPLOY_TOKEN"));
  assert.ok(!job.includes("secrets.COVE_CF_STAGE_WORKERS_DEPLOY_TOKEN"));
  assert.ok(job.includes("secrets.COVE_CF_WORKERS_METADATA_READ_TOKEN"));
  assert.ok(
    job.indexOf("environment: cove-production-release-audit") <
      job.indexOf("CLOUDFLARE_API_TOKEN:"),
    "Cloudflare credentials must only enter a protected environment job",
  );
  assert.match(job, /test "\$\(git rev-parse HEAD\)" = "\$\{\{ inputs.reviewed_main_sha \}\}"/);
  assert.match(job, /test "\$\{\{ github.ref \}\}" = "refs\/heads\/main"/);
  assert.match(job, /test "\$\{\{ inputs.confirm_isolated_worker_rehearsal \}\}" = "true"/);
  assert.match(yaml, /^permissions:\n  contents: read\s*$/m);
  assert.match(
    yaml,
    /- name: Delete only run-specific isolated Worker and independently confirm absence/,
  );
  assert.match(yaml, /if: always\(\)/);
  return true;
}

const source = readFileSync(PATH, "utf8");
assert.equal(assertProtectedRollbackWorkflow(source), true);
for (const mutation of [
  (s) => s.replace("  workflow_dispatch:", "  push:"),
  (s) => s.replace("f51e8ccbc394e2d6016ff8c2c303d54b", "d26430caa63ec55f6612e32f36aca5e9"),
  (s) =>
    s.replace(
      "secrets.COVE_CF_QA_WORKERS_DEPLOY_TOKEN",
      "secrets.COVE_CF_STAGE_WORKERS_DEPLOY_TOKEN",
    ),
  (s) => s.replace("    environment: cove-production-release-audit\n", ""),
  (s) => s.replace("github.ref == 'refs/heads/main' &&", "true &&"),
  (s) => s.replace("inputs.reviewed_main_sha == github.sha", "true"),
  (s) => s.replace("inputs.confirm_isolated_worker_rehearsal == true", "true"),
  (s) => s.replace('test "$(git rev-parse HEAD)" = "${{ inputs.reviewed_main_sha }}"', "true"),
]) {
  const changed = mutation(source);
  assert.notEqual(changed, source, "Regression test mutation must alter source");
  assert.throws(() => assertProtectedRollbackWorkflow(changed));
}
console.log(
  "PASS: protected rollback trigger requires main, reviewed SHA, approval and guarded isolated cleanup",
);
