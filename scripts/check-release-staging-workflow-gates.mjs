import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const requirements = [
  {
    file: ".github/workflows/fast-storefront-real-catalog-acceptance.yml",
    names: ["protected-real-catalog-acceptance:"],
    protections: [
      "cove-exclusive-real-primary-cold-acceptance",
      'COVE_REAL_ACCEPTANCE_V2: "1"',
      "strangler-real-catalog-acceptance.mjs",
      "real-data-parity-",
      "sha256sum -c -",
    ],
  },
  {
    file: ".github/workflows/cove-commerce-private-qa-deploy.yml",
    names: ["private-commerce:", "authenticated-commerce:"],
    protections: [
      "wrangler.commerce-qa.stage.toml",
      "COVE_QA_BUYER_EMAIL",
      "COVE_QA_OUTSIDER_EMAIL",
      "check-commerce-private-qa-stage.mjs",
    ],
  },
  {
    file: ".github/workflows/continuous-publication-qa.yml",
    names: ["private-qa:"],
    protections: [
      "deploy-continuous-publication-qa.mjs",
      "verify-continuous-publication-qa.mjs",
      "cove-continuous-publication-qa",
    ],
  },
  {
    file: ".github/workflows/strangler-hosted-capacity-evaluation.yml",
    names: ["protected-staging-only:"],
    protections: [
      "check-strangler-data-plane-preflight.mjs",
      "cove-strangler-ephemeral-capacity-stage",
      "assert-strangler-capacity-evidence.mjs",
    ],
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
const capacity = readFileSync("scripts/staging/check-strangler-live-capacity.mjs", "utf8");
const evidence = readFileSync("scripts/staging/assert-strangler-capacity-evidence.mjs", "utf8");
assert.ok(capacity.includes("const p95MaximumMs = 600;"));
assert.ok(capacity.includes("const p99MaximumMs = 750;"));
assert.ok(capacity.includes("rate === 100 ? 20 : 10"));
assert.ok(capacity.includes("p99Ms < p99MaximumMs"));
assert.ok(capacity.includes('name === "100-rps-20s"'));
assert.ok(evidence.includes('"100-rps-20s"'));
assert.ok(evidence.includes("item.p95Ms < 600"));
assert.ok(evidence.includes("item.p99Ms < 750"));
assert.ok(evidence.includes("item.maxMs < 800"));
assert.ok(evidence.includes('item.name !== "100-rps-20s"'));
const realCatalog = readFileSync(
  "scripts/performance/strangler-real-catalog-acceptance.mjs",
  "utf8",
);
assert.ok(realCatalog.includes("const prodDbId ="));
assert.ok(realCatalog.includes("assert.equal(config.workers_dev, false)"));
assert.ok(realCatalog.includes("config.services = []"));
assert.ok(realCatalog.includes("evidence.stageMobileLcp.p75Ms < 2500"));
assert.ok(realCatalog.includes("evidence.realCatalogParity.mismatchPercent < 10"));
assert.ok(realCatalog.includes("evidence.realCatalogParity.desktopMismatchPercent < 10"));
assert.ok(realCatalog.includes("evidence.cold.every((cold) => cold.ok && cold.ms < 800)"));
const runbook = readFileSync("docs/LITERARY_LEGACY_DRAIN_CUTOVER.md", "utf8");
assert.match(runbook, /INSERT INTO cove_runtime_config\(key,value,updated_at\)/);
assert.match(runbook, /SET value='isolated',updated_at=datetime\('now'\)/);
assert.ok(runbook.includes("zero legacy literary jobs"));
console.log(
  "RELEASE_STAGE_GATES_PASS: main-only staging, concurrency, required rights/QA and owner timestamp checks",
);
