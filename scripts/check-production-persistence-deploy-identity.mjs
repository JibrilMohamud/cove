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
assert.match(text, /- name: Validate deployment inputs/);
const validation = text.indexOf("- name: Validate deployment inputs");
const build = text.indexOf("- name: Build persistence Worker");
assert.ok(validation >= 0 && build > validation);
assert.ok(text.indexOf('[[ "$WORKER_NAME" == "', validation) < build);

const binding = 'script_name = "' + owner + '"';
const configStep = text.indexOf("- name: Write deployment config");
const ownerBinding = text.indexOf(binding, configStep);
const credentials = text.indexOf("- name: Check deployment credentials", configStep);
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
assert.match(text, /concurrency:\n  group: cove-persistence-production\n  cancel-in-progress: false/);
console.log(
  "PASS: production backend deploy is fixed to one Worker/D1/bucket and owner verification cannot be skipped by input.",
);
