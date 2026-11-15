import test from "node:test";
import assert from "node:assert/strict";
import { singleCandidateVersion, attestedCandidateSettings } from "./candidate-deployment-verification.mjs";

const stageVersion = "e7c0563d-0681-437c-9add-4f25a1ca3428";
const pinnedVersion = "60d1924f-2917-42be-acf7-496e84cb55e7";
const deployments = (version, percentage = 100) => ({
  deployments: [{ versions: [{ version_id: version, percentage }] }],
});
const settings = {
  limits: { cpu_ms: 300000 },
  bindings: [
    { name: "DB", type: "d1", database_id: "e4cbb0ef-6288-4fa1-9dbb-fb42fe01d4f3" },
    { name: "COVE_SYNTHETIC_STAGING_ONLY", type: "plain_text" },
  ],
};

test("readback verifies exactly one deployed 100% version", () => {
  assert.equal(singleCandidateVersion(deployments(stageVersion)), stageVersion);
  assert.throws(() => singleCandidateVersion(deployments(stageVersion, 99)), /100-percent/);
  assert.throws(() => singleCandidateVersion({ deployments: [{ versions: [] }] }), /100-percent/);
  assert.throws(
    () =>
      singleCandidateVersion({
        deployments: [
          { versions: [
            { version_id: stageVersion, percentage: 50 },
            { version_id: pinnedVersion, percentage: 50 },
          ] },
        ],
      }),
    /100-percent/,
  );
  assert.throws(() => singleCandidateVersion(deployments("invalid")), /100-percent/);
});

test("version 404 fallback requires same active deployment on both sides of settings read", () => {
  const attested = attestedCandidateSettings(
    deployments(stageVersion),
    deployments(stageVersion),
    settings,
  );
  assert.equal(attested.version, stageVersion);
  assert.deepEqual(attested.bindings, settings.bindings);
  assert.equal(attested.runtime.limits.cpu_ms, 300000);
  assert.throws(
    () => attestedCandidateSettings(deployments(stageVersion), deployments(pinnedVersion), settings),
    /changed/,
  );
  assert.throws(
    () => attestedCandidateSettings(deployments(stageVersion), deployments(stageVersion), {}),
    /verified/,
  );
  assert.throws(
    () =>
      attestedCandidateSettings(deployments(stageVersion), deployments(stageVersion), {
        ...settings,
        limits: {},
      }),
    /verified/,
  );
  assert.throws(
    () =>
      attestedCandidateSettings(deployments(stageVersion), deployments(stageVersion), {
        ...settings,
        bindings: [{ name: null }],
      }),
    /verified/,
  );
});
