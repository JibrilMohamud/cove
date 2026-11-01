import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

const inventory = JSON.parse(
  readFileSync("docs/architecture/cloudflare-legacy-token-workflow-inventory-20261031.json", "utf8"),
);
assert.equal(inventory.schema, "cove.legacy-cloudflare-broad-token-workflow-inventory.v1");
assert.equal(inventory.releaseApproval, false);
assert.equal(inventory.productionExclusiveOwnerCertified, false);
assert.equal(inventory.credentialRevocationCertified, false);
assert.equal(inventory.maximumRemainingWorkflowConsumers, 37);
assert.equal(inventory.maximumRemainingSecretReferences, 42);
const files = readdirSync(".github/workflows")
  .filter((name) => /\.ya?ml$/.test(name))
  .map((name) => path.posix.join(".github/workflows", name));
const allow = new Map(inventory.legacyConsumers.map((x) => [x.path, x.maxReferences]));
assert.equal(allow.size, inventory.legacyConsumers.length);
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
console.log(
  `PASS: ${consumers}/37 unretired workflow consumers, ${references}/42 old token references; no new grants or release approval.`,
);
if (consumers)
  console.log(
    "BLOCKED: account-wide Cloudflare token must NOT be revoked or considered retired until each consumer migrates and independent permission review passes.",
  );
