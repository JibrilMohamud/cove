import assert from "node:assert/strict";
import {
  latestSecretDeploymentStatus,
  waitForCloudflareStageDeployment,
} from "./cloudflare-deployment-readiness.mjs";

const started = Date.parse("2026-10-18T02:00:00.000Z");
const deployment = {
  created_on: "2026-10-18T02:00:03.000Z",
  annotations: { "workers/triggered_by": "secret" },
  versions: [{ version_id: "v-new", percentage: 100 }],
};
const payload = { success: true, result: { deployments: [deployment] } };
const status = (entry, rotationMs = started, nowMs = started + 34_000) =>
  latestSecretDeploymentStatus(
    { result: { deployments: [entry] } },
    rotationMs,
    nowMs,
  );

assert.equal(status(deployment, started, started + 10_000).state, "settling");
assert.equal(status(deployment).ready, true);
assert.equal(status(deployment, started + 8_000).ready, false);
assert.equal(
  latestSecretDeploymentStatus({ result: { deployments: [] } }, started, started).ready,
  false,
);
assert.equal(
  status({ ...deployment, versions: [{ percentage: 90 }] }).ready,
  false,
);
assert.equal(
  status({
    ...deployment,
    annotations: { "workers/triggered_by": "deployment" },
  }).ready,
  false,
);

let current = started + 5000;
let calls = 0;
await waitForCloudflareStageDeployment(
  "x".repeat(40),
  "d26430caa63ec55f6612e32f36aca5e9",
  started,
  {
    fetcher: async () => {
      calls++;
      return { ok: true, json: async () => payload };
    },
    now: () => current,
    sleep: async (ms) => {
      current += ms;
    },
    maxWaitMs: 60_000,
  },
);
assert.ok(calls >= 10, "Cold Worker is never fetched or prewarmed during control-plane wait");
console.log("PASS: fresh 100% stage version and deploy settle without Worker requests.");
