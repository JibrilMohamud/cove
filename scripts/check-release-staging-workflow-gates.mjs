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
      "cove-exclusive-real-primary-cold-acceptance",
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
// Both protected campaigns must have the EXACT same lock, rather than
// independent locks that allow competing cold requests on canonical D1.
for (const file of [
  ".github/workflows/fast-storefront-real-catalog-acceptance.yml",
  ".github/workflows/strangler-hosted-capacity-evaluation.yml",
]) {
  const body = readFileSync(file, "utf8");
  if (file.includes("fast-storefront-real-catalog")) {
    assert.match(body, /^  group: cove-exclusive-real-primary-cold-acceptance$/m);
  } else {
    // PR-only static CI has its own namespace; live/dispatch must use the
    // exact canonical cold-acceptance lock across both workflows.
    assert.ok(body.includes("github.event_name == 'pull_request'"));
    assert.ok(body.includes("format('cove-strangler-pr-{0}', github.event.pull_request.number)"));
    assert.ok(body.includes("|| 'cove-exclusive-real-primary-cold-acceptance' }}"));
  }
}
const capacity = readFileSync("scripts/staging/check-strangler-live-capacity.mjs", "utf8");
const evidence = readFileSync("scripts/staging/assert-strangler-capacity-evidence.mjs", "utf8");
assert.ok(capacity.includes("const p95MaximumMs = 600;"));
assert.ok(capacity.includes("const p99MaximumMs = 750;"));
assert.ok(capacity.includes('for (const phase of [1, 2]) await scheduled(100, 20, "/", phase)'));
assert.ok(capacity.includes("p99Ms < p99MaximumMs"));
assert.ok(capacity.includes("isSustainedPhase(name)"));
assert.ok(evidence.includes("validateCapacityEvidence(data"));
assert.ok(evidence.includes("sha: process.env.GITHUB_SHA"));
const realCatalog = readFileSync(
  "scripts/performance/strangler-real-catalog-acceptance.mjs",
  "utf8",
);
assert.ok(realCatalog.includes("const prodDbId ="));
assert.ok(realCatalog.includes("verifyGeoEdgeIngress(origin, process.env.GITHUB_SHA)"));
assert.ok(realCatalog.includes('config.vars.COVE_GEO_PROBE_ENABLED = "1"'));
const geoWorker = readFileSync("src/storefront-strangler/worker.ts", "utf8");
assert.ok(geoWorker.includes('env.COVE_GEO_PROBE_ENABLED === "1"'));
assert.ok(
  geoWorker.includes('url.pathname === "/__cove_geo_probe"') ||
    geoWorker.includes('new URL(request.url).pathname === "/__cove_geo_probe"'),
);
assert.ok(geoWorker.includes("productionAcceptance &&"));

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
