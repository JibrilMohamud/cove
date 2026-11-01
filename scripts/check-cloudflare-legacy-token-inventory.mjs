import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

const inventory = JSON.parse(
  readFileSync(
    "docs/architecture/cloudflare-legacy-token-workflow-inventory-20261031.json",
    "utf8",
  ),
);
assert.equal(inventory.schema, "cove.legacy-cloudflare-broad-token-workflow-inventory.v1");
assert.equal(inventory.releaseApproval, false);
assert.equal(inventory.productionExclusiveOwnerCertified, false);
assert.equal(inventory.credentialRevocationCertified, false);
assert.equal(inventory.maximumRemainingWorkflowConsumers, 0);
assert.equal(inventory.maximumRemainingSecretReferences, 0);
const files = readdirSync(".github/workflows")
  .filter((name) => /\.ya?ml$/.test(name))
  .map((name) => path.posix.join(".github/workflows", name));
const allow = new Map(inventory.legacyConsumers.map((x) => [x.path, x.maxReferences]));
assert.equal(allow.size, inventory.legacyConsumers.length);
const expectedScopedConsumers = new Map([
  [
    ".github/workflows/backend-readonly-candidate.yml",
    "CLOUDFLARE_COVE_BACKEND_CANDIDATE_DEPLOY_TOKEN",
  ],
  [
    ".github/workflows/canonical-readonly-service.yml",
    "CLOUDFLARE_COVE_CANONICAL_READER_DEPLOY_TOKEN",
  ],
  [
    ".github/workflows/deployed-commerce-browser-acceptance.yml",
    "CLOUDFLARE_COVE_ARCHIVED_COMMERCE_QA_TOKEN",
  ],
  [
    ".github/workflows/strangler-stage-private-bucket-provision.yml",
    "CLOUDFLARE_COVE_STAGE_R2_PROVISION_TOKEN",
  ],
  [
    ".github/workflows/literary-prod-handoff-dormant-deploy.yml",
    "CLOUDFLARE_COVE_DORMANT_LITERARY_HANDOFF_TOKEN",
  ],
  [
    ".github/workflows/literary-prod-publisher-dormant-deploy.yml",
    "CLOUDFLARE_COVE_DORMANT_LITERARY_PUBLISHER_TOKEN",
  ],
  [
    ".github/workflows/biosync-canary.yml",
    "CLOUDFLARE_COVE_BIOSYNC_CANARY_TOKEN",
  ],
  [
    ".github/workflows/cloudflare-native-ssr-staging.yml",
    "CLOUDFLARE_COVE_CLOUDFLARE_NATIVE_SSR_STAGING_TOKEN",
  ],
  [
    ".github/workflows/cloudflare-paired-release-freeze.yml",
    "CLOUDFLARE_COVE_CLOUDFLARE_PAIRED_RELEASE_FREEZE_TOKEN",
  ],
  [
    ".github/workflows/continuous-publication-qa.yml",
    "CLOUDFLARE_COVE_CONTINUOUS_PUBLICATION_QA_TOKEN",
  ],
  [
    ".github/workflows/cove-commerce-private-qa-deploy.yml",
    "CLOUDFLARE_COVE_COVE_COMMERCE_PRIVATE_QA_DEPLOY_TOKEN",
  ],
  [
    ".github/workflows/cove-sounds-private-rollout.yml",
    "CLOUDFLARE_COVE_COVE_SOUNDS_PRIVATE_ROLLOUT_TOKEN",
  ],
  [
    ".github/workflows/cove-sounds-verified-conversion-report.yml",
    "CLOUDFLARE_COVE_COVE_SOUNDS_VERIFIED_CONVERSION_REPORT_TOKEN",
  ],
  [
    ".github/workflows/covereads-secure-ssr-gateway.yml",
    "CLOUDFLARE_COVE_COVEREADS_SECURE_SSR_GATEWAY_TOKEN",
  ],
  [
    ".github/workflows/fast-storefront-real-catalog-acceptance.yml",
    "CLOUDFLARE_COVE_FAST_STOREFRONT_REAL_CATALOG_ACCEPTANCE_TOKEN",
  ],
  [
    ".github/workflows/hosted-music-supply-disabled-qa.yml",
    "CLOUDFLARE_COVE_HOSTED_MUSIC_SUPPLY_DISABLED_QA_TOKEN",
  ],
  [
    ".github/workflows/isolated-commons-audio-technical-qa.yml",
    "CLOUDFLARE_COVE_ISOLATED_COMMONS_AUDIO_TECHNICAL_QA_TOKEN",
  ],
  [
    ".github/workflows/isolated-commons-review-cases.yml",
    "CLOUDFLARE_COVE_ISOLATED_COMMONS_REVIEW_CASES_TOKEN",
  ],
  [
    ".github/workflows/isolated-data-plane.yml",
    "CLOUDFLARE_COVE_ISOLATED_DATA_PLANE_TOKEN",
  ],
  [
    ".github/workflows/isolated-open-license-discovery.yml",
    "CLOUDFLARE_COVE_ISOLATED_OPEN_LICENSE_DISCOVERY_TOKEN",
  ],
  [
    ".github/workflows/legal-authority-private-qa.yml",
    "CLOUDFLARE_COVE_LEGAL_AUTHORITY_PRIVATE_QA_TOKEN",
  ],
  [
    ".github/workflows/literary-activation-readiness.yml",
    "CLOUDFLARE_COVE_LITERARY_ACTIVATION_READINESS_TOKEN",
  ],
  [
    ".github/workflows/literary-drain-worker-deploy.yml",
    "CLOUDFLARE_COVE_LITERARY_DRAIN_WORKER_DEPLOY_TOKEN",
  ],
  [
    ".github/workflows/literary-guarded-owner-drain.yml",
    "CLOUDFLARE_COVE_LITERARY_GUARDED_OWNER_DRAIN_TOKEN",
  ],
  [
    ".github/workflows/literary-isolated-replay-handoff-deploy.yml",
    "CLOUDFLARE_COVE_LITERARY_ISOLATED_REPLAY_HANDOFF_DEPLOY_TOKEN",
  ],
  [
    ".github/workflows/literary-isolated-utc-budget.yml",
    "CLOUDFLARE_COVE_LITERARY_ISOLATED_UTC_BUDGET_TOKEN",
  ],
  [
    ".github/workflows/literary-live-cutover-preflight.yml",
    "CLOUDFLARE_COVE_LITERARY_LIVE_CUTOVER_PREFLIGHT_TOKEN",
  ],
  [
    ".github/workflows/literary-owner-capability-migration.yml",
    "CLOUDFLARE_COVE_LITERARY_OWNER_CAPABILITY_MIGRATION_TOKEN",
  ],
  [
    ".github/workflows/literary-private-binding-stage-canary.yml",
    "CLOUDFLARE_COVE_LITERARY_PRIVATE_BINDING_STAGE_CANARY_TOKEN",
  ],
  [
    ".github/workflows/literary-progressive-canonical-publication.yml",
    "CLOUDFLARE_COVE_LITERARY_PROGRESSIVE_CANONICAL_PUBLICATION_TOKEN",
  ],
  [
    ".github/workflows/literary-remote-staging-e2e.yml",
    "CLOUDFLARE_COVE_LITERARY_REMOTE_STAGING_E2E_TOKEN",
  ],
  [
    ".github/workflows/paid-legal-full-schema-private-qa.yml",
    "CLOUDFLARE_COVE_PAID_LEGAL_FULL_SCHEMA_PRIVATE_QA_TOKEN",
  ],
  [
    ".github/workflows/publication-source-isolation-qa.yml",
    "CLOUDFLARE_COVE_PUBLICATION_SOURCE_ISOLATION_QA_TOKEN",
  ],
  [
    ".github/workflows/storefront-strangler-safe-integration.yml",
    "CLOUDFLARE_COVE_STOREFRONT_STRANGLER_SAFE_INTEGRATION_TOKEN",
  ],
  [
    ".github/workflows/strangler-data-plane-preflight.yml",
    "CLOUDFLARE_COVE_STRANGLER_DATA_PLANE_PREFLIGHT_TOKEN",
  ],
  [
    ".github/workflows/strangler-hosted-capacity-evaluation.yml",
    "CLOUDFLARE_COVE_STRANGLER_HOSTED_CAPACITY_EVALUATION_TOKEN",
  ],
  [
    ".github/workflows/strangler-stage-core-deploy.yml",
    "CLOUDFLARE_COVE_STRANGLER_STAGE_CORE_DEPLOY_TOKEN",
  ],
]);
assert.equal(inventory.scopedConsumers.length, expectedScopedConsumers.size);
for (const entry of inventory.scopedConsumers) {
  assert.equal(expectedScopedConsumers.get(entry.path), entry.secret);
  assert.equal(entry.provisioned, false);
  assert.equal(entry.providerPrivilegesCertified, false);
  const source = readFileSync(entry.path, "utf8");
  assert.ok(
    source.includes("CLOUDFLARE_API_TOKEN: ${{ secrets." + entry.secret + " }}"),
    "Dedicated secret reference required: " + entry.path,
  );
  assert.ok(
    source.includes("- name: Require dedicated scoped Cloudflare credential"),
    "Missing fail-closed credential check: " + entry.path,
  );
  assert.equal(
    source.includes("secrets.CLOUDFLARE_API_TOKEN"),
    false,
    "Retired workflow regained broad token: " + entry.path,
  );
}

const stageBucket = readFileSync(
  ".github/workflows/strangler-stage-private-bucket-provision.yml",
  "utf8",
);
assert.match(stageBucket, /github\.event_name == 'workflow_dispatch'/);
assert.match(stageBucket, /github\.ref == 'refs\/heads\/main'/);
assert.match(stageBucket, /persist-credentials: false/);

let consumers = 0;
let references = 0;
for (const file of files) {
  const source = readFileSync(file, "utf8");
  const count = source.split("secrets.CLOUDFLARE_API_TOKEN").length - 1;
  if (!count) continue;
  assert.ok(allow.has(file), "New uncontrolled broad-token workflow: " + file);
  assert.ok(
    count <= allow.get(file),
    "Existing workflow regained additional broad-token capabilities: " + file,
  );
  consumers++;
  references += count;
}
assert.ok(consumers <= inventory.maximumRemainingWorkflowConsumers);
assert.ok(references <= inventory.maximumRemainingSecretReferences);
for (const file of [
  ".github/workflows/deploy-persistence-backend.yml",
  ".github/workflows/deploy-locked-fast-storefront-gateway.yml",
  ".github/workflows/production-legal-owner-locked.yml",
  ".github/workflows/production-external-preflight.yml",
  ".github/workflows/deployed-canonical-d1-principal-audit.yml",
  ".github/workflows/production-cutover-topology-audit.yml",
]) {
  assert.equal(
    readFileSync(file, "utf8").includes("secrets.CLOUDFLARE_API_TOKEN"),
    false,
    "Production release workflow must never re-enable the legacy token: " + file,
  );
}
for (const file of [
  ".github/workflows/production-external-preflight.yml",
  ".github/workflows/deployed-canonical-d1-principal-audit.yml",
  ".github/workflows/production-cutover-topology-audit.yml",
]) {
  assert.ok(
    readFileSync(file, "utf8").includes("secrets.CLOUDFLARE_COVE_READONLY_AUDIT_TOKEN"),
    "Production audit must use independent read-only credentials: " + file,
  );
}
console.log(
  `PASS: ${consumers}/0 unretired workflow consumers, ${references}/0 old token references; no new grants or release approval.`,
);
if (consumers)
  console.log(
    "BLOCKED: account-wide Cloudflare token must NOT be revoked or considered retired until each consumer migrates and independent permission review passes.",
  );

if (inventory.scopedConsumers.some((entry) => !entry.provisioned || !entry.providerPrivilegesCertified)) {
  console.log(
    "BLOCKED: zero broad-token source references, but scoped credentials are not provisioned or provider-certified. Live release and old-token revocation remain forbidden.",
  );
}
