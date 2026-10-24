import assert from "node:assert/strict";
import fs from "node:fs";

const script = fs.readFileSync("scripts/staging/audit-literary-cutover-preflight.mjs", "utf8");
const workflow = fs.readFileSync(".github/workflows/literary-live-cutover-preflight.yml", "utf8");
for (const term of [
  "snapshotRightsEligible",
  "literary_processing_owner",
  "literary_legacy_reconcile_frontier",
  "idx_literary_legacy_reconcile",
  "literary_budget_domain_identity",
  "legacy_minute_cron_attached_verify_writer_termination",
  "deployedLegacyCodeSha256",
  "FORE_LITERARY_DRAIN_RECONCILE_ENABLED",
  "canArmWithoutFurtherOperatorChecks: false",
  "liveWritePerformed: false",
  "rightsApprovedByAudit: false",
])
  assert.ok(script.includes(term), "Missing audit condition: " + term);
assert.ok(
  !/\b(?:INSERT INTO|UPDATE literary_|DELETE FROM|DROP TABLE|CREATE TABLE)\b/i.test(script),
);
assert.ok(workflow.includes("github.ref == 'refs/heads/main'"));
assert.ok(workflow.includes("persist-credentials: false"));
assert.ok(workflow.includes("cancel-in-progress: false"));
assert.ok(workflow.includes("needs: no-credentials-static-validation"));
assert.ok(!workflow.includes("github.event.pull_request.head.ref =="));
console.log("LITERARY_READONLY_CUTOVER_AUDIT_POLICY_PASS");
