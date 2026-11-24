import assert from "node:assert/strict";
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

export async function verifyProductionBioSyncCredentials(env, transport = fetch) {
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

  async function request(path, token, body) {
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
    if (!response.ok) fail("provider_http_" + response.status);
    const data = await response.json();
    if (data?.success !== true) fail("provider_rejected");
    return data;
  }

  const [d1Identity, r2Identity, inventory] = await Promise.all([
    request("/tokens/verify", d1),
    request("/tokens/verify", r2),
    request("/tokens?per_page=50&page=1", audit),
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
  const r2Id = r2Identity.result?.id;
  if (
    !/^[a-f0-9]{32}$/.test(d1Id || "") ||
    !/^[a-f0-9]{32}$/.test(r2Id || "") ||
    d1Id === r2Id ||
    d1Identity.result?.status !== "active" ||
    r2Identity.result?.status !== "active"
  )
    fail("token_identity");
  exactPermission(rows.find((x) => x.id === d1Id), "D1 Read", accountScope);
  exactPermission(rows.find((x) => x.id === r2Id), "Workers R2 Storage Bucket Item Write", r2Scope);

  const [read, list] = await Promise.all([
    request("/d1/database/" + primary + "/query", d1, {
      sql: "SELECT 1 AS ok",
      params: [],
    }),
    request("/r2/buckets/" + bucket + "/objects?prefix=biosync%2Ftext%2F&per_page=1", r2),
  ]);
  if (
    read.result?.length !== 1 ||
    read.result[0]?.success !== true ||
    read.result[0]?.results?.length !== 1 ||
    read.result[0]?.results[0]?.ok !== 1
  )
    fail("d1_read");
  if (!Array.isArray(list.result) && !Array.isArray(list.result?.objects)) fail("r2_list");
  return {
    schema: "cove.production-biosync-credential-preflight.v1",
    exactD1ReadScope: true,
    exactR2BucketScope: true,
    realD1Read: true,
    realR2List: true,
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
