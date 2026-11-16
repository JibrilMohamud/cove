import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const SCRIPT = "scripts/release/protected-zero-traffic-worker-upload.mjs";
const DEPLOYMENT = "9df84b20-0599-4fe9-a14e-2c11a4f25133";
const VERSION = "401f2af2-6e69-4611-8110-1d127af6eecf";
const MOCK_UPLOAD_TOKEN = "synthetic-upload-token-for-offline-unit";
const MOCK_READER_TOKEN = "synthetic-metadata-reader-for-offline-unit";

function simulate(mode, { reader = "", wrongDeployment = false } = {}) {
  const fakeCloudflare = `
    globalThis.fetch = async (url, opts) => {
      if (opts.method !== "GET") throw new Error("Unexpected Cloudflare mutation");
      if (String(url).endsWith("/deployments")) {
        return {
          ok: true,
          json: async () => ({
            success: true,
            result: {
              deployments: [{
                id: ${JSON.stringify(wrongDeployment ? "not-the-pinned-deployment" : DEPLOYMENT)},
                versions: [{ version_id: ${JSON.stringify(VERSION)}, percentage: 100 }]
              }]
            }
          })
        };
      }
      if (String(url).endsWith("/cove-legal-authority-production/settings")) {
        if (opts.headers.authorization !== "Bearer " + ${JSON.stringify(MOCK_READER_TOKEN)})
          throw new Error("Wrong legal-owner credential used");
        return {
          ok: true,
          json: async () => ({
            success: true,
            result: {
              bindings: [
                { name: "COVE_RIGHTS_OWNER_ENABLED", type: "plain_text", text: "0" }
              ]
            }
          })
        };
      }
      throw new Error("Unexpected Cloudflare read");
    };
  `;
  const env = {
    ...process.env,
    GITHUB_REPOSITORY: "JibrilMohamud/cove",
    GITHUB_EVENT_NAME: "workflow_dispatch",
    GITHUB_REF: "refs/heads/main",
    CLOUDFLARE_ACCOUNT_ID: "d26430caa63ec55f6612e32f36aca5e9",
    COVE_APPROVED_DIAGNOSTIC_SOURCE: "a3fd303da6f7418ceec574e0c158d62fe1245984",
    GITHUB_RUN_ID: "43968076074",
    CLOUDFLARE_API_TOKEN: MOCK_UPLOAD_TOKEN,
    COVE_CF_WORKERS_METADATA_READ_TOKEN: reader,
  };
  return spawnSync(
    process.execPath,
    [
      "--import",
      "data:text/javascript;base64," + Buffer.from(fakeCloudflare).toString("base64"),
      SCRIPT,
      mode,
    ],
    { encoding: "utf8", timeout: 5000, env },
  );
}

test("missing metadata reader fails before any protected upload preflight", () => {
  const r = simulate("preflight");
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /Protected legal-owner metadata read-only credential absent/);
  assert.doesNotMatch(r.stdout, /cove_zero_traffic_worker_upload_preflight/);
});

test("unconditional fence still proves the pinned 451 is 100% before failing missing owner read", () => {
  const r = simulate("fence");
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /Protected legal-owner metadata read-only credential absent/);
  const records = r.stdout
    .split("\n")
    .filter(Boolean)
    .map((row) => JSON.parse(row));
  assert.equal(records.length, 1);
  assert.deepEqual(records[0], {
    event: "cove_worker_100pct_pin_independently_verified",
    deploymentId: DEPLOYMENT,
    versionId: VERSION,
    percent: 100,
    rightsOwnerVerified: false,
    releaseCertified: false,
  });
  assert.doesNotMatch(r.stdout + r.stderr, /synthetic-upload-token|synthetic-metadata-reader/);
});

test("bad Worker deployment is rejected even if metadata reader is missing", () => {
  const r = simulate("fence", { wrongDeployment: true });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /Production deployment changed: STOP/);
  assert.doesNotMatch(r.stdout, /cove_worker_100pct_pin_independently_verified/);
});

test("complete fence succeeds only with independent positive owner-disabled proof", () => {
  const r = simulate("fence", { reader: MOCK_READER_TOKEN });
  assert.equal(r.status, 0, r.stderr.slice(0, 500));
  const records = r.stdout
    .split("\n")
    .filter(Boolean)
    .map((row) => JSON.parse(row));
  assert.deepEqual(
    records.map((row) => row.event),
    ["cove_worker_100pct_pin_independently_verified", "cove_unconditional_zero_traffic_release_fence"],
  );
  assert.equal(records[1].customerPercent, 100);
  assert.equal(records[1].rightsOwnerStillDisabled, true);
  assert.equal(records[1].releaseCertified, false);
});
