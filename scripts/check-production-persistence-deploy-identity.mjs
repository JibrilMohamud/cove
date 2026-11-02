import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const text = readFileSync(".github/workflows/deploy-persistence-backend.yml", "utf8");
const worker = "cove-persistence-backend";
const primary = "4bd657ac-8789-403e-a28c-93aba8d0a989";
const owner = "cove-legal-authority-production";

for (const [variable, expected] of [
  ["WORKER_NAME", worker],
  ["D1_DATABASE_ID", primary],
  ["D1_DATABASE_NAME", "cove-production"],
  ["R2_BUCKET_NAME", "cove-production-media"],
]) {
  assert.ok(
    text.includes(`[[ "$${variable}" == "${expected}" ]]`),
    `Production deployment must reject alternate ${variable} identities`,
  );
}
assert.match(text, /^on:\n/m);
assert.match(text, /^  workflow_dispatch:\n/m);
assert.doesNotMatch(text, /^  push:\s*$/m);
assert.match(
  text,
  /if: \$\{\{ github\.event_name == 'workflow_dispatch' && github\.ref == 'refs\/heads\/main' \}\}/,
);
const migrationInput = text.slice(
  text.indexOf("      apply_migrations:"),
  text.indexOf("\npermissions:"),
);
assert.match(migrationInput, /default: false/);
assert.match(migrationInput, /type: boolean/);
assert.match(text, /inputs\.apply_migrations == true/);
assert.doesNotMatch(text, /github\.event_name == 'push' \|\| inputs\.apply_migrations/);
assert.doesNotMatch(text, /secrets\.CLOUDFLARE_API_TOKEN/);
assert.match(text, /CLOUDFLARE_COVE_RELEASE_DEPLOY_TOKEN/);
assert.match(text, /CLOUDFLARE_COVE_RELEASE_D1_MIGRATIONS_TOKEN/);
assert.match(text, /separately scoped CLOUDFLARE_COVE_RELEASE_DEPLOY_TOKEN is required/);
assert.match(text, /Worker deployment and production D1 migration credentials must be distinct/);
const migrations = text.slice(
  text.indexOf("- name: Apply pending D1 migrations"),
  text.indexOf("- name: Deploy persistence Worker"),
);
assert.match(
  migrations,
  /apiToken: \$\{\{ secrets\.CLOUDFLARE_COVE_RELEASE_D1_MIGRATIONS_TOKEN \}\}/,
);
const workerDeploy = text.slice(
  text.indexOf("- name: Deploy persistence Worker"),
  text.indexOf("- name: Verify production persistence binding after deployment"),
);
assert.match(workerDeploy, /apiToken: \$\{\{ secrets\.CLOUDFLARE_COVE_RELEASE_DEPLOY_TOKEN \}\}/);
assert.doesNotMatch(workerDeploy, /CLOUDFLARE_COVE_RELEASE_D1_MIGRATIONS_TOKEN/);
const preflightIndex = text.indexOf(
  "- name: Verify exact disabled production owner before binding",
);
const migrationIndex = text.indexOf("- name: Apply pending D1 migrations");
const deployIndex = text.indexOf("- name: Deploy persistence Worker");
assert.ok(preflightIndex >= 0 && preflightIndex < migrationIndex);
assert.ok(migrationIndex > 0 && migrationIndex < deployIndex);
assert.match(text, /- name: Validate deployment inputs/);
assert.ok(text.includes("https://www.covereads.com"), "Missing owned canonical HTTPS origin");
assert.doesNotMatch(text, /https:\/\/[a-z0-9-]+\.vercel\.app/i);
assert.doesNotMatch(text, /https:\/\/covereads\.com(?:["'])/);
assert.match(text, /trusted\.has\(u\.origin\)/);
assert.match(text, /public_url must be a reviewed Cove production origin/);
const validation = text.indexOf("- name: Validate deployment inputs");
const build = text.indexOf("- name: Build persistence Worker");
assert.ok(validation >= 0 && build > validation);
assert.ok(text.indexOf('[[ "$WORKER_NAME" == "', validation) < build);

const binding = 'script_name = "' + owner + '"';
const configStep = text.indexOf("- name: Write deployment config");
const ownerBinding = text.indexOf(binding, configStep);
const credentials = text.indexOf(
  "- name: Require independently scoped production release credentials",
  configStep,
);
assert.ok(ownerBinding > configStep && ownerBinding < credentials);
assert.doesNotMatch(
  text.slice(configStep, ownerBinding),
  /if \[ "\$WORKER_NAME" =|if \[ "\$D1_DATABASE_ID" =/,
  "The legal authority binding must never be bypassed using dispatch input",
);

const requiredChecks = [
  "Verify exact disabled production owner before binding",
  "Verify production persistence binding after deployment",
  "Prove live production backend credential and disabled owner handshake",
];
for (const name of requiredChecks) {
  const step = text.indexOf("- name: " + name);
  assert.ok(step > credentials, `Missing required owner check: ${name}`);
  const excerpt = text.slice(step, text.indexOf("\n      - ", step + 8));
  assert.match(excerpt, /if: \$\{\{ steps\.deploy_auth\.outputs\.enabled == 'true' \}\}/);
  assert.doesNotMatch(excerpt, /inputs\.(worker_name|d1_database_id)/);
}
assert.match(
  text,
  /concurrency:\n  group: cove-persistence-production\n  cancel-in-progress: false/,
);
console.log(
  "PASS: only explicit main-branch deploys can mutate production D1; owner preflight and target identity are mandatory.",
);
