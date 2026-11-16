import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import {
  WORKER_ACCOUNT,
  WORKER_NAME,
  REVIEWED_BACKEND_SOURCE,
  assertPinnedProductionDeployment,
  assertExactNonsecretResourceParity,
} from "./zero-traffic-worker-version-fence.mjs";
import {
  CANDIDATE_VERSION,
  CANDIDATE_NUMBER,
  INVALID_SYNTHETIC_TOKEN,
  READ_ONLY_CASES,
  assertSafePreviewCase,
  assertUnauthorizedVersionResponse,
} from "./version454-preview-readonly-policy.mjs";

const mode = process.argv[2];
assert.ok(["preflight", "probe", "fence"].includes(mode), "Invalid protected preview mode");
assert.equal(process.env.GITHUB_REPOSITORY, "JibrilMohamud/cove");
assert.equal(process.env.GITHUB_EVENT_NAME, "workflow_dispatch");
assert.equal(process.env.GITHUB_REF, "refs/heads/main");
assert.match(String(process.env.GITHUB_RUN_ID || ""), /^[0-9]{8,15}$/);
assert.equal(process.env.COVE_APPROVED_DIAGNOSTIC_SOURCE, REVIEWED_BACKEND_SOURCE);
assert.equal(process.env.COVE_EXPECTED_ARCHIVED_VERSION, CANDIDATE_VERSION);

const evidenceDir = "artifacts/protected-version454-preview";
const workerBase = "/accounts/" + WORKER_ACCOUNT + "/workers/scripts/" + WORKER_NAME;
const ownerSettings =
  "/accounts/" + WORKER_ACCOUNT + "/workers/scripts/cove-legal-authority-production/settings";

async function readControlPlane(path, token) {
  assert.ok(
    [workerBase + "/deployments", workerBase + "/versions/" + CANDIDATE_VERSION,
      workerBase + "/versions/401f2af2-6e69-4611-8110-1d127af6eecf", ownerSettings].includes(path),
    "Unapproved Cloudflare read",
  );
  const response = await fetch("https://api.cloudflare.com/client/v4" + path, {
    method: "GET",
    headers: { authorization: "Bearer " + token },
    redirect: "error",
    signal: AbortSignal.timeout(15000),
  });
  assert.ok(response.ok, "Protected Worker metadata read unavailable");
  const body = await response.json();
  assert.equal(body.success, true, "Worker metadata read unsuccessful");
  return body.result;
}

function assertSourceUnchanged() {
  const allowed = [
    "src", "drizzle", "package.json", "package-lock.json",
    "scripts/build-persistence-backend.mjs", ".github/workflows/deploy-persistence-backend.yml",
  ];
  const diff = spawnSync("git", [
    "diff", "--name-only", REVIEWED_BACKEND_SOURCE, "HEAD", "--", ...allowed,
  ], { encoding: "utf8", timeout: 20000 });
  assert.equal(diff.status, 0, "Cannot verify reviewed source freeze");
  assert.equal(diff.stdout.trim(), "", "Reviewed production backend sources changed");
}

async function controlPlaneGate() {
  assert.equal(process.env.CLOUDFLARE_ACCOUNT_ID, WORKER_ACCOUNT);
  const writer = process.env.CLOUDFLARE_API_TOKEN;
  const reader = process.env.COVE_CF_WORKERS_METADATA_READ_TOKEN;
  assert.ok(typeof writer === "string" && writer.length >= 24, "Scoped Worker metadata credential absent");
  assert.ok(typeof reader === "string" && reader.length >= 24, "Distinct owner metadata reader absent");
  assert.notEqual(writer, reader, "Uploader and owner metadata credentials must be distinct");
  const [deployments, oldVersion, candidate, owner] = await Promise.all([
    readControlPlane(workerBase + "/deployments", writer),
    readControlPlane(workerBase + "/versions/401f2af2-6e69-4611-8110-1d127af6eecf", writer),
    readControlPlane(workerBase + "/versions/" + CANDIDATE_VERSION, writer),
    readControlPlane(ownerSettings, reader),
  ]);
  const pinned = assertPinnedProductionDeployment(deployments);
  assert.equal(candidate.id, CANDIDATE_VERSION, "Archived candidate identity drift");
  assert.equal(candidate.number, CANDIDATE_NUMBER, "Archived candidate version changed");
  const parity = assertExactNonsecretResourceParity(oldVersion, candidate);
  const ownerFlag = (owner?.bindings || []).filter((b) => b.name === "COVE_RIGHTS_OWNER_ENABLED");
  assert.equal(ownerFlag.length, 1, "Legal owner disabled-control missing or duplicated");
  assert.equal(ownerFlag[0].type, "plain_text");
  assert.equal(ownerFlag[0].text, "0", "Legal owner is not disabled");
  return { pinned, parity };
}

async function probe() {
  // No real backend token, provider token, cookies, user IDs, or requests
  // with write methods are ever injected into the version-URL probe step.
  assert.equal(process.env.CLOUDFLARE_API_TOKEN, undefined);
  assert.equal(process.env.COVE_CF_WORKERS_METADATA_READ_TOKEN, undefined);
  assert.equal(process.env.FORE_BACKEND_TOKEN, undefined);
  const results = [];
  for (const input of READ_ONLY_CASES) {
    const url = assertSafePreviewCase(input);
    const headers = { accept: "application/json" };
    if (input.invalidToken) headers["x-cove-backend-token"] = INVALID_SYNTHETIC_TOKEN;
    const start = performance.now();
    const response = await fetch(url, {
      method: "GET",
      headers,
      redirect: "manual",
      cache: "no-store",
      signal: AbortSignal.timeout(12000),
    });
    const elapsedMs = Math.round(performance.now() - start);
    assertUnauthorizedVersionResponse(response);
    // Never copy, render, or log body content from the production-bound version.
    void response.body?.cancel().catch(() => {});
    results.push({ case: input.label, status: response.status, elapsedMs });
  }
  mkdirSync(evidenceDir, { recursive: true });
  writeFileSync(
    evidenceDir + "/evidence.json",
    JSON.stringify({
      event: "cove_archived_worker_version454_readonly_denial",
      versionId: CANDIDATE_VERSION,
      requests: results,
      authenticatedHealthOrCatalogTested: false,
      customerTrafficChanged: false,
      rightsOrPaymentsTested: false,
      releaseCertified: false,
    }, null, 2) + "\n",
    { mode: 0o600 },
  );
  console.log(JSON.stringify({
    event: "cove_archived_worker_version454_preview_denial_pass",
    version: CANDIDATE_NUMBER,
    cases: results,
    releaseCertified: false,
  }));
}

if (mode === "probe") {
  await probe();
} else {
  if (mode === "preflight") assertSourceUnchanged();
  const result = await controlPlaneGate();
  console.log(JSON.stringify({
    event: mode === "preflight" ? "cove_archived_preview_preflight" : "cove_archived_preview_postflight",
    version: CANDIDATE_NUMBER,
    candidatePercent: 0,
    currentProductionVersionPercent: result.pinned.percentage,
    originalBindingsMatch: result.parity.bindingsMatch,
    originalRuntimeMatches: result.parity.runtimeMatches,
    legalOwnerDisabled: true,
    releaseCertified: false,
  }));
}
