import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertPinnedProductionDeployment,
  assertBaselineResources,
  assertExactNonsecretResourceParity,
  detectExactlyOneArchivedCandidate,
  PINNED_DEPLOYMENT,
  PINNED_VERSION,
} from "./zero-traffic-worker-version-fence.mjs";

function baseline() {
  const resources = {
    script_runtime: {
      compatibility_date: "2026-09-01",
      usage_model: "standard",
      limits: { cpu_ms: 300000 },
    },
    bindings: [
      { type: "d1", name: "DB", database_id: "4bd657ac-8789-403e-a28c-93aba8d0a989" },
      {
        type: "durable_object_namespace",
        name: "LEGAL_AUTHORITY",
        script_name: "cove-legal-authority-production",
      },
      { type: "analytics_engine", name: "OPS_ANALYTICS", dataset: "cove_public_http_ops" },
      { type: "plain_text", name: "FORE_ENVIRONMENT", text: "production" },
      { type: "secret_text", name: "FORE_BACKEND_TOKEN_SHA256" },
    ],
  };
  for (let n = 0; n < 25; n++) {
    resources.bindings.push({ type: "plain_text", name: "SAFE_TEST_" + n, text: "value-" + n });
  }
  return { number: 451, resources };
}

const copy = (data) => structuredClone(data);
function candidateFrom(old) {
  return { ...copy(old), number: 454 };
}
const deployment = () => ({
  deployments: [
    {
      id: PINNED_DEPLOYMENT,
      versions: [{ version_id: PINNED_VERSION, percentage: 100 }],
    },
  ],
});

test("exact production Worker must remain 451 at 100% without a new deployment", () => {
  assert.equal(assertPinnedProductionDeployment(deployment()).percentage, 100);
  const altered = copy(deployment());
  altered.deployments[0].versions[0].percentage = 99;
  assert.throws(() => assertPinnedProductionDeployment(altered), /100%/);
  altered.deployments[0].versions.push({ version_id: "unreviewed", percentage: 1 });
  assert.throws(() => assertPinnedProductionDeployment(altered), /traffic split/);
  altered.deployments[0].versions = [{ version_id: PINNED_VERSION, percentage: 100 }];
  altered.deployments[0].id = "unapproved";
  assert.throws(() => assertPinnedProductionDeployment(altered), /deployment changed/);
});

test("full 30-binding baseline is required, and identical archived version may pass", () => {
  const old = baseline();
  assert.equal(assertBaselineResources(old), 30);
  assert.deepEqual(assertExactNonsecretResourceParity(old, candidateFrom(old)), {
    bindingCount: 30,
    runtimeMatches: true,
    bindingsMatch: true,
  });
});

test("modified D1, owner binding, AE dataset, plain text or runtime settings deny upload", () => {
  const old = baseline();
  for (const change of [
    (b) => (b.resources.bindings[0].database_id = "different"),
    (b) => (b.resources.bindings[1].script_name = "not-owner"),
    (b) => (b.resources.bindings[2].dataset = "different"),
    (b) => (b.resources.bindings[3].text = "staging"),
    (b) => (b.resources.script_runtime.limits.cpu_ms = 5000),
    (b) => b.resources.bindings.pop(),
    (b) => b.resources.bindings.push({ type: "secret_text", name: "UNREVIEWED_SECRET" }),
  ]) {
    const mutated = candidateFrom(old);
    change(mutated);
    assert.throws(() => assertExactNonsecretResourceParity(old, mutated));
  }
});

test("secret values never appear in source parity checks or error messages", () => {
  const old = baseline();
  old.resources.bindings[4].text = "SENTINEL_NEVER_LOG";
  const candidate = candidateFrom(old);
  candidate.resources.bindings[3].text = "different";
  let message = "";
  try {
    assertExactNonsecretResourceParity(old, candidate);
  } catch (error) {
    message = String(error);
  }
  assert.ok(message.includes("manifest changed"));
  assert.ok(!message.includes("SENTINEL_NEVER_LOG"));
});

test("exactly one new archived candidate; duplicate or concurrent changes fail closed", () => {
  assert.equal(
    detectExactlyOneArchivedCandidate(
      ["a", "b"],
      [
        { id: "a", number: 451 },
        { id: "candidate-abcdef", number: 454 },
      ],
    ).number,
    454,
  );
  assert.throws(() => detectExactlyOneArchivedCandidate(["a"], [{ id: "a", number: 451 }]));
  assert.throws(() =>
    detectExactlyOneArchivedCandidate(
      ["a"],
      [
        { id: "new-candidate-1", number: 454 },
        { id: "new-candidate-2", number: 455 },
      ],
    ),
  );
  assert.throws(() => detectExactlyOneArchivedCandidate(["a", "a"], []));
});
