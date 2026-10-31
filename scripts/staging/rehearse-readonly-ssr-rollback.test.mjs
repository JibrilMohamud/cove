import assert from "node:assert/strict";
import test from "node:test";
import {
  assertProtectedReadonlyStage,
  rehearseReadonlyRollback,
  verifyRestoration,
} from "./rehearse-readonly-ssr-rollback.mjs";

const version = "f2b79a9d-bf65-4bd7-b0f8-8c97f5b9533f";
const good = () => ({
  bindings: [
    { name: "COVE_SSR_STAGING", type: "plain_text", text: "1" },
    { name: "COVE_CANONICAL_READONLY_RPC", type: "plain_text", text: "1" },
    { name: "COVE_SSR_STAGING_GATE_KEY", type: "secret_text" },
    { name: "COVE_CANONICAL_READONLY", type: "service", service: "cove-canonical-d1-readonly" },
  ],
});
const deployment = { deployments: [{ versions: [{ version_id: version, percentage: 100 }] }] };

test("reject native D1, disabled auth, fallback, missing read service and split versions before mutation", () => {
  assert.equal(assertProtectedReadonlyStage(good(), deployment), version);
  for (const change of [
    (s) => s.bindings.push({ name: "DB", type: "d1" }),
    (s) => {
      s.bindings[0].text = "0";
    },
    (s) => s.bindings.push({ name: "FORE_BACKEND_TOKEN", type: "secret_text" }),
    (s) => {
      s.bindings[3].service = "another-owner";
    },
  ]) {
    const s = good();
    change(s);
    assert.throws(() => assertProtectedReadonlyStage(s, deployment));
  }
  assert.throws(() => assertProtectedReadonlyStage(good(), { deployments: [{ versions: [] }] }));
});

for (const failure of ["none", "lost-patch-ack", "stale-shelf", "probe-timeout"]) {
  test(`restore pinned version after ${failure}`, async () => {
    let outage = false;
    let restores = 0;
    const api = async (method, path, body) => {
      if (method === "PATCH") {
        assert.ok(body.bindings.every((b) => b.type === "inherit"));
        assert.ok(!body.bindings.some((b) => b.name === "COVE_CANONICAL_READONLY"));
        outage = true;
        if (failure === "lost-patch-ack") throw Error("lost acknowledgement");
        return {};
      }
      if (method === "POST") {
        assert.deepEqual(body.versions, [{ version_id: version, percentage: 100 }]);
        restores++;
        outage = false;
        return {};
      }
      if (path.includes("/versions/")) {
        const s = good();
        if (outage) s.bindings.pop();
        return { id: version, resources: s };
      }
      if (path.endsWith("/deployments")) return deployment;
      return [];
    };
    const probe = async (authenticated) => {
      if (!authenticated) return { status: 401, cards: 0, noStore: true };
      if (outage && failure === "probe-timeout") throw Error("timeout");
      return {
        status: 200,
        cards: outage ? (failure === "stale-shelf" ? 24 : 0) : 24,
        noStore: true,
      };
    };
    const record = {};
    if (failure === "none") await rehearseReadonlyRollback(api, probe, record);
    else await assert.rejects(() => rehearseReadonlyRollback(api, probe, record));
    assert.equal(restores, 1);
    assert.equal(record.restored, true);
    assert.equal(outage, false);
  });
}

test("refuse route-attached staging before mutation", async () => {
  let mutated = false;
  const api = async (method, path) => {
    if (method !== "GET") mutated = true;
    if (path.includes("/versions/")) return { id: version, resources: good() };
    if (path.endsWith("/deployments")) return deployment;
    if (path.endsWith("/routes")) return [{ script: "cove-storefront-ssr-staging" }];
    return [];
  };
  await assert.rejects(() => rehearseReadonlyRollback(api, () => assert.fail(), {}));
  assert.equal(mutated, false);
});

test("restoration reads active version and never trusts latest-upload settings", async () => {
  const api = async (method, path) => {
    assert.equal(method, "GET");
    assert.ok(!path.endsWith("/settings"));
    if (path.endsWith("/deployments")) return deployment;
    if (path.endsWith("/versions/" + version)) return { id: version, resources: good() };
    assert.fail("Unexpected control-plane operation");
  };
  const record = { baselineVersion: version };
  await verifyRestoration(
    api,
    async (auth) => ({ status: auth ? 200 : 401, cards: auth ? 24 : 0, noStore: true }),
    record,
  );
  assert.equal(record.restored, true);
});
