import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const workflow = readFileSync(
  ".github/workflows/cove-protected-zero-traffic-worker-upload.yml",
  "utf8",
);
const runner = readFileSync("scripts/release/protected-zero-traffic-worker-upload.mjs", "utf8");

test("no push, PR, timer or build can upload a production Worker version", () => {
  assert.match(workflow, /^  workflow_dispatch:/m);
  assert.match(workflow, /^  pull_request:/m);
  assert.doesNotMatch(workflow, /^  push:/m);
  assert.doesNotMatch(workflow, /^  schedule:/m);
  assert.match(workflow, /github\.event_name == 'workflow_dispatch'/);
  assert.match(workflow, /github\.ref == 'refs\/heads\/main'/);
  assert.match(workflow, /inputs\.confirm_zero_traffic_only == true/);
  assert.match(workflow, /environment: cove-production-release-audit/);
});

test("separate constrained upload secret, source pin and no automatic D1 migration", () => {
  assert.match(workflow, /secrets\.COVE_CF_WORKERS_VERSION_UPLOAD_TOKEN/);
  assert.doesNotMatch(workflow, /secrets\.CLOUDFLARE_API_TOKEN/);
  assert.match(workflow, /reviewed_source_sha == 'c3c1a68dd239aca018040d3165c44630118ae8af'/);
  assert.match(workflow, /wrangler versions upload/);
  assert.doesNotMatch(
    workflow,
    /wrangler (?:deploy|versions deploy|d1 execute|d1 migrations apply)/,
  );
  assert.match(workflow, /scripts\/release\/protected-zero-traffic-worker-upload\.mjs fence/);
  assert.match(runner, /REVIEWED_BACKEND_SOURCE/);
  assert.match(runner, /assertReviewedSource\(\)/);
});

test("script never calls a Cloudflare write API and accepts only exact pinned main dispatch", () => {
  assert.match(runner, /method: "GET"/);
  assert.doesNotMatch(runner, /method:\s*"(?:POST|PUT|PATCH|DELETE)"/);
  assert.match(runner, /GITHUB_REPOSITORY, "JibrilMohamud\/cove"/);
  assert.match(runner, /GITHUB_EVENT_NAME, "workflow_dispatch"/);
  assert.match(runner, /GITHUB_REF, "refs\/heads\/main"/);
  assert.match(runner, /assertPinnedProductionDeployment\(deployed\)/);
  assert.match(runner, /assertProductionStillDisabled\(\)/);
  assert.match(runner, /assertExactNonsecretResourceParity\(oldVersion, candidate\)/);
});

test("the production gateway still prohibits uncontrolled main Git deployments", () => {
  const vercel = JSON.parse(readFileSync("vercel.json", "utf8"));
  assert.equal(vercel.git.deploymentEnabled.main, false);
  assert.equal(vercel.git.deploymentEnabled["*"], undefined);
});
