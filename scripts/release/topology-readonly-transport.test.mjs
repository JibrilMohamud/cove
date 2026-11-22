import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { ACCOUNT, ZONE, createTopologyReader } from "./topology-readonly-transport.mjs";

const metadata = "metadata-read-fixture-credential";
const routing = "routing-read-fixture-credential";
const env = {
  CLOUDFLARE_ACCOUNT_ID: ACCOUNT,
  CLOUDFLARE_ZONE_ID: ZONE,
  COVE_CF_WORKERS_METADATA_READ_TOKEN: metadata,
  COVE_CF_WORKERS_TOPOLOGY_READ_TOKEN: routing,
};
const root = `/accounts/${ACCOUNT}/workers/`;
const ok = (result = {}) => ({
  status: 200,
  json: async () => ({ success: true, errors: [], result }),
});

test("five exact GETs select independent metadata and routing credentials", async () => {
  const calls = [];
  const get = createTopologyReader(env, async (url, init) => {
    assert.equal(init.method, "GET");
    assert.equal(init.redirect, "error");
    assert.equal(init.body, undefined);
    calls.push([url, init.headers.authorization]);
    return ok();
  });
  for (const name of ["cove", "cove-persistence-backend", "cove-legal-authority-production"])
    await get(root + "scripts/" + name + "/settings");
  await get(root + "domains");
  await get(`/zones/${ZONE}/workers/routes`);
  assert.deepEqual(
    calls.map(([, auth]) => auth),
    [metadata, metadata, metadata, routing, routing].map((v) => "Bearer " + v),
  );
  assert.ok(calls.every(([url]) => url.startsWith("https://api.cloudflare.com/client/v4/")));
  await assert.rejects(get(root + "domains"), /topology_read_budget_exhausted/);
  assert.equal(calls.length, 5);
});

test("broad-token fallback, missing/same readers and wrong resources cannot initiate requests", () => {
  for (const patch of [
    { COVE_CF_WORKERS_METADATA_READ_TOKEN: undefined },
    { COVE_CF_WORKERS_TOPOLOGY_READ_TOKEN: undefined },
    { COVE_CF_WORKERS_TOPOLOGY_READ_TOKEN: metadata },
    { CLOUDFLARE_ACCOUNT_ID: "a".repeat(32) },
    { CLOUDFLARE_ZONE_ID: "b".repeat(32) },
  ]) {
    let calls = 0;
    assert.throws(
      () =>
        createTopologyReader(
          { ...env, ...patch, CLOUDFLARE_API_TOKEN: "broad-token-should-never-work" },
          () => calls++,
        ),
      /topology_independent_read_credentials_required/,
    );
    assert.equal(calls, 0);
  }
});

test("no D1, token, upload, other Worker, query or external path can receive credentials", async () => {
  let calls = 0;
  const get = createTopologyReader(env, async () => {
    calls++;
    return ok();
  });
  for (const path of [
    `/accounts/${ACCOUNT}/d1/database/production/query`,
    `/accounts/${ACCOUNT}/tokens`,
    root + "scripts/cove-persistence-backend",
    root + "scripts/cove-persistence-backend/versions",
    root + "scripts/other-worker/settings",
    root + "domains?anything=1",
    "https://other.example/settings",
    `/zones/${ZONE}/workers/routes/123`,
  ])
    await assert.rejects(get(path), /topology_read_endpoint_denied/);
  await assert.rejects(
    get(root + "domains", { optional: true }),
    /topology_optional_endpoint_denied/,
  );
  assert.equal(calls, 0);
});

test("only absent optional frontend is accepted; missing authority or malformed evidence denies", async () => {
  const get = createTopologyReader(env, async () => ({ status: 404 }));
  assert.equal(await get(root + "scripts/cove/settings", { optional: true }), null);
  await assert.rejects(
    get(root + "scripts/cove-legal-authority-production/settings"),
    /topology_read_http_failure/,
  );
  for (const response of [
    { status: 403 },
    {
      status: 200,
      json: async () => {
        throw Error("PRIVATE_PROVIDER_BODY");
      },
    },
    ok(null),
    { status: 200, json: async () => ({ success: true, result: [] }) },
    {
      status: 200,
      json: async () => ({ success: true, errors: ["PRIVATE_PROVIDER_BODY"], result: [] }),
    },
  ]) {
    const read = createTopologyReader(env, async () => response);
    await assert.rejects(read(root + "domains"), (error) => {
      assert.match(error.message, /^topology_read_/);
      assert.doesNotMatch(error.message, /PRIVATE|Bearer|fixture/);
      return true;
    });
  }
  await assert.rejects(
    createTopologyReader(env, async () => {
      throw Error("PRIVATE_PROVIDER_BODY");
    })(root + "domains"),
    /^Error: topology_read_transport_unavailable$/,
  );
});

test("audit is protected manual-only and both callers supply scoped readers", () => {
  const flow = readFileSync(".github/workflows/production-cutover-topology-audit.yml", "utf8");
  for (const required of [
    "github.repository == 'JibrilMohamud/cove'",
    "github.event_name == 'workflow_dispatch'",
    "github.ref == 'refs/heads/main'",
    "inputs.confirm_readonly_topology_audit == true",
    "inputs.reviewed_main_sha == github.sha",
    "environment: cove-production-release-audit",
    "persist-credentials: false",
  ])
    assert.ok(flow.includes(required), required);
  assert.doesNotMatch(flow, /secrets\.CLOUDFLARE_API_TOKEN/);
  for (const path of [
    ".github/workflows/production-cutover-topology-audit.yml",
    ".github/workflows/production-legal-owner-locked.yml",
  ]) {
    const source = readFileSync(path, "utf8");
    for (const key of [
      "COVE_CF_WORKERS_METADATA_READ_TOKEN",
      "COVE_CF_WORKERS_TOPOLOGY_READ_TOKEN",
    ])
      assert.ok(source.includes("secrets." + key), path + ": " + key);
  }
  const deploy = readFileSync(".github/workflows/production-legal-owner-locked.yml", "utf8");
  assert.ok(
    deploy.indexOf("topologyReadCredentials(process.env)") <
      deploy.indexOf("-- wrangler deploy --config"),
  );
  const script = readFileSync("scripts/check-live-production-cutover.mjs", "utf8");
  assert.doesNotMatch(script, /process\.env\.CLOUDFLARE_API_TOKEN/);
  assert.match(script, /createTopologyReader\(process\.env\)/);
});
