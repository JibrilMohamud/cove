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
assert.equal(inventory.maximumRemainingWorkflowConsumers, 31);
assert.equal(inventory.maximumRemainingSecretReferences, 36);
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
  `PASS: ${consumers}/31 unretired workflow consumers, ${references}/36 old token references; no new grants or release approval.`,
);
if (consumers)
  console.log(
    "BLOCKED: account-wide Cloudflare token must NOT be revoked or considered retired until each consumer migrates and independent permission review passes.",
  );
