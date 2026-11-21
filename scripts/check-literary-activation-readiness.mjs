import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { literaryActivationReadCredential } from "./staging/literary-activation-readonly-auth.mjs";

const src = readFileSync("scripts/staging/audit-literary-activation-readiness.mjs", "utf8");
const workflow = readFileSync(".github/workflows/literary-activation-readiness.yml", "utf8");
for (const required of [
  "readonly: true",
  "mutationPerformed: false",
  "budgetCarryoverVerified",
  "legacy_daily_inference_budget_not_carried_over",
  "infer_private_publisher_service_binding_missing",
  "publication_retry_migration_not_verified",
  "sharedMinuteCronPresent",
  "stagingPrivateBindingCertified",
  "scopedPublisherCredentials",
  "private_publisher_tokens_and_staging_e2e_not_certified",
  "canArm: false",
  "literary_processing_owner",
  "literary_budget_domain",
  "idx_literary_inference_publication_due",
])
  assert.ok(src.includes(required), "Readiness audit missing " + required);
assert.ok(src.includes("assert.match(sql.trim(), /^(SELECT|PRAGMA)"));
assert.ok(src.includes("assert.doesNotMatch(sql"));
assert.ok(!src.includes('blockers.push("legacy_minute_cron_still_attached")'));
assert.ok(src.includes('blockers.push("active_handoff_and_rollback_not_certified")'));
assert.ok(!/\b(?:api\("PUT"|api\("PATCH"|api\("DELETE")\b/.test(src));
assert.ok(workflow.includes("needs: static-readonly-contract"));
assert.ok(workflow.includes("github.ref == 'refs/heads/main'"));
assert.ok(workflow.includes("persist-credentials: false"));
assert.ok(workflow.includes("cancel-in-progress: false"));
assert.ok(!workflow.includes("github.event.pull_request.head.ref =="));
assert.ok(!src.includes("process.env.CLOUDFLARE_API_TOKEN"));
assert.ok(!workflow.includes("secrets.CLOUDFLARE_API_TOKEN"));
assert.ok(workflow.includes("secrets.COVE_CF_WORKERS_METADATA_READ_TOKEN"));
assert.ok(workflow.includes("secrets.COVE_CF_PRODUCTION_AUDIT_READ_TOKEN"));
assert.ok(workflow.includes("environment: cove-production-release-audit"));

const scopes = {
  COVE_CF_PRODUCTION_AUDIT_READ_TOKEN: "D".repeat(32),
  COVE_CF_WORKERS_METADATA_READ_TOKEN: "M".repeat(32),
  CLOUDFLARE_API_TOKEN: "UNSAFE_BROAD_DEPLOY_CREDENTIAL",
};
const d1 = "/d1/database/4bd657ac-8789-403e-a28c-93aba8d0a989/query";
const sql = { sql: "SELECT key,value FROM cove_runtime_config" };
const worker = "/workers/scripts/cove-persistence-backend/deployments";
assert.equal(literaryActivationReadCredential("POST", d1, sql, scopes), scopes.COVE_CF_PRODUCTION_AUDIT_READ_TOKEN);
assert.equal(literaryActivationReadCredential("GET", worker, undefined, scopes), scopes.COVE_CF_WORKERS_METADATA_READ_TOKEN);
assert.equal(literaryActivationReadCredential("GET", "/workers/workers/cove-literary-infer-isolated-disabled", undefined, scopes), scopes.COVE_CF_WORKERS_METADATA_READ_TOKEN);
assert.equal(literaryActivationReadCredential("POST", "/d1/database/400c3af3-5d40-41fd-83cc-98228e40ddac/query", { sql: "PRAGMA table_info(literary_inference_jobs)" }, scopes), scopes.COVE_CF_PRODUCTION_AUDIT_READ_TOKEN);
for (const [method, path, body] of [
  ["POST", d1, { sql: "UPDATE cove_runtime_config SET value='1'" }],
  ["POST", d1, { sql: "SELECT 1; UPDATE x SET y=1" }],
  ["POST", d1, { sql: "PRAGMA journal_mode=WAL" }],
  ["POST", d1, { sql: "SELECT 1", extra: true }],
  ["POST", "/d1/database/00000000-0000-0000-0000-000000000000/query", sql],
  ["GET", d1, undefined],
  ["PUT", worker, undefined],
  ["GET", "/workers/scripts/cove-persistence-backend/settings?x=1", undefined],
  ["GET", "/workers/scripts/unreviewed-worker/deployments", undefined],
  ["GET", "/workers/workers/unreviewed-worker", undefined],
  ["POST", "/workers/scripts/cove-persistence-backend/settings", sql],
]) {
  assert.throws(
    () => literaryActivationReadCredential(method, path, body, scopes),
    /literary_activation_unreviewed_read_endpoint_denied/,
    "Deny unreviewed literary audit endpoint " + method + " " + path,
  );
}
assert.throws(
  () => literaryActivationReadCredential("POST", d1, sql, {
    CLOUDFLARE_API_TOKEN: "W".repeat(32),
  }),
  /literary_activation_scoped_read_credential_unavailable/,
);
assert.throws(
  () => literaryActivationReadCredential("GET", worker, undefined, {
    CLOUDFLARE_API_TOKEN: "W".repeat(32),
  }),
  /literary_activation_scoped_read_credential_unavailable/,
);

console.log("LITERARY_ACTIVATION_AUDIT_POLICY_PASS no auto arm, no secrets on pull requests");
