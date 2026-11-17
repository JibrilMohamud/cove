import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const workflow = readFileSync(
  ".github/workflows/cove-exclusive-primary-d1-writer-audit.yml",
  "utf8",
);
const [offline, live] = workflow.split("  live-physical-audit:\n");

test("writer inventory is protected and shares the exclusive real-primary release lock", () => {
  assert.ok(live, "Missing manually approved physical-writer job");
  assert.match(live, /github\.repository == 'JibrilMohamud\/cove'/);
  assert.match(live, /github\.event_name == 'workflow_dispatch'/);
  assert.match(live, /github\.ref == 'refs\/heads\/main'/);
  assert.match(live, /inputs\.confirm_readonly_physical_audit == true/);
  assert.match(live, /inputs\.reviewed_main_sha == github\.sha/);
  assert.match(live, /git rev-parse HEAD/);
  assert.match(live, /inputs\.reviewed_main_sha/);
  assert.match(live, /needs: \[offline-source-contract\]/);
  assert.match(
    live,
    /concurrency:\n      group: cove-exclusive-real-primary-cold-acceptance\n      queue: max\n      cancel-in-progress: false/,
  );
  assert.match(live, /environment: cove-production-release-audit/);
  assert.match(live, /CF_WORKERS_METADATA_READ_TOKEN: .*COVE_CF_WORKERS_METADATA_READ_TOKEN/);
  assert.match(
    live,
    /CF_ACCOUNT_TOKENS_AUDIT_READ_TOKEN: .*COVE_CF_ACCOUNT_TOKENS_AUDIT_READ_TOKEN/,
  );
  assert.match(live, /CF_USER_AUDIT_TOKEN: .*COVE_CF_USER_TOKENS_AUDIT_READ_TOKEN/);
  assert.doesNotMatch(live, /CLOUDFLARE_API_TOKEN|secrets\.CLOUDFLARE_API_TOKEN/);
});

test("offline CI remains credential-free, and a draft PR never runs protected live audit", () => {
  assert.ok(offline);
  assert.match(offline, /pull_request:/);
  assert.match(offline, /workflow_dispatch:/);
  assert.match(
    offline,
    /node --test scripts\/release\/physical-d1-writer-read-transport\.test\.mjs scripts\/release\/exclusive-primary-d1-workflow-lock\.test\.mjs/,
  );
  assert.doesNotMatch(offline, /secrets\.|environment: cove-production-release-audit/);
  assert.doesNotMatch(offline, /\n  push:/);
  assert.match(offline, /confirm_readonly_physical_audit:/);
  assert.match(offline, /reviewed_main_sha:/);
  assert.match(offline, /default: false/);
  assert.match(live, /github\.event_name == 'workflow_dispatch'/);
});

test("live audit checks both absent protected secrets without printing values", () => {
  assert.match(live, /name: Require three separately scoped audit credentials/);
  assert.match(live, /for name in CF_WORKERS_METADATA_READ_TOKEN CF_ACCOUNT_TOKENS_AUDIT_READ_TOKEN CF_USER_AUDIT_TOKEN/);
  assert.match(live, /test "\\$missing" -eq 0/);
  const guard = live.indexOf("name: Require three separately scoped audit credentials");
  const audit = live.indexOf("name: Certify physical Cloudflare writer exclusivity");
  assert.ok(guard > 0 && audit > guard);
  assert.doesNotMatch(live, /echo.*\\$\\{!name\\}/);
  assert.doesNotMatch(live, /::add-mask::|set -x/);
});
