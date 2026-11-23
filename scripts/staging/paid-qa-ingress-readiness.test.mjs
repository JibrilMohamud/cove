import assert from "node:assert/strict";
import test from "node:test";
import {
  PAID_QA_READ_PROBES,
  stabilizePrivatePaidQaIngress,
} from "./paid-qa-ingress-readiness.mjs";

const nativeInput = {
  ids: ["prd_paid_qa_20261027"],
  territory: "US",
  currency: "USD",
};
const responseFor = (route, patch = {}) => ({
  status: 200,
  ingressColo: "IAD",
  bindingHeadersMs: 12,
  ownerRouteMs: 7,
  body: {
    schema: PAID_QA_READ_PROBES.find((x) => x.route === route).schema,
    ...(route === "/qa/native-first-paint" ? { rows: [{ product_id: nativeInput.ids[0] }] } : {}),
  },
  ...patch,
});
function probeHarness(change = () => null) {
  let calls = 0;
  let sleeps = 0;
  const routes = new Set();
  return {
    get calls() {
      return calls;
    },
    get sleeps() {
      return sleeps;
    },
    get routes() {
      return routes;
    },
    async probe(route, body) {
      calls++;
      routes.add(route);
      if (route === "/qa/native-first-paint")
        assert.deepEqual(body, nativeInput);
      else assert.deepEqual(body, {});
      return change({ route, calls, wave: Math.ceil(calls / 96) }) ?? responseFor(route);
    },
    async sleep(ms) {
      assert.equal(ms, 3000);
      sleeps++;
    },
  };
}

test("requires two consecutive complete 32-way valid waves on three fixed private read routes", async () => {
  const harness = probeHarness(({ route, wave }) => {
    if (wave === 1 && route === "/qa/transport-owner-ping")
      return responseFor(route, { status: 404, ingressColo: null, body: null });
    return null;
  });
  const result = await stabilizePrivatePaidQaIngress({
    ...harness,
    nativeInput,
  });
  assert.deepEqual(result, { globallyReady: true, completeWaves: 3, edge404: 32 });
  assert.equal(harness.calls, 3 * 3 * 32);
  assert.equal(harness.sleeps, 2);
  assert.deepEqual([...harness.routes].sort(), PAID_QA_READ_PROBES.map((x) => x.route).sort());
});

test("even a single intermittent edge 404 prevents success and fails at hard bound", async () => {
  const harness = probeHarness(({ route, calls }) => {
    if (route === "/qa/transport-caller-ping" && calls % 96 === 1)
      return responseFor(route, { status: 404, ingressColo: null, body: null });
    return null;
  });
  await assert.rejects(
    stabilizePrivatePaidQaIngress({ ...harness, nativeInput }),
    /paid_qa_ingress_edge_404_unstable/,
  );
  assert.equal(harness.calls, 12 * 3 * 32);
  assert.equal(harness.sleeps, 11);
});

test("unknown application failures, forged 200s and native-rights denial cannot be retried as propagation", async () => {
  const cases = [
    (route) => responseFor(route, { status: 503 }),
    (route) => responseFor(route, { status: 404, ingressColo: "IAD" }),
    (route) => responseFor(route, { body: { schema: "wrong" } }),
    (route) => responseFor(route, { ingressColo: null }),
    (route) => responseFor(route, { body: null }),
  ];
  for (const fail of cases) {
    const harness = probeHarness(({ route }) => fail(route));
    await assert.rejects(
      stabilizePrivatePaidQaIngress({ ...harness, nativeInput }),
      /paid_qa_ingress_probe_contract_denied/,
    );
    assert.equal(harness.sleeps, 0);
  }
  const owner = probeHarness(({ route }) =>
    route === "/qa/transport-owner-ping"
      ? responseFor(route, { ownerRouteMs: null })
      : null,
  );
  await assert.rejects(
    stabilizePrivatePaidQaIngress({ ...owner, nativeInput }),
    /paid_qa_ingress_probe_contract_denied/,
  );
  const rights = probeHarness(({ route }) =>
    route === "/qa/native-first-paint"
      ? responseFor(route, {
          body: { schema: "cove.qa.owner-native-first-paint.v1", rows: [] },
        })
      : null,
  );
  await assert.rejects(
    stabilizePrivatePaidQaIngress({ ...rights, nativeInput }),
    /paid_qa_ingress_probe_contract_denied/,
  );
});

test("rejects weakened concurrency, rounds, scope and untrusted probe configurations before calling network", async () => {
  const modifications = [
    { parallel: 16 },
    { rounds: 99 },
    { stableWaves: 1 },
    { nativeInput: { ...nativeInput, territory: "CA" } },
    { nativeInput: { ...nativeInput, ids: [] } },
  ];
  for (const overrides of modifications) {
    const harness = probeHarness();
    await assert.rejects(
      stabilizePrivatePaidQaIngress({ ...harness, nativeInput, ...overrides }),
      /paid_qa_ingress_unsafe_configuration/,
    );
    assert.equal(harness.calls, 0);
  }
});
