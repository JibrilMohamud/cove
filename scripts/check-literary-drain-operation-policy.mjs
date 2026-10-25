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
  "if: failure() || cancelled()",
  "rollback-literary-drain.mjs",
]) assert.ok(workflow.includes(s), "Missing protected rollback workflow invariant " + s);
for (const s of [
  "literary_processing_owner",
  "literary_budget_domain",
  "lease",
  "prepared",
  "armed",
  "isolatedSpendPermission: false",
  "privatePublisherStageCertified: true",
]) assert.ok(activation.includes(s), "Missing canonical drain guard " + s);
assert.ok(!activation.includes("value='isolated',updated_at=excluded.updated_at") ||
  activation.includes("'literary_budget_domain'"));
assert.ok(!activation.includes("'literary_processing_owner','isolated'"));
assert.ok(monitoring.includes("literary_prepare_outbox WHERE status='delivered'"));
assert.ok(monitoring.includes("literary_prepare_jobs WHERE status='done'"));
assert.ok(monitoring.includes("status='failed'"));
assert.ok(rollback.includes("Cannot restore primary budget after isolated debit"));
assert.ok(rollback.includes("canonical_legacy_restored"));
assert.ok(rollback.includes("cron_removed:"));
assert.ok(lib.includes('assert.equal(process.env.GITHUB_REF, "refs/heads/main")'));
console.log("LITERARY_GUARDED_DRAIN_POLICY_PASS fail-closed owner, budget fence, evidence, rollback");
