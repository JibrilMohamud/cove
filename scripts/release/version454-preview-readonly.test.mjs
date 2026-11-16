import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  CANDIDATE_VERSION,
  CANDIDATE_NUMBER,
  EXPECTED_PREVIEW_ORIGIN,
  INVALID_SYNTHETIC_TOKEN,
  READ_ONLY_CASES,
  assertSafePreviewCase,
  assertUnauthorizedVersionResponse,
} from "./version454-preview-readonly-policy.mjs";

const workflow = readFileSync(".github/workflows/cove-protected-version454-preview-readonly.yml", "utf8");
const runner = readFileSync("scripts/release/probe-version454-readonly.mjs", "utf8");

test("uploaded version 454 uses exactly the real version URL from successful run #25", () => {
  assert.equal(CANDIDATE_VERSION, "adc603f1-d82a-44d9-b302-509690dec5bd");
  assert.equal(CANDIDATE_NUMBER, 454);
  assert.equal(
    EXPECTED_PREVIEW_ORIGIN,
    "https://adc603f1-cove-persistence-backend.cove-jibrilmohamud.workers.dev",
  );
  assert.deepEqual(READ_ONLY_CASES.map((x) => x.label), [
    "health-no-token", "health-invalid-token", "catalog-no-token",
  ]);
  assert.ok(INVALID_SYNTHETIC_TOKEN.length >= 24);
  assert.ok(INVALID_SYNTHETIC_TOKEN.startsWith("cove-synthetic-invalid-"));
  for (const item of READ_ONLY_CASES) {
    const url = assertSafePreviewCase(item);
    assert.equal(url.search, "");
    assert.equal(url.origin, EXPECTED_PREVIEW_ORIGIN);
  }
  assert.throws(() => assertSafePreviewCase({ label: "fake", path: "/", invalidToken: false }));
});

test("only an actual Worker 401 JSON denial with no-store and nosniff is accepted", () => {
  const response = (status, headers) => ({
    status,
    redirected: false,
    headers: new Headers(headers),
  });
  const good = {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "private, no-store",
    "x-content-type-options": "nosniff",
  };
  assert.equal(assertUnauthorizedVersionResponse(response(401, good)), true);
  for (const status of [200, 301, 302, 403, 404, 429, 500, 503])
    assert.throws(() => assertUnauthorizedVersionResponse(response(status, good)));
  assert.throws(() =>
    assertUnauthorizedVersionResponse(response(401, { ...good, "cache-control": "public, max-age=60" })),
  );
  assert.throws(() =>
    assertUnauthorizedVersionResponse(response(401, { ...good, "content-type": "text/html" })),
  );
  assert.throws(() =>
    assertUnauthorizedVersionResponse(response(401, { ...good, "x-content-type-options": "unsafe" })),
  );
  assert.throws(() =>
    assertUnauthorizedVersionResponse({ ...response(401, good), redirected: true }),
  );
});

test("manual protected read-only job cannot deploy, write, auto-run or reuse public credentials", () => {
  assert.match(workflow, /^  workflow_dispatch:/m);
  assert.match(workflow, /^  pull_request:/m);
  assert.doesNotMatch(workflow, /^  push:/m);
  assert.doesNotMatch(workflow, /^  schedule:/m);
  assert.match(workflow, /github\.event_name == 'workflow_dispatch'/);
  assert.match(workflow, /github\.ref == 'refs\/heads\/main'/);
  assert.match(workflow, /environment: cove-production-release-audit/);
  assert.match(workflow, /concurrency:\n      group: cove-exclusive-real-primary-cold-acceptance/);
  assert.match(workflow, /inputs\.confirm_readonly_version_preview == true/);
  assert.match(workflow, /COVE_EXPECTED_ARCHIVED_VERSION: \\$\\{\\{ inputs\\.candidate_version_id \\}\\}/);
  assert.match(workflow, /inputs\\.candidate_version_id == 'adc603f1-d82a-44d9-b302-509690dec5bd'/);
  assert.doesNotMatch(workflow, /wrangler|d1 execute|d1 migrations|versions deploy|npm exec/);
  assert.doesNotMatch(workflow, /continue-on-error: true/);
});

test("credentials are scoped to GET-only preflight and final fence, never public preview requests", () => {
  const live = workflow.split("  verify_archived_without_deploy:\n")[1];
  assert.ok(live);
  const steps = live.split("    steps:\n")[1];
  const pre = steps.split("      - name: Assert approved source, archived parity and 100% pin\n")[1].split(
    "      - name: Probe only anonymous deny paths on the version URL\n",
  )[0];
  const probe = steps.split("      - name: Probe only anonymous deny paths on the version URL\n")[1].split(
    "      - name: Always reverify pinned production traffic and disabled owner\n",
  )[0];
  const fence = steps.split("      - name: Always reverify pinned production traffic and disabled owner\n")[1].split(
    "      - name: Archive numeric-only preflight evidence\n",
  )[0];
  assert.match(pre, /secrets\.COVE_CF_WORKERS_VERSION_UPLOAD_TOKEN/);
  assert.match(pre, /secrets\.COVE_CF_WORKERS_METADATA_READ_TOKEN/);
  assert.doesNotMatch(probe, /secrets\.|CLOUDFLARE_API_TOKEN|COVE_CF_WORKERS_METADATA_READ_TOKEN/);
  assert.match(probe, /probe-version454-readonly\.mjs probe/);
  assert.match(fence, /secrets\.COVE_CF_WORKERS_VERSION_UPLOAD_TOKEN/);
  assert.match(fence, /secrets\.COVE_CF_WORKERS_METADATA_READ_TOKEN/);
  assert.match(fence, /if: always\(\)/);
  assert.doesNotMatch(live.split("    steps:\n")[0], /secrets\./);
});

test("actual preview code performs at most 3 fixed GETs, no mutations or authenticated commerce", () => {
  assert.match(runner, /for \(const input of READ_ONLY_CASES\)/);
  assert.match(runner, /method: "GET"/);
  assert.doesNotMatch(runner, /method: "(?:POST|PUT|PATCH|DELETE)"/);
  assert.match(runner, /assertUnauthorizedVersionResponse\(response\)/);
  assert.match(runner, /assertPinnedProductionDeployment\(deployments\)/);
  assert.match(runner, /assertExactNonsecretResourceParity\(oldVersion, candidate\)/);
  assert.match(runner, /assertSourceUnchanged\(\)/);
  assert.match(runner, /ownerFlag\[0\]\.text, "0"/);
  assert.match(runner, /process\.env\.CLOUDFLARE_API_TOKEN, undefined/);
  assert.match(runner, /process\.env\.FORE_BACKEND_TOKEN, undefined/);
  assert.match(runner, /authenticatedHealthOrCatalogTested: false/);
  assert.doesNotMatch(runner, /method: "POST"|method: "DELETE"|wrangler versions deploy/);
});
