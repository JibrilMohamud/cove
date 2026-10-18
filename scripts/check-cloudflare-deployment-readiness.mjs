import assert from "node:assert/strict";
import {
  latestSecretDeploymentStatus,
  waitForCloudflareStageDeployment,
} from "./cloudflare-deployment-readiness.mjs";

const started = Date.parse("2026-10-18T02:00:00.000Z");
const payload = {
  success: true,
  result: {
    deployments: [
      {
        created_on: "2026-10-18T02:00:03.000Z",
        annotations: { "workers/triggered_by": "secret" },
        versions: [{ version_id: "v-new", percentage: 100 }],
      },
    ],
  },
};
assert.equal(latestSecretDeploymentStatus(payload, started, started + 10_000).state, "settling");
assert.equal(latestSecretDeploymentStatus(payload, started, started + 34_000).ready, true);
assert.equal(latestSecretDeploymentStatus(payload, started + 8_000, started + 34_000).ready, false);
assert.equal(latestSecretDeploymentStatus({ result: { deployments: [] } }, started, started).ready, false);
assert.equal(
  latestSecretDeploymentStatus({
    ...payload,
    result: { deployments: [{ ...payload.result.deployments[0], versions: [{ percentage: 90 }] }] },
  }, started, started + 34_000).ready,
  false,
);
assert.equal(
  latestSecretDeploymentStatus({
    ...payload,
    result: {
      deployments: [
        { ...payload.result.deployments[0], annotations: { "workers/triggered_by": "deployment" } },
      ],
    },
  }, started, started + 34_000).ready,
  false,
);
let current = started + 5000;
let calls = 0;
await waitForCloudflareStageDeployment("x".repeat(40), "d26430caa63ec55f6612e32f36aca5e9", started, {
  fetcher: async () => {
    calls++;
    return { ok: true, json: async () => payload };
  },
  now: () => current,
  sleep: async (ms) => { current += ms; },
  maxWaitMs: 60_000,
});
assert.ok(calls >= 10, "Cold Worker is never fetched or prewarmed during control-plane wait");
console.log("PASS: 100% stage version, fresh secret, and deploy settle without Worker requests.");
