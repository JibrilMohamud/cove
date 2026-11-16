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
  assert.match(workflow, /node_modules\/\.bin\/wrangler" versions upload/);
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
  assert.match(live, /node_modules\/\.bin\/wrangler" versions upload/);
});

test("npm install and build never receive privileged Cloudflare credentials", () => {
  const live = workflow.split("  upload_archived_only:\n")[1];
  assert.ok(live, "Protected manual upload job missing");
  const [jobHeader, steps] = live.split("    steps:\n");
  assert.doesNotMatch(jobHeader, /CLOUDFLARE_API_TOKEN|COVE_CF_WORKERS_METADATA_READ_TOKEN/);
  assert.doesNotMatch(jobHeader, /secrets\./);

  const between = (first, last) => {
    const start = steps.indexOf("      - name: " + first);
    const end = steps.indexOf("      - name: " + last, start + first.length);
    assert.ok(start >= 0 && end > start, "Required upload step missing");
    return steps.slice(start, end);
  };
  const setup = steps.slice(0, steps.indexOf("      - name: Verify frozen reviewed source"));
  assert.match(setup, /npm ci --no-audit --no-fund/);
  assert.doesNotMatch(setup, /secrets\./, "Checkout/setup must not access production secrets");

  const preflight = between("Verify frozen reviewed source", "Build reviewed Worker");
  assert.match(preflight, /CLOUDFLARE_API_TOKEN: .*COVE_CF_WORKERS_VERSION_UPLOAD_TOKEN/);
  assert.match(
    preflight,
    /COVE_CF_WORKERS_METADATA_READ_TOKEN: .*COVE_CF_WORKERS_METADATA_READ_TOKEN/,
  );

  const build = between("Build reviewed Worker", "Stage pinned Wrangler");
  assert.doesNotMatch(build, /secrets\./, "Compilation must not access Cloudflare tokens");
  const staging = between("Stage pinned Wrangler", "Upload an INACTIVE version");
  assert.match(staging, /npm install --prefix/);
  assert.match(staging, /--ignore-scripts/);
  assert.doesNotMatch(staging, /secrets\./);

  const upload = between("Upload an INACTIVE version", "Verify one archived version");
  assert.match(upload, /CLOUDFLARE_API_TOKEN: .*COVE_CF_WORKERS_VERSION_UPLOAD_TOKEN/);
  assert.doesNotMatch(upload, /COVE_CF_WORKERS_METADATA_READ_TOKEN:/);
  assert.doesNotMatch(upload, /npm (?:exec|install|ci)|npx/);
  assert.match(upload, /node_modules\/\.bin\/wrangler" versions upload/);

  const verify = between("Verify one archived version", "ALWAYS verify");
  assert.match(verify, /CLOUDFLARE_API_TOKEN: .*COVE_CF_WORKERS_VERSION_UPLOAD_TOKEN/);
  assert.match(
    verify,
    /COVE_CF_WORKERS_METADATA_READ_TOKEN: .*COVE_CF_WORKERS_METADATA_READ_TOKEN/,
  );

  const fence = between("ALWAYS verify", "Archive public identifiers");
  assert.match(fence, /CLOUDFLARE_API_TOKEN: .*COVE_CF_WORKERS_VERSION_UPLOAD_TOKEN/);
  assert.match(fence, /COVE_CF_WORKERS_METADATA_READ_TOKEN: .*COVE_CF_WORKERS_METADATA_READ_TOKEN/);
  assert.match(fence, /if: always\(\)/);
});

test("the production gateway still prohibits uncontrolled main Git deployments", () => {
  const vercel = JSON.parse(readFileSync("vercel.json", "utf8"));
  assert.equal(vercel.git.deploymentEnabled.main, false);
  assert.equal(vercel.git.deploymentEnabled["*"], undefined);
});
