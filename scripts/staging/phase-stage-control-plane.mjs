import assert from "node:assert/strict";

const ACCOUNT = "d26430caa63ec55f6612e32f36aca5e9";
const PRODUCTION_PERSISTENCE_VERSION = "401f2af2-6e69-4611-8110-1d127af6eecf";
const PRIVATE_READ_VERSION = "f252025f-04c4-4e71-a9e9-134ee3f4c6c3";
const PRODUCTION_LEGAL_OWNER_VERSION = "3463ff93-f077-40bf-a4d5-fb7bfc143cd5";
const D1_READ = "192192df92ee43ac90f2aeeffce67e35";
const WORKERS_SCRIPTS_WRITE = "e086da7e2179491d91ee5f35b3ca210a";
const STAGE_READER = "cove-canonical-phase-readonly-staging";
const STAGE_SSR = "cove-storefront-phase-staging";
// One-time admin-provisioned, non-routable 401-only versions. Protected deploy
// credentials cannot create fresh Worker records under 2026 Workers roles.
export const PARKED_READER_VERSION = "06a9b74b-572f-4f2d-affd-c2cfce31d5f2";
export const PARKED_SSR_VERSION = "9ad726e2-8ac9-466c-b945-a14fdf290265";

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
  // A new config binding must never silently grant this temporary SSR Worker
  // writable KV, queues, a production service, another secret, or other
  // capabilities. Require explicit review for *every* binding name and type.
  const allowedFrontendBindings = new Map([
    ["ASSETS", "assets"],
    ["COVE_STOREFRONT_READ_LIMITER", "ratelimit"],
    ["COVE_CANONICAL_READONLY", "service"],
    ["OPS_ANALYTICS", "analytics_engine"],
    ["COVE_CANONICAL_READONLY_RPC", "plain_text"],
    ["COVE_OPS_TELEMETRY_MODE", "plain_text"],
    ["FORE_PUBLIC_URL", "plain_text"],
    ["FORE_ENVIRONMENT", "plain_text"],
    ["FORE_DEFAULT_TERRITORY", "plain_text"],
    ["COVE_SSR_STAGING", "plain_text"],
    ["COVE_SSR_STAGING_GATE_KEY", "secret_text"],
  ]);
  const seenFrontendBindings = new Set();
  for (const binding of frontend) {
    assert.ok(
      allowedFrontendBindings.get(binding.name) === binding.type,
      "Unexpected stage SSR binding name or capability type",
    );
    assert.ok(!seenFrontendBindings.has(binding.name), "Duplicate stage SSR binding");
    seenFrontendBindings.add(binding.name);
  }
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
  const [production, owner, ownerDeployment, privateRead] = await Promise.all([
    get(metadata, script("cove-persistence-backend") + "/deployments"),
    get(metadata, script("cove-legal-authority-production") + "/settings"),
    get(metadata, script("cove-legal-authority-production") + "/deployments"),
    get(metadata, script("cove-canonical-d1-readonly") + "/deployments"),
  ]);
  assertPinnedDeployment(production, PRODUCTION_PERSISTENCE_VERSION);
  assertPinnedDeployment(ownerDeployment, PRODUCTION_LEGAL_OWNER_VERSION);
  assertPinnedDeployment(privateRead, PRIVATE_READ_VERSION);
  assert.equal(
    owner?.bindings?.find((binding) => binding.name === "COVE_RIGHTS_OWNER_ENABLED")?.text,
    "0",
    "Production legal owner changed",
  );
}

export function assertParkedStage({reader, ssr, readerDeployment, ssrDeployment, readerSubdomain, ssrSubdomain, domains}) {
  assertPinnedDeployment(readerDeployment, PARKED_READER_VERSION);
  assertPinnedDeployment(ssrDeployment, PARKED_SSR_VERSION);
  for (const [name, record, subdomain] of [
    [STAGE_READER, reader, readerSubdomain],
    [STAGE_SSR, ssr, ssrSubdomain],
  ]) {
    assert.deepEqual(record?.bindings || null, [], name + " parked bindings must be empty");
    assert.equal(subdomain?.enabled, false, name + " must have no public HTTP ingress");
    assert.equal(subdomain?.previews_enabled, false, name + " previews must be disabled");
  }
  assert.ok(Array.isArray(domains), "Missing custom-domain inventory");
  assert.ok(
    !domains.some((d) => d.service === STAGE_READER || d.service === STAGE_SSR),
    "Stage Workers must have no customer custom domains",
  );
}

async function stageParked(metadata) {
  const paths = [
    script(STAGE_READER) + "/settings",
    script(STAGE_SSR) + "/settings",
    script(STAGE_READER) + "/deployments",
    script(STAGE_SSR) + "/deployments",
    script(STAGE_READER) + "/subdomain",
    script(STAGE_SSR) + "/subdomain",
    "/accounts/" + ACCOUNT + "/workers/domains",
  ];
  const [reader, ssr, readerDeployment, ssrDeployment, readerSubdomain, ssrSubdomain, domains] =
    await Promise.all(paths.map((path) => get(metadata, path)));
  assertParkedStage({
    reader, ssr, readerDeployment, ssrDeployment, readerSubdomain, ssrSubdomain, domains,
  });
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
  const [readerDeploy, ssrDeploy, reader, ssr, readerSubdomain, ssrSubdomain, domains] = await Promise.all([
    get(metadata, script(STAGE_READER) + "/deployments"),
    get(metadata, script(STAGE_SSR) + "/deployments"),
    get(metadata, script(STAGE_READER) + "/settings"),
    get(metadata, script(STAGE_SSR) + "/settings"),
    get(metadata, script(STAGE_READER) + "/subdomain"),
    get(metadata, script(STAGE_SSR) + "/subdomain"),
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
  assert.equal(ssrSubdomain?.enabled, true, "Authenticated benchmark SSR needs workers.dev");
  assert.equal(ssrSubdomain?.previews_enabled, false, "Staging previews must remain disabled");
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
    await stageParked(metadata);
  } else if (command === "stage") {
    await verifyStage(metadata);
  } else {
    await stageParked(metadata);
  }
  return {
    command,
    productionUnchanged: true,
    noCustomerStageDomain: true,
    stageParked: command !== "stage",
  };
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
