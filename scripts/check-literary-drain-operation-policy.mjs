import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(path, "utf8");
const workflow = read(".github/workflows/literary-guarded-owner-drain.yml");
const activation = read("scripts/staging/activate-literary-drain.mjs");
const rollback = read("scripts/staging/rollback-literary-drain.mjs");
const monitoring = read("scripts/staging/verify-literary-drain-progress.mjs");
const lib = read("scripts/staging/literary-drain-operator-lib.mjs");
for (const s of [
  "needs: static",
  "github.ref == 'refs/heads/main'",
  "persist-credentials: false",
  "cancel-in-progress: false",
  "protected-post-drain-observation",
  "verify-literary-postpublication-readonly.mjs",
  "secrets.COVE_BIOSYNC_PROD_D1_READ_TOKEN",
])
  assert.ok(workflow.includes(s), "Missing protected observation workflow invariant " + s);
for (const s of [
  "literary_processing_owner",
  "literary_budget_domain",
  "lease",
  "prepared",
  "armed",
  "isolatedSpendPermission: false",
  "privatePublisherStageCertified: true",
])
  assert.ok(activation.includes(s), "Missing canonical drain guard " + s);
assert.ok(
  !activation.includes("value='isolated',updated_at=excluded.updated_at") ||
    activation.includes("'literary_budget_domain'"),
);
assert.ok(!activation.includes("'literary_processing_owner','isolated'"));
assert.ok(monitoring.includes("literary_prepare_outbox WHERE status='delivered'"));
assert.ok(monitoring.includes("literary_prepare_jobs WHERE status='done'"));
assert.ok(monitoring.includes("status='failed'"));
assert.ok(rollback.includes("Cannot restore primary budget after isolated debit"));
assert.ok(rollback.includes("canonical_legacy_restored"));
assert.ok(rollback.includes("cron_removed:"));
assert.ok(lib.includes('assert.equal(process.env.GITHUB_REF, "refs/heads/main")'));
assert.ok(!workflow.includes("secrets.CLOUDFLARE_API_TOKEN"));
assert.ok(!workflow.includes("run: node scripts/staging/activate-literary-drain.mjs"));
assert.ok(!workflow.includes("run: node scripts/staging/rollback-literary-drain.mjs"));
assert.ok(!lib.includes("fetch("));
assert.ok(!lib.includes("process.env.CLOUDFLARE_API_TOKEN"));
const previousRef = process.env.GITHUB_REF;
process.env.GITHUB_REF = "refs/heads/main";
try {
  const retired = await import("./staging/literary-drain-operator-lib.mjs");
  await assert.rejects(
    retired.api("POST", "/d1/database/primary/query", { sql: "SELECT 1" }),
    /literary_legacy_drain_operator_retired/,
  );
  await assert.rejects(
    retired.api("PUT", "/workers/scripts/legacy/schedules", []),
    /literary_legacy_drain_operator_retired/,
  );
  await assert.rejects(retired.owner(), /literary_legacy_drain_operator_retired/);
} finally {
  if (previousRef === undefined) delete process.env.GITHUB_REF;
  else process.env.GITHUB_REF = previousRef;
}
const observer = read("scripts/staging/verify-literary-postpublication-readonly.mjs");
assert.ok(observer.includes(String.raw`assert.match(sql, /^SELECT\b/)`));
assert.ok(!/\b(?:INSERT INTO|UPDATE literary|DELETE FROM)\b/.test(observer));
console.log(
  "LITERARY_GUARDED_DRAIN_POLICY_PASS completed direct-write operator retired; read-only observation retained",
);
