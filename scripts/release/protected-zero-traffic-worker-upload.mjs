import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import {
  WORKER_ACCOUNT,
  WORKER_NAME,
  PINNED_DEPLOYMENT,
  PINNED_VERSION,
  REVIEWED_BACKEND_SOURCE,
  assertPinnedProductionDeployment,
  assertBaselineResources,
  assertExactNonsecretResourceParity,
  detectExactlyOneArchivedCandidate,
} from "./zero-traffic-worker-version-fence.mjs";

const mode = process.argv[2];
if (!["preflight", "verify", "fence"].includes(mode)) {
  throw Error("Expected preflight, verify or fence mode");
}
// This script NEVER calls a Cloudflare API mutation. The only mutation in
// this release procedure is the separate, protected 'wrangler versions upload'
// command. No customer deployment, routes, D1 queries or migrations.
assert.equal(process.env.GITHUB_REPOSITORY, "JibrilMohamud/cove");
assert.equal(process.env.GITHUB_EVENT_NAME, "workflow_dispatch");
assert.equal(process.env.GITHUB_REF, "refs/heads/main");
assert.equal(process.env.CLOUDFLARE_ACCOUNT_ID, WORKER_ACCOUNT);
assert.equal(process.env.COVE_APPROVED_DIAGNOSTIC_SOURCE, REVIEWED_BACKEND_SOURCE);
const token = process.env.CLOUDFLARE_API_TOKEN;
assert.ok(
  typeof token === "string" && token.length >= 24,
  "Protected upload-only credential absent",
);
const runId = String(process.env.GITHUB_RUN_ID || "");
assert.match(runId, /^[0-9]{8,15}$/);
const evidenceDir = "artifacts/protected-zero-traffic-worker-upload";
const evidenceFile = evidenceDir + "/evidence.json";
const beforeFile = evidenceDir + "/before.json";
const base = `/accounts/${WORKER_ACCOUNT}/workers/scripts/${WORKER_NAME}`;

async function get(path) {
  const response = await fetch("https://api.cloudflare.com/client/v4" + path, {
    method: "GET",
    headers: { authorization: "Bearer " + token },
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw Error("Protected Cloudflare read unavailable: HTTP " + response.status);
  const result = await response.json();
  assert.equal(result.success, true, "Cloudflare read returned unsuccessful result");
  return result.result;
}

async function assertProductionStillDisabled() {
  const owner = await get(
    `/accounts/${WORKER_ACCOUNT}/workers/scripts/cove-legal-authority-production/settings`,
  );
  const values = (owner?.bindings || []).filter((b) => b.name === "COVE_RIGHTS_OWNER_ENABLED");
  assert.equal(values.length, 1, "Missing unique production rights-owner control");
  assert.equal(values[0].type, "plain_text");
  assert.equal(values[0].text, "0", "Owner activation changed during diagnostic upload");
}

async function fence() {
  const deployments = await get(base + "/deployments");
  const pinned = assertPinnedProductionDeployment(deployments);
  await assertProductionStillDisabled();
  return pinned;
}

function assertReviewedSource() {
  const allowed = [
    "src",
    "drizzle",
    "package.json",
    "package-lock.json",
    "scripts/build-persistence-backend.mjs",
    ".github/workflows/deploy-persistence-backend.yml",
  ];
  const diff = spawnSync(
    "git",
    ["diff", "--name-only", REVIEWED_BACKEND_SOURCE, "HEAD", "--", ...allowed],
    {
      encoding: "utf8",
      timeout: 20000,
    },
  );
  assert.equal(diff.status, 0, "Unable to verify exact approved backend sources");
  assert.equal(diff.stdout.trim(), "", "Backend sources differ from reviewed diagnostic source");
}

function generateCanonicalConfig() {
  const workflow = readFileSync(".github/workflows/deploy-persistence-backend.yml", "utf8");
  const begin = "      - name: Write deployment config\n";
  const end = "      # Worker secrets are owned by Cloudflare.";
  assert.equal(workflow.split(begin).length, 2, "Deployment config block changed");
  assert.equal(workflow.split(end).length, 2, "Deployment config end marker changed");
  const section = workflow.split(begin)[1].split(end)[0];
  const run = section.split("        run: |\n");
  assert.equal(run.length, 2, "Canonical production config generation unavailable");
  const shell = run[1]
    .split("\n")
    .map((line) => (line.startsWith("          ") ? line.slice(10) : line))
    .join("\n");
  assert.match(shell, /cat > wrangler\.backend\.deploy\.toml <<EOF/);
  const env = {
    ...process.env,
    WORKER_NAME,
    D1_DATABASE_ID: "4bd657ac-8789-403e-a28c-93aba8d0a989",
    D1_DATABASE_NAME: "cove-production",
    R2_BUCKET_NAME: "cove-production-media",
    PUBLIC_URL: "https://cove-puce-theta.vercel.app",
  };
  const generated = spawnSync("bash", ["-c", shell], { encoding: "utf8", env, timeout: 20000 });
  assert.equal(generated.status, 0, "Failed to recreate canonical production config");
  const config = readFileSync("wrangler.backend.deploy.toml", "utf8");
  assert.match(config, /name = "cove-persistence-backend"/);
  assert.match(config, /database_id = "4bd657ac-8789-403e-a28c-93aba8d0a989"/);
  assert.match(config, /script_name = "cove-legal-authority-production"/);
  assert.match(config, /dataset = "cove_public_http_ops"/);
  assert.match(config, /compatibility_date = "2026-09-01"/);
  assert.match(config, /keep_vars = true/);
  assert.doesNotMatch(config, /\broutes\s*=|cove-qa|staging-route/i);
}

if (mode === "preflight") {
  assertReviewedSource();
  generateCanonicalConfig();
  const [deployed, oldVersion, versions] = await Promise.all([
    get(base + "/deployments"),
    get(base + "/versions/" + PINNED_VERSION),
    get(base + "/versions?per_page=20"),
  ]);
  assertPinnedProductionDeployment(deployed);
  const bindingCount = assertBaselineResources(oldVersion);
  await assertProductionStillDisabled();
  assert.ok(Array.isArray(versions?.items) && versions.items.length > 0, "Version list missing");
  const prior = {
    pin: PINNED_DEPLOYMENT,
    version: PINNED_VERSION,
    runId,
    reviewedSource: REVIEWED_BACKEND_SOURCE,
    versionIds: versions.items.map((x) => x.id),
  };
  mkdirSync(evidenceDir, { recursive: true });
  writeFileSync(beforeFile, JSON.stringify(prior), { mode: 0o600 });
  console.log(
    JSON.stringify({
      event: "cove_zero_traffic_worker_upload_preflight",
      pinnedVersion: 451,
      percentage: 100,
      bindingCount,
      rightsOwnerEnabled: false,
      reviewedSource: true,
      migrations: false,
      releaseCertified: false,
    }),
  );
} else if (mode === "verify") {
  const before = JSON.parse(readFileSync(beforeFile, "utf8"));
  assert.equal(before.runId, runId);
  assert.equal(before.pin, PINNED_DEPLOYMENT);
  assert.equal(before.version, PINNED_VERSION);
  assert.equal(before.reviewedSource, REVIEWED_BACKEND_SOURCE);
  const [deployed, oldVersion, versions] = await Promise.all([
    get(base + "/deployments"),
    get(base + "/versions/" + PINNED_VERSION),
    get(base + "/versions?per_page=20"),
  ]);
  assertPinnedProductionDeployment(deployed);
  const archived = detectExactlyOneArchivedCandidate(before.versionIds, versions?.items);
  const candidate = await get(base + "/versions/" + archived.id);
  assert.equal(candidate.number, archived.number, "Version identity drift");
  const parity = assertExactNonsecretResourceParity(oldVersion, candidate);
  await assertProductionStillDisabled();
  const evidence = {
    event: "cove_reviewed_zero_traffic_worker_version_uploaded",
    version: archived.number,
    versionId: archived.id,
    pin: PINNED_VERSION,
    pinnedPercent: 100,
    candidatePercent: 0,
    ...parity,
    migrationsRun: false,
    rightsOwnerActivation: false,
    workerDeploymentChanged: false,
    releaseCertified: false,
  };
  writeFileSync(evidenceFile, JSON.stringify(evidence, null, 2) + "\n", { mode: 0o600 });
  console.log(JSON.stringify(evidence));
} else {
  const pinned = await fence();
  console.log(
    JSON.stringify({
      event: "cove_unconditional_zero_traffic_release_fence",
      pin: pinned.versionId,
      customerPercent: pinned.percentage,
      rightsOwnerStillDisabled: true,
      releaseCertified: false,
    }),
  );
}
