import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = readFileSync("scripts/staging/audit-literary-activation-readiness.mjs", "utf8");
const workflow = readFileSync(".github/workflows/literary-activation-readiness.yml", "utf8");
for (const required of [
  "readonly: true",
  "mutationPerformed: false",
  "budgetCarryoverVerified",
  "legacy_daily_inference_budget_not_carried_over",
  "infer_private_publisher_service_binding_missing",
  "publication_retry_migration_not_verified",
  "legacy_minute_cron_still_attached",
  "private_publisher_tokens_and_staging_e2e_not_certified",
  "canArm: false",
  "literary_processing_owner",
  "literary_budget_domain",
  "idx_literary_inference_publication_due",
]) assert.ok(src.includes(required), "Readiness audit missing " + required);
assert.ok(src.includes('assert.match(sql.trim(), /^(SELECT|PRAGMA|EXPLAIN|WITH)'));
assert.ok(src.includes("assert.doesNotMatch(sql"));
assert.ok(!/\b(?:api\("PUT"|api\("PATCH"|api\("DELETE")\b/.test(src));
assert.ok(workflow.includes("needs: static-readonly-contract"));
assert.ok(workflow.includes("github.ref == 'refs/heads/main'"));
assert.ok(workflow.includes("persist-credentials: false"));
assert.ok(workflow.includes("cancel-in-progress: false"));
assert.ok(!workflow.includes("github.event.pull_request.head.ref =="));
console.log("LITERARY_ACTIVATION_AUDIT_POLICY_PASS no auto arm, no secrets on pull requests");
