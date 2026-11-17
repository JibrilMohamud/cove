import assert from "node:assert/strict";

const ACCOUNT = "d26430caa63ec55f6612e32f36aca5e9";
const PRODUCTION_PERSISTENCE_VERSION = "401f2af2-6e69-4611-8110-1d127af6eecf";
const PRIVATE_READ_VERSION = "f252025f-04c4-4e71-a9e9-134ee3f4c6c3";
const D1_READ = "192192df92ee43ac90f2aeeffce67e35";
const WORKERS_SCRIPTS_WRITE = "e086da7e2179491d91ee5f35b3ca210a";
const STAGE_READER = "cove-canonical-phase-readonly-staging";
const STAGE_SSR = "cove-storefront-phase-staging";

export function assertExactTokenPolicy(token, groupId) {
  assert.equal(token?.status, "active", "Protected token must be active");
  assert.equal(token?.policies?.length, 1, "Token must have one reviewed policy");
  const policy = token.policies[0];
  assert.equal(policy.effect, "allow", "Token policy must be positive");
  assert.deepEqual(
    policy.permission_groups?.map((group) => group.id),
    [groupId],
    "Unexpected extra token capability",
  );
  assert.deepEqual(policy.resources, {
    ["com.cloudflare.api.account." + ACCOUNT]: "*",
  });
}

export function assertPinnedDeployment(payload, versionId) {
  const deployments = payload?.deployments;
  assert.ok(Array.isArray(deployments) && deployments.length, "No Worker deployment");
  const versions = deployments[0].versions;
  assert.deepEqual(
    versions?.map((version) => ({
      version_id: version.version_id,
      percentage: version.percentage,
    })),
    [{ version_id: versionId, percentage: 100 }],
    "Existing Worker version/traffic pin changed",
  );
}

export function assertIsolatedStageBindings(reader, ssr) {
  const bindings = reader?.bindings || [];
  assert.ok(!bindings.some((binding) => binding.type === "d1"), "No native D1 in stage reader");
  assert.deepEqual(bindings.map((binding) => binding.name).sort(), [
    "COVE_STAGE_READ_PHASE_DIAGNOSTICS",
    "D1_READ_API_TOKEN",
  ]);
  assert.equal(
    bindings.find((binding) => binding.name === "COVE_STAGE_READ_PHASE_DIAGNOSTICS")?.text,
    "1",
  );
  assert.equal(
    bindings.find((binding) => binding.name === "D1_READ_API_TOKEN")?.type,
    "secret_text",
  );
  const frontend = ssr?.bindings || [];
  assert.ok(!frontend.some((binding) => binding.type === "d1"), "No native D1 in stage SSR");
  assert.ok(!frontend.some((binding) => binding.type === "r2_bucket"), "No production R2 access");
  assert.ok(
    frontend.some(
      (binding) =>
        binding.type === "service" &&
        binding.name === "COVE_CANONICAL_READONLY" &&
        binding.service === STAGE_READER,
    ),
    "Stage SSR must use the separate read service",
  );
  assert.ok(
    frontend.some((binding) => binding.name === "COVE_SSR_STAGING" && binding.text === "1"),
  );
  assert.ok(
    frontend.some(
      (binding) => binding.name === "COVE_SSR_STAGING_GATE_KEY" && binding.type === "secret_text",
    ),
  );
  assert.ok(
    !frontend.some((binding) => binding.name === "COVE_SSR_STAGING_COMMERCE_QA"),
    "Only read-only staging is allowed",
  );
}

async function get(token, path, missing = false) {
  assert.ok(typeof token === "string" && token.length >= 20, "Required scope unavailable");
  const response = await fetch("https://api.cloudflare.com/client/v4" + path, {
    method: "GET",
    headers: { authorization: "Bearer " + token },
    redirect: "error",
    signal: AbortSignal.timeout(12_000),
  });
  if (missing && response.status === 404) return null;
  assert.ok(response.ok, "Protected read-only Cloudflare API preflight failed");
  const payload = await response.json();
  assert.equal(payload.success, true, "Cloudflare preflight did not succeed");
  return payload.result;
}

const script = (name) => "/accounts/" + ACCOUNT + "/workers/scripts/" + name;

async function pinnedProduction(metadata) {
  const [production, owner, privateRead] = await Promise.all([
    get(metadata, script("cove-persistence-backend") + "/deployments"),
    get(metadata, script("cove-legal-authority-production") + "/settings"),
    get(metadata, script("cove-canonical-d1-readonly") + "/deployments"),
  ]);
  assertPinnedDeployment(production, PRODUCTION_PERSISTENCE_VERSION);
  assertPinnedDeployment(privateRead, PRIVATE_READ_VERSION);
  assert.equal(
    owner?.bindings?.find((binding) => binding.name === "COVE_RIGHTS_OWNER_ENABLED")?.text,
    "0",
    "Production legal owner changed",
  );
}

async function stageAbsent(metadata) {
  const [reader, ssr] = await Promise.all([
    get(metadata, script(STAGE_READER) + "/settings", true),
    get(metadata, script(STAGE_SSR) + "/settings", true),
  ]);
  assert.equal(reader, null, "Stage read service already exists: no overwrite");
  assert.equal(ssr, null, "Stage SSR already exists: no overwrite");
}

async function tokenPreflight() {
  const deploy = process.env.COVE_CF_STAGE_WORKERS_DEPLOY_TOKEN;
  const d1Read = process.env.COVE_CF_STAGE_D1_READ_TOKEN;
  const inventory = process.env.COVE_CF_ACCOUNT_TOKEN_INVENTORY_READ_TOKEN;
  const metadata = process.env.COVE_CF_WORKERS_METADATA_READ_TOKEN;
  const values = [deploy, d1Read, inventory, metadata];
  assert.ok(values.every((v) => typeof v === "string" && v.length >= 20));
  assert.equal(new Set(values).size, values.length, "Protected credentials must be distinct");
  const [deployIdentity, readIdentity] = await Promise.all([
    get(deploy, "/accounts/" + ACCOUNT + "/tokens/verify"),
    get(d1Read, "/accounts/" + ACCOUNT + "/tokens/verify"),
  ]);
  assert.ok(/^[a-f0-9]{32}$/.test(deployIdentity?.id || ""));
  assert.ok(/^[a-f0-9]{32}$/.test(readIdentity?.id || ""));
  const [deployDetails, readDetails] = await Promise.all([
    get(inventory, "/accounts/" + ACCOUNT + "/tokens/" + deployIdentity.id),
    get(inventory, "/accounts/" + ACCOUNT + "/tokens/" + readIdentity.id),
  ]);
  assertExactTokenPolicy(deployDetails, WORKERS_SCRIPTS_WRITE);
  assertExactTokenPolicy(readDetails, D1_READ);
}

async function verifyStage(metadata) {
  const [readerDeploy, ssrDeploy, reader, ssr, readerSubdomain, domains] = await Promise.all([
    get(metadata, script(STAGE_READER) + "/deployments"),
    get(metadata, script(STAGE_SSR) + "/deployments"),
    get(metadata, script(STAGE_READER) + "/settings"),
    get(metadata, script(STAGE_SSR) + "/settings"),
    get(metadata, script(STAGE_READER) + "/subdomain"),
    get(metadata, "/accounts/" + ACCOUNT + "/workers/domains"),
  ]);
  for (const d of [readerDeploy, ssrDeploy]) {
    const versions = d?.deployments?.[0]?.versions;
    assert.ok(
      Array.isArray(versions) && versions.length === 1 && versions[0].percentage === 100,
      "Staging must have exactly one active 100% version",
    );
  }
  assert.equal(readerSubdomain?.enabled, false, "Private read service cannot have HTTP ingress");
  assert.equal(readerSubdomain?.previews_enabled, false);
  assert.ok(
    !domains?.some((domain) => domain.service === STAGE_READER || domain.service === STAGE_SSR),
    "Stage Workers must not have a customer custom domain",
  );
  assertIsolatedStageBindings(reader, ssr);
}

export async function inspectProtectedStage(command) {
  assert.ok(["preflight", "stage", "postflight"].includes(command));
  const metadata = process.env.COVE_CF_WORKERS_METADATA_READ_TOKEN;
  await pinnedProduction(metadata);
  if (command === "preflight") {
    await tokenPreflight();
    await stageAbsent(metadata);
  } else if (command === "stage") {
    await verifyStage(metadata);
  } else {
    await stageAbsent(metadata);
  }
  return { command, productionUnchanged: true, noStagePublicDomain: true };
}

if (process.argv[1]?.endsWith("phase-stage-control-plane.mjs")) {
  const command = process.argv[2];
  inspectProtectedStage(command)
    .then((result) => console.log(JSON.stringify(result)))
    .catch(() => {
      // No API body, credential, caller value or error text in protected logs.
      console.error("Protected stage control-plane gate failed closed");
      process.exitCode = 1;
    });
}
