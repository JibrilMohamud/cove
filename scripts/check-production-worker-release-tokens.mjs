import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const workflows = [
  {
    file: ".github/workflows/deploy-persistence-backend.yml",
    token: "CLOUDFLARE_COVE_RELEASE_DEPLOY_TOKEN",
    required: "Require independently scoped production release credentials",
  },
  {
    file: ".github/workflows/deploy-locked-fast-storefront-gateway.yml",
    token: "CLOUDFLARE_COVE_RELEASE_GATEWAY_TOKEN",
    required: "Require independently scoped gateway release token",
  },
  {
    file: ".github/workflows/production-legal-owner-locked.yml",
    token: "CLOUDFLARE_COVE_RELEASE_LEGAL_OWNER_TOKEN",
    required: "Require independently scoped locked legal-owner deployment token",
  },
];
const tokens = new Set(workflows.map((x) => x.token));
assert.equal(
  tokens.size,
  workflows.length,
  "Each production Worker needs distinct deploy credentials",
);
for (const { file, token, required } of workflows) {
  const source = readFileSync(file, "utf8");
  assert.match(source, /^  workflow_dispatch:\s*$/m);
  assert.doesNotMatch(source, /^  push:\s*$/m);
  assert.doesNotMatch(
    source,
    /secrets\.CLOUDFLARE_API_TOKEN/,
    file + " must never use the account-wide deployment credential",
  );
  assert.ok(source.includes("secrets." + token), file + " is missing its scoped secret");
  assert.ok(source.includes("- name: " + required), file + " must reject absent credentials");
  assert.ok(
    source.includes("github.ref == 'refs/heads/main'"),
    file + " must not deploy a test branch to a production Worker",
  );
  assert.ok(
    source.includes("github.event_name == 'workflow_dispatch'"),
    file + " must not deploy on repository pushes",
  );
}
const owner = readFileSync(".github/workflows/production-legal-owner-locked.yml", "utf8");
assert.match(owner, /check-locked-production-legal-owner\.mjs/);
assert.match(owner, /--dry-run/);
assert.match(owner, /--live/);
const gateway = readFileSync(".github/workflows/deploy-locked-fast-storefront-gateway.yml", "utf8");
assert.match(gateway, /COVE_STRANGLER_RELEASE_CERTIFIED.*"0"/);
assert.match(gateway, /No direct production D1 capability/);
const persistence = readFileSync(".github/workflows/deploy-persistence-backend.yml", "utf8");
assert.match(persistence, /CLOUDFLARE_COVE_RELEASE_D1_MIGRATIONS_TOKEN/);
assert.match(persistence, /default: false/);
console.log(
  "PASS: all three production Worker workflows require manual main-only releases and distinct scoped credentials.",
);
