/* eslint-disable prettier/prettier -- Literal security-gate fixtures and negative substitutions. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const workerDeployPaths = [
  ".github/workflows/cloudflare-native-ssr-staging.yml",
  ".github/workflows/cove-stage-protected-worker-rollback.yml",
  ".github/workflows/cloudflare-paired-release-freeze.yml",
  ".github/workflows/deploy-locked-fast-storefront-gateway.yml",
  ".github/workflows/strangler-stage-core-deploy.yml",
];
const scopedWorkerSecret =
  "CLOUDFLARE_API_TOKEN: ${{ secrets.COVE_CF_STAGE_WORKERS_DEPLOY_TOKEN }}";

export function assertScopedStageWorkerWorkflow(source, expectedSecret=scopedWorkerSecret) {
  assert.ok(source.includes(expectedSecret), "Stage Worker deploy must use its scoped secret");
  assert.doesNotMatch(source, /secrets\.CLOUDFLARE_API_TOKEN/,
    "Stage deploy must never fall back to broad Cloudflare secret");
  assert.match(source, /environment: cove-production-release-audit/,
    "Require protected environment approval");
  assert.ok(source.includes("github.ref == 'refs/heads/main'"),
    "Require the reviewed main branch");
  assert.ok(source.includes("inputs.reviewed_main_sha == github.sha"),
    "Require an exact main SHA");
  assert.ok(source.includes("github.event_name == 'workflow_dispatch'"),
    "Require an explicit manual dispatch gate");
  assert.doesNotMatch(source, /\bD1_DATABASE_ID:\s*\$\{\{\s*secrets\./,
    "Stage Workers deploy token must not double as a D1 migration token");
}

for (const path of workerDeployPaths) {
  test(path + " uses existing narrowly scoped stage Worker credential", () => {
    const source = readFileSync(path, "utf8");
    const rollback=path.endsWith("cove-stage-protected-worker-rollback.yml");
    const production=path.endsWith("deploy-locked-fast-storefront-gateway.yml");
    const expected=production?"CLOUDFLARE_API_TOKEN: ${{ secrets.COVE_CF_PROD_MAINTENANCE_TOKEN }}":rollback
      ?"CLOUDFLARE_API_TOKEN: ${{ secrets.COVE_CF_QA_WORKERS_DEPLOY_TOKEN }}"
      :scopedWorkerSecret;
    assertScopedStageWorkerWorkflow(source,expected);
    if(rollback){
      assert.ok(source.includes("CLOUDFLARE_ACCOUNT_ID: f51e8ccbc394e2d6016ff8c2c303d54b"));
      assert.ok(!source.includes("secrets.COVE_CF_STAGE_WORKERS_DEPLOY_TOKEN"));
      assert.ok(source.includes("secrets.COVE_CF_WORKERS_METADATA_READ_TOKEN"));
      assert.ok(source.includes("secrets.COVE_CF_WORKERS_CONTENT_READ_TOKEN"));
    }
    assert.throws(() => assertScopedStageWorkerWorkflow(
      source.replace(expected,
        "CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}"),expected),
      /scoped secret/);
    assert.throws(() => assertScopedStageWorkerWorkflow(
      source.replace("environment: cove-production-release-audit", "environment: bypass"),expected),
      /protected environment/);
  });
}

test("R2 bucket provision is protected and never acquires stage D1 write", () => {
  const workflow = readFileSync(
    ".github/workflows/strangler-stage-private-bucket-provision.yml", "utf8");
  const code = readFileSync("scripts/staging/provision-strangler-private-r2.mjs", "utf8");
  assert.ok(workflow.includes("secrets.COVE_CF_STAGE_R2_BUCKET_PROVISION_TOKEN"));
  assert.ok(workflow.includes("secrets.COVE_CF_STAGE_D1_READ_TOKEN"));
  assert.doesNotMatch(workflow, /secrets\.CLOUDFLARE_API_TOKEN/);
  assert.ok(workflow.includes("environment: cove-production-release-audit"));
  for (const gate of [
    "github.event_name == 'workflow_dispatch'",
    "github.ref == 'refs/heads/main'",
    "inputs.reviewed_main_sha == github.sha",
    "inputs.confirm_isolated_stage_only == true",
  ]) assert.ok(workflow.includes(gate), "Missing staging approval gate: " + gate);
  assert.ok(code.includes("if (d1Token === r2Token)"));
  assert.ok(code.includes('api("GET", "/d1/database/" + dbId, d1Token)'));
  assert.ok(code.includes('api("POST", "/r2/buckets", r2Token, { name: bucket })'));
  assert.doesNotMatch(code, /process\.env\.CLOUDFLARE_API_TOKEN/);
  assert.doesNotMatch(code, /4bd657ac-8789-403e-a28c-93aba8d0a989/,
    "Staging bucket code must not select production D1");
});

test("paid real-schema QA is manual, separate-principal and fail-closed", () => {
  const production = readFileSync(".github/workflows/deploy-persistence-backend.yml","utf8");
  const paid = readFileSync(".github/workflows/paid-legal-full-schema-private-qa.yml","utf8");
  assert.ok(!production.includes("secrets.CLOUDFLARE_API_TOKEN"));
  assert.ok(production.includes("secrets.COVE_CF_WORKERS_VERSION_UPLOAD_TOKEN"));
  assert.ok(production.includes("Deny direct production D1 schema migration"));
  assert.ok(!paid.includes("secrets.CLOUDFLARE_API_TOKEN"));
  assert.ok(!paid.includes("secrets.COVE_CF_PAID_QA_D1_WRITE_TOKEN"));
  assert.ok(!paid.includes("secrets.COVE_CF_PAID_QA_R2_WRITE_TOKEN"));
  assert.ok(!paid.includes("secrets.COVE_CF_STAGE_WORKERS_DEPLOY_TOKEN"));
  assert.ok(!paid.includes("d26430caa63ec55f6612e32f36aca5e9"));
  for(const value of ["secrets.COVE_CF_QA_WORKERS_DEPLOY_TOKEN",
    "secrets.COVE_CF_QA_D1_MUTATION_TOKEN",
    "secrets.COVE_CF_QA_R2_STORAGE_TOKEN",
    "inputs.reviewed_main_sha == github.sha",
    "inputs.confirm_isolated_qa == true",
    "github.event_name == 'workflow_dispatch'",
    "environment: cove-production-release-audit"])
    assert.ok(paid.includes(value),"Unreviewed QA credential or admission change: "+value);
});

test("older private legal-owner QA never exposes a deploy or D1 secret to PR code",()=>{
  const src=readFileSync(".github/workflows/legal-authority-private-qa.yml","utf8");
  assert.ok(!src.includes("secrets.CLOUDFLARE_API_TOKEN"));
  assert.ok(src.includes("needs: offline-private-owner"));
  assert.ok(src.includes("environment: cove-production-release-audit"));
  assert.ok(src.includes("github.event_name == 'workflow_dispatch'"));
  assert.ok(src.includes("inputs.reviewed_main_sha == github.sha"));
  assert.ok(src.includes("inputs.confirm_protected_cloudflare_action == true"));
  assert.ok(src.includes("secrets.COVE_CF_QA_WORKERS_DEPLOY_TOKEN"));
  assert.ok(src.includes("f51e8ccbc394e2d6016ff8c2c303d54b"));
  assert.ok(!src.includes("secrets.COVE_CF_STAGE_WORKERS_DEPLOY_TOKEN"));
  assert.ok(!src.includes("secrets.COVE_CF_WORKERS_METADATA_READ_TOKEN"));
  assert.ok(!src.includes("secrets.COVE_CF_PAID_QA_D1_WRITE_TOKEN"));
});

test("disabled production legal owner uses three distinct non-D1 principals",()=>{
  const workflow=readFileSync(".github/workflows/production-legal-owner-locked.yml","utf8");
  const checker=readFileSync("scripts/check-locked-production-legal-owner.mjs","utf8");
  assertScopedStageWorkerWorkflow(workflow,"CLOUDFLARE_API_TOKEN: ${{ secrets.COVE_CF_PROD_MAINTENANCE_TOKEN }}");
  for(const credential of [
    "secrets.COVE_CF_PROD_MAINTENANCE_TOKEN",
    "secrets.COVE_CF_WORKERS_METADATA_READ_TOKEN",
    "secrets.COVE_CF_ZONE_ROUTES_READ_TOKEN",
  ]) assert.ok(workflow.includes(credential),"Missing independent scoped credential: "+credential);
  assert.doesNotMatch(workflow,/secrets\.CLOUDFLARE_API_TOKEN\b/,
    "Disabled owner must not deploy using broad D1-write credential");
  assert.ok(workflow.includes('test "$CLOUDFLARE_API_TOKEN" != "$COVE_CF_WORKERS_METADATA_READ_TOKEN"'));
  assert.ok(workflow.includes('test "$CLOUDFLARE_API_TOKEN" != "$COVE_CF_ZONE_ROUTES_READ_TOKEN"'));
  assert.ok(workflow.includes('test "$COVE_CF_WORKERS_METADATA_READ_TOKEN" != "$COVE_CF_ZONE_ROUTES_READ_TOKEN"'));
  assert.ok(checker.includes("process.env.COVE_CF_WORKERS_METADATA_READ_TOKEN"));
  assert.ok(!checker.includes("process.env.CLOUDFLARE_API_TOKEN"),
    "Live owner settings check must not reuse privileged deploy principal");
  assert.ok(workflow.includes("node scripts/check-locked-production-legal-owner.mjs --live"));
  assert.ok(workflow.includes("node scripts/check-live-production-cutover.mjs --audit"));
  assert.ok(workflow.includes("inputs.confirm_protected_cloudflare_action == true"));
});
