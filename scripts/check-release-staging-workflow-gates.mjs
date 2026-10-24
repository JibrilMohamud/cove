import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const requirements = [
  {
    file: ".github/workflows/cove-commerce-private-qa-deploy.yml",
    names: ["private-commerce:", "authenticated-commerce:"],
    protections: ["wrangler.commerce-qa.stage.toml", "COVE_QA_BUYER_EMAIL",
      "COVE_QA_OUTSIDER_EMAIL", "check-commerce-private-qa-stage.mjs"],
  },
  {
    file: ".github/workflows/strangler-hosted-capacity-evaluation.yml",
    names: ["protected-staging-only:"],
    protections: ["check-strangler-data-plane-preflight.mjs",
      "cove-strangler-ephemeral-capacity-stage",
      "assert-strangler-capacity-evidence.mjs"],
  },
];
for (const { file, names, protections } of requirements) {
  const data = readFileSync(file, "utf8");
  assert.match(data, /push:\n    branches: \[main\]/, file + " needs reviewed-main trigger");
  assert.match(data, /workflow_dispatch:/, file + " needs explicit rerun option");
  assert.match(data, /github.ref == 'refs\/heads\/main'/, file + " must be main-only");
  assert.ok(
    !data.includes("github.event.pull_request.head.ref =="),
    file + " must not grant external PR code access to protected credentials",
  );
  assert.match(data, /cancel-in-progress: false/, file + " must not cancel cleanup");
  for (const name of names) assert.ok(data.includes(name), file + " missing job " + name);
  for (const guard of protections)
    assert.ok(data.includes(guard), file + " missing isolation guard " + guard);
}
const runbook = readFileSync("docs/LITERARY_LEGACY_DRAIN_CUTOVER.md", "utf8");
assert.match(runbook, /INSERT INTO cove_runtime_config\(key,value,updated_at\)/);
assert.match(runbook, /SET value='isolated',updated_at=datetime\('now'\)/);
assert.ok(runbook.includes("zero legacy literary jobs"));
console.log("RELEASE_STAGE_GATES_PASS: main-only staging, concurrency, required rights/QA and owner timestamp checks");
