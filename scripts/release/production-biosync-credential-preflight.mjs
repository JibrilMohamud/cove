import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const account = "d26430caa63ec55f6612e32f36aca5e9";
const primary = "4bd657ac-8789-403e-a28c-93aba8d0a989";
const bucket = "cove-production-media";
const root = "https://api.cloudflare.com/client/v4/accounts/" + account;
const accountScope = "com.cloudflare.api.account." + account;
const r2Scope = "com.cloudflare.edge.r2.bucket." + account + "_default_" + bucket;
const fail = (code) => {
  throw Error("biosync_preflight_" + code);
};

function exactPermission(token, group, resource) {
  const policies = token?.policies;
  if (token?.status !== "active" || !Array.isArray(policies) || policies.length !== 1)
    fail("token_status_or_policy_count");
  const p = policies[0];
  if (
    p.effect !== "allow" ||
    p.permission_groups?.length !== 1 ||
    p.permission_groups[0].name !== group ||
    Object.keys(p.resources || {}).length !== 1 ||
    p.resources[resource] !== "*"
  )
    fail("token_scope");
}

const r2Id = "8b44b8edebf071ba96ee47e9b34e95bc";
const d1ExpectedId = "ba59697e28231d3ee460f382aff95454";

function probeScopedR2(env) {
  try {
    const result = execFileSync(
      "python3",
      ["-m", "scripts.audio_pipeline.biosync_production_owner_transport"],
      {
        env: {
          PATH: env.PATH,
          HOME: env.HOME,
          COVE_BIOSYNC_PROD_OWNER_MODE: "1",
          COVE_BIOSYNC_PROD_D1_READ_TOKEN: env.COVE_BIOSYNC_PROD_D1_READ_TOKEN,
          COVE_BIOSYNC_PROD_R2_TOKEN: env.COVE_BIOSYNC_PROD_R2_TOKEN,
          COVE_BIOSYNC_PROD_CLIENT_SECRET: env.COVE_BIOSYNC_PROD_CLIENT_SECRET,
        },
        encoding: "utf8",
        timeout: 140000,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    return result.trim() === "cove_biosync_scoped_s3_read_verified";
  } catch {
    fail("r2_s3_read_failed");
  }
}

export async function verifyProductionBioSyncCredentials(
  env,
  transport = fetch,
  probeR2 = probeScopedR2,
) {
  const d1 = env.COVE_BIOSYNC_PROD_D1_READ_TOKEN;
  const r2 = env.COVE_BIOSYNC_PROD_R2_TOKEN;
  const client = env.COVE_BIOSYNC_PROD_CLIENT_SECRET;
  const audit = env.COVE_CF_ACCOUNT_TOKEN_INVENTORY_READ_TOKEN;
  if (
    [d1, r2, client, audit].some((x) => typeof x !== "string" || x.length < 20) ||
    new Set([d1, r2, client, audit]).size !== 4 ||
    !/^[a-f0-9]{64}$/.test(client) ||
    env.CLOUDFLARE_API_TOKEN
  )
    fail("credentials_missing_reused_or_invalid");

  async function request(operation, path, token, body) {
    const response = await transport(root + path, {
      method: body ? "POST" : "GET",
      headers: {
        authorization: "Bearer " + token,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      redirect: "error",
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) fail(operation + "_http_" + response.status);
    const data = await response.json();
    if (data?.success !== true) fail(operation + "_provider_rejected");
    return data;
  }

  const [d1Identity, inventory] = await Promise.all([
    request("d1_identity", "/tokens/verify", d1),
    request("token_inventory", "/tokens?per_page=50&page=1", audit),
  ]);
  const rows = inventory.result;
  const info = inventory.result_info;
  if (
    !Array.isArray(rows) ||
    !info ||
    info.page !== 1 ||
    info.total_pages !== 1 ||
    info.count !== rows.length ||
    info.total_count !== rows.length ||
    new Set(rows.map((x) => x.id)).size !== rows.length
  )
    fail("inventory_incomplete");
  const d1Id = d1Identity.result?.id;
  if (d1Id !== d1ExpectedId || d1Identity.result?.status !== "active") fail("token_identity");
  exactPermission(
    rows.find((x) => x.id === d1Id),
    "D1 Read",
    accountScope,
  );
  exactPermission(
    rows.find((x) => x.id === r2Id),
    "Workers R2 Storage Bucket Item Write",
    r2Scope,
  );

  const read = await request("d1_query", "/d1/database/" + primary + "/query", d1, {
    sql: "SELECT 1 AS ok",
    params: [],
  });
  if (
    read.result?.length !== 1 ||
    read.result[0]?.success !== true ||
    read.result[0]?.results?.length !== 1 ||
    read.result[0]?.results[0]?.ok !== 1
  )
    fail("d1_read");
  if (!(await probeR2(env))) fail("r2_s3_read_failed");
  return {
    schema: "cove.production-biosync-credential-preflight.v1",
    exactD1ReadScope: true,
    exactR2BucketScope: true,
    realD1Read: true,
    realR2List: true,
    r2Authentication: "s3-sigv4-exact-bucket",
    independentClientSecretShape: true,
    providerMutationAttempted: false,
    ownerPublicationProven: false,
    releaseCertified: false,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    assert.equal(process.env.GITHUB_REPOSITORY, "JibrilMohamud/cove");
    assert.equal(process.env.GITHUB_REF, "refs/heads/main");
    assert.ok(["push", "workflow_dispatch"].includes(process.env.GITHUB_EVENT_NAME));
    assert.match(process.env.GITHUB_SHA || "", /^[a-f0-9]{40}$/);
    const report = await verifyProductionBioSyncCredentials(process.env);
    console.log(JSON.stringify(report));
  } catch (error) {
    const reason = String(error?.message || "");
    console.error(
      /^biosync_preflight_[a-z0-9_]+$/.test(reason) ? reason : "biosync_preflight_closed",
    );
    process.exitCode = 1;
  }
}
