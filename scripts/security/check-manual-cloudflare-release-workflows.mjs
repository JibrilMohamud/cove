import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const jobs = [
  ["production-legal-owner-locked", "deploy-locked-owner"],
  ["literary-prod-handoff-dormant-deploy", "deploy-without-trigger"],
  ["literary-prod-publisher-dormant-deploy", "deploy-no-routes-no-secrets"],
  ["deploy-locked-fast-storefront-gateway", "deploy-off-by-default"],
  ["cloudflare-paired-release-freeze", "immutable-paired-benchmark"],
  ["literary-live-cutover-preflight", "protected-live-readonly-audit"],
  ["cove-commerce-private-qa-deploy", "private-commerce"],
  ["cove-commerce-private-qa-deploy", "authenticated-commerce"],
];

export function verifyProtectedWorkflow(yaml, jobName) {
  const on = yaml.match(/^on:\n([\s\S]*?)(?=^permissions:)/m)?.[1];
  assert.ok(on, "Missing workflow trigger block");
  assert.match(on, /^  workflow_dispatch:\s*$/m);
  assert.match(on, /^      reviewed_main_sha:\s*$/m);
  assert.match(on, /^      confirm_protected_cloudflare_action:\s*$/m);
  assert.match(on, /^        required: true\s*$/m);
  assert.match(on, /^        default: false\s*$/m);
  assert.doesNotMatch(on, /^  (?:push|schedule|workflow_run|repository_dispatch):/m,
    "Production credentials must never be exposed by non-manual triggers");
  const header = yaml.indexOf("  " + jobName + ":\n");
  assert.ok(header >= 0, "Protected job missing");
  const following = yaml.slice(header);
  const nextJob = following.search(/\n  [a-z][a-z-]+:\n/);
  const job = nextJob < 0 ? following : following.slice(0, nextJob);
  const gate = job.match(/^    if: >-\n([\s\S]*?)(?=^    runs-on:)/m)?.[1];
  assert.ok(gate, "Missing closed-job admission gate");
  for (const condition of [
    "github.repository == 'JibrilMohamud/cove'",
    "github.event_name == 'workflow_dispatch'",
    "github.ref == 'refs/heads/main'",
    "inputs.confirm_protected_cloudflare_action == true",
    "inputs.reviewed_main_sha == github.sha",
  ]) assert.ok(gate.includes(condition), "Missing admission condition: " + condition);
  assert.match(job, /^    environment: cove-production-release-audit\s*$/m);
  assert.ok(job.indexOf("environment: cove-production-release-audit") <
    job.indexOf("CLOUDFLARE_API_TOKEN:"), "Environment approval must precede deployment-secret availability");
  assert.match(yaml, /^permissions:\n  contents: read\s*$/m);
  return true;
}

function mutateOnlyJob(yaml, jobName, from, to) {
  const start = yaml.indexOf("  " + jobName + ":\n");
  assert.ok(start >= 0);
  const rest = yaml.slice(start);
  const next = rest.search(/\n  [a-z][a-z-]+:\n/);
  const end = next < 0 ? yaml.length : start + next;
  const job = yaml.slice(start, end);
  assert.ok(job.includes(from), "Job mutation target missing: " + from);
  return yaml.slice(0, start) + job.replace(from, to) + yaml.slice(end);
}

for (const [name, job] of jobs) {
  const source = readFileSync(".github/workflows/" + name + ".yml", "utf8");
  assert.equal(verifyProtectedWorkflow(source, job), true, name);
  const unexpectedEvent = source.replace("  workflow_dispatch:", "  push:");
  assert.notEqual(unexpectedEvent, source);
  assert.throws(() => verifyProtectedWorkflow(unexpectedEvent, job));
  for (const [from, to] of [
    ["    environment: cove-production-release-audit\n", ""],
    ["github.event_name == 'workflow_dispatch'", "github.event_name == 'push'"],
    ["github.ref == 'refs/heads/main'", "github.ref == 'refs/heads/other'"],
    ["inputs.reviewed_main_sha == github.sha", "true"],
    ["inputs.confirm_protected_cloudflare_action == true", "true"],
  ]) {
    const mutated = mutateOnlyJob(source, job, from, to);
    assert.notEqual(mutated, source);
    assert.throws(() => verifyProtectedWorkflow(mutated, job));
  }
}
console.log("PASS: eight Cloudflare production-capable jobs are manual-only, main-pinned and protected");
