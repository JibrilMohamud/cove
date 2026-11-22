import assert from "node:assert/strict";
import { assertExactTokenPolicy } from "./phase-stage-control-plane.mjs";

export const QA_ACCOUNT = "d26430caa63ec55f6612e32f36aca5e9";
export const QA_DATABASE = "7c7ab994-f6b3-419d-a72d-71eb9ea22e7e";
export const QA_SCHEMA_SOURCE = "e4cbb0ef-6288-4fa1-9dbb-fb42fe01d4f3";
export const QA_BUCKET = "cove-paid-credential-isolation-qa";
export const QA_WORKERS = Object.freeze({
  owner: "cove-paid-isolated-owner",
  writer: "cove-paid-isolated-writer",
  caller: "cove-paid-isolated-caller",
  settlement: "cove-paid-isolated-settlement",
  fixture: "cove-paid-isolated-fixture",
});
export const QA_PARKED_VERSIONS = Object.freeze({
  [QA_WORKERS.owner]: "fe4918f6-76b2-4109-84c1-5880378eaea8",
  [QA_WORKERS.writer]: "b8280722-588d-49ea-a769-0688a5e5d6e3",
  [QA_WORKERS.caller]: "9799cf8a-dbba-49b2-bee6-51e63930c38c",
  [QA_WORKERS.settlement]: "a7d50dbf-4cad-4fd0-b51c-ae6c062fe44d",
  [QA_WORKERS.fixture]: "10f445d6-5276-4182-941d-c1ddbe306cdb",
});
export const QA_SCHEMA_SQL =
  "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE sql IS NOT NULL AND type IN ('table','index') ORDER BY CASE type WHEN 'table' THEN 0 ELSE 1 END,name";
const accountPath = `/accounts/${QA_ACCOUNT}`;
const base = accountPath + "/workers/scripts/";
const groups = {
  deploy: "e086da7e2179491d91ee5f35b3ca210a",
  schema: "192192df92ee43ac90f2aeeffce67e35",
  metadata: "da1261c3d38544a4bba805b22566f8b6",
  inventory: "eb56a6953c034b9d97dd838155666f06",
};
export function paidQaCredentials(env) {
  assert.equal(env.CLOUDFLARE_ACCOUNT_ID, QA_ACCOUNT);
  const keys = {
    deploy: "COVE_CF_STAGE_WORKERS_DEPLOY_TOKEN",
    schema: "COVE_CF_STAGE_D1_READ_TOKEN",
    metadata: "COVE_CF_WORKERS_METADATA_READ_TOKEN",
    inventory: "COVE_CF_ACCOUNT_TOKEN_INVENTORY_READ_TOKEN",
  };
  const credentials = Object.fromEntries(
    Object.entries(keys).map(([role, key]) => [role, env[key]]),
  );
  assert.ok(
    Object.values(credentials).every((value) => typeof value === "string" && value.length >= 20),
    "paid_qa_scoped_credentials_required",
  );
  assert.equal(new Set(Object.values(credentials)).size, 4, "paid_qa_credentials_must_be_distinct");
  return credentials;
}
export function paidQaRole(method, resource, body) {
  if (
    method === "POST" &&
    resource === `/d1/database/${QA_SCHEMA_SOURCE}/query` &&
    body?.sql === QA_SCHEMA_SQL &&
    Object.keys(body).length === 1
  )
    return "schema";
  const worker = Object.values(QA_WORKERS).find(
    (name) =>
      resource === "/workers/scripts/" + name ||
      resource.startsWith("/workers/scripts/" + name + "/"),
  );
  const suffix = worker && resource.slice(("/workers/scripts/" + worker).length);
  if (worker) {
    if (method === "GET" && ["/settings", "/deployments", "/subdomain"].includes(suffix))
      return "metadata";
    if (method === "GET" && /^\/versions\/[a-f0-9-]{36}$/.test(suffix)) return "deploy";
    if (method === "PUT" && suffix === "") return "deploy";
    if (method === "POST" && ["/subdomain", "/deployments"].includes(suffix)) return "deploy";
  }
  if (
    method === "GET" &&
    ["cove-persistence-backend", "cove-legal-authority-production"].some(
      (name) => resource === `/workers/scripts/${name}/deployments`,
    )
  )
    return "metadata";
  throw new Error("paid_qa_control_plane_operation_denied");
}
export function createPaidQaControlPlane(env, fetcher = fetch) {
  const credentials = paidQaCredentials(env);
  async function request(token, method, pathname, body) {
    const multipart = body instanceof FormData;
    const r = await fetcher("https://api.cloudflare.com/client/v4" + pathname, {
      method,
      redirect: "error",
      headers: {
        authorization: "Bearer " + token,
        ...(!multipart && body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: multipart ? body : JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(18000),
    });
    const j = await r.json().catch(() => null);
    if (!r.ok || j?.success !== true || !Object.hasOwn(j, "result"))
      throw new Error("paid_qa_control_plane_failed_" + r.status);
    return j.result;
  }
  return {
    api: (method, resource, body) =>
      request(
        credentials[paidQaRole(method, resource, body)],
        method,
        accountPath + resource,
        body,
      ),
    async preflight() {
      // Verify the actual secret identities, not names or an operator attestation.
      for (const [role, token] of Object.entries(credentials)) {
        const identity = await request(token, "GET", accountPath + "/tokens/verify");
        assert.match(identity?.id || "", /^[a-f0-9]{32}$/);
        const details = await request(
          credentials.inventory,
          "GET",
          accountPath + "/tokens/" + identity.id,
        );
        assert.equal(details.id, identity.id);
        assertExactTokenPolicy(details, groups[role]);
      }
      const parked = {};
      for (const name of Object.values(QA_WORKERS)) {
        const settings = await request(credentials.metadata, "GET", base + name + "/settings");
        assert.ok(
          (settings.bindings || []).some(
            (b) => b.type === "plain_text" && b.name === "COVE_PAID_QA_PARKED" && b.text === "1",
          ),
          "paid_qa_disabled_version_required",
        );
        const deployment = await request(credentials.metadata, "GET", base + name + "/deployments");
        const versions = deployment.deployments?.[0]?.versions;
        assert.equal(versions?.length, 1);
        assert.equal(versions[0].percentage, 100);
        assert.match(versions[0].version_id, /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/);
        assert.equal(
          versions[0].version_id,
          QA_PARKED_VERSIONS[name],
          "paid_qa_parked_version_drift",
        );
        parked[name] = versions[0].version_id;
        const d1 = (settings.bindings || []).filter((b) => b.type === "d1");
        assert.ok(
          d1.every((b) => (b.id || b.database_id) === QA_DATABASE),
          "paid_qa_unexpected_database",
        );
        const r2 = (settings.bindings || []).filter((b) => b.type === "r2_bucket");
        assert.ok(
          r2.every((b) => b.bucket_name === QA_BUCKET),
          "paid_qa_unexpected_bucket",
        );
        const ingress = await request(credentials.metadata, "GET", base + name + "/subdomain");
        assert.equal(ingress.enabled, false, "paid_qa_must_start_parked");
        assert.equal(ingress.previews_enabled, false);
      }
      return { verified: true, directD1WriteCredential: false, productionCertified: false, parked };
    },
  };
}

/** Never inherit the broad token or unrelated Stripe/read credentials into Wrangler. */
export function paidQaDeployEnvironment(env) {
  const credentials = paidQaCredentials(env);
  const clean = Object.fromEntries(
    Object.entries(env).filter(([key]) => !/TOKEN|SECRET|PASSWORD|API_KEY|ACCESS_KEY/i.test(key)),
  );
  return {
    ...clean,
    CLOUDFLARE_API_TOKEN: credentials.deploy,
    CLOUDFLARE_ACCOUNT_ID: QA_ACCOUNT,
    CLOUDFLARE_SEND_METRICS: "false",
  };
}
export function assertPaidQaConfig(config) {
  assert.ok(Object.values(QA_WORKERS).includes(config.name));
  assert.deepEqual(config.routes, []);
  assert.equal(config.preview_urls, false);
  assert.ok((config.d1_databases || []).every((db) => db.database_id === QA_DATABASE));
  assert.ok((config.r2_buckets || []).every((bucket) => bucket.bucket_name === QA_BUCKET));
  assert.ok(
    (config.services || []).every((service) => Object.values(QA_WORKERS).includes(service.service)),
  );
}
