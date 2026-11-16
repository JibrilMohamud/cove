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
  assert.match(workflow, /reviewed_source_sha == 'a3fd303da6f7418ceec574e0c158d62fe1245984'/);
  assert.match(workflow, /wrangler versions upload/);
  assert.match(workflow, /--keep-vars --strict/, "reject conflicting remote Worker config");
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

test("cross-Worker owner reads require distinct metadata-only authority", () => {
  assert.match(workflow, /secrets\.COVE_CF_WORKERS_VERSION_UPLOAD_TOKEN/);
  assert.match(workflow, /secrets\.COVE_CF_WORKERS_METADATA_READ_TOKEN/);
  assert.match(runner, /const ownerReadToken = process\.env\.COVE_CF_WORKERS_METADATA_READ_TOKEN;/);
  assert.match(runner, /assert\.notEqual\(\s*ownerReadToken,\s*token,/);
  assert.match(runner, /const bearer = path === OWNER_SETTINGS_PATH \? ownerReadToken : token;/);
  assert.match(runner, /const owner = await get\(OWNER_SETTINGS_PATH\);/);
  assert.match(runner, /method: "GET"/);
  assert.doesNotMatch(workflow, /secrets\.CLOUDFLARE_API_TOKEN/);
});

test("only the protected live upload holds the primary-D1 release lock", () => {
  const [offline, live] = workflow.split("  upload_archived_only:\n");
  assert.ok(live, "Protected upload job must exist");
  assert.doesNotMatch(offline, /^concurrency:/m, "PR-only checks must not consume the live lock");
  assert.match(
    live,
    /    concurrency:\n      group: cove-exclusive-real-primary-cold-acceptance\n      queue: max\n      cancel-in-progress: false/,
  );
  assert.match(live, /environment: cove-production-release-audit/);
  assert.match(live, /wrangler versions upload/);
});

test("the production gateway still prohibits uncontrolled main Git deployments", () => {
  const vercel = JSON.parse(readFileSync("vercel.json", "utf8"));
  assert.equal(vercel.git.deploymentEnabled.main, false);
  assert.equal(vercel.git.deploymentEnabled["*"], undefined);
});
