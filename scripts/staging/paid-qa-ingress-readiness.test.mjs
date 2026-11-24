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
      if (route === "/qa/native-first-paint") assert.deepEqual(body, nativeInput);
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
  assert.deepEqual(result, { globallyReady: true, completeWaves: 3, edge404: 32, edge500: 0 });
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
    /paid_qa_ingress_readonly_unstable:edge404=12:edge500=0/,
  );
  assert.equal(harness.calls, 12 * 3 * 32);
  assert.equal(harness.sleeps, 11);
});

test("only an unmarked 500 on the read-only caller ping can delay readiness without passing an unsafe wave", async () => {
  const harness = probeHarness(({ route, wave }) => {
    if (wave === 1 && route === "/qa/transport-caller-ping")
      return responseFor(route, {
        status: 500,
        ingressColo: null,
        bindingHeadersMs: null,
        ownerRouteMs: null,
        body: null,
      });
    return null;
  });
  const result = await stabilizePrivatePaidQaIngress({ ...harness, nativeInput });
  assert.deepEqual(result, { globallyReady: true, completeWaves: 3, edge404: 0, edge500: 32 });
  assert.equal(harness.calls, 3 * 3 * 32);
  assert.equal(harness.sleeps, 2);
});

test("a persistent unmarked caller 500 still hard-fails after all 12 full-parallel waves", async () => {
  const harness = probeHarness(({ route, calls }) =>
    route === "/qa/transport-caller-ping" && calls % 96 === 1
      ? responseFor(route, {
          status: 500,
          ingressColo: null,
          bindingHeadersMs: null,
          ownerRouteMs: null,
          body: null,
        })
      : null,
  );
  await assert.rejects(
    stabilizePrivatePaidQaIngress({ ...harness, nativeInput }),
    /paid_qa_ingress_readonly_unstable:edge404=0:edge500=12/,
  );
  assert.equal(harness.calls, 12 * 3 * 32);
  assert.equal(harness.sleeps, 11);
});

test("any 500 from owner/native, a marked caller 500 or unrecognized 5xx fails immediately", async () => {
  for (const [route, receipt] of [
    ["/qa/transport-caller-ping", { status: 500, ingressColo: "IAD" }],
    ["/qa/transport-caller-ping", { status: 500, ingressColo: null, bindingHeadersMs: 1 }],
    ["/qa/transport-owner-ping", { status: 500, ingressColo: null }],
    ["/qa/native-first-paint", { status: 500, ingressColo: null }],
    ["/qa/transport-caller-ping", { status: 502, ingressColo: null }],
    ["/qa/transport-caller-ping", { status: 503, ingressColo: null }],
  ]) {
    const harness = probeHarness(({ route: observed }) =>
      observed === route ? responseFor(observed, receipt) : null,
    );
    await assert.rejects(
      stabilizePrivatePaidQaIngress({ ...harness, nativeInput }),
      /paid_qa_ingress_probe_contract_denied/,
    );
    assert.equal(harness.sleeps, 0);
  }
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
    route === "/qa/transport-owner-ping" ? responseFor(route, { ownerRouteMs: null }) : null,
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

test("one pre-measurement TimeoutError never counts as a valid wave, even when later waves recover", async () => {
  const harness = probeHarness(({ route, wave, calls }) => {
    if (wave === 1 && route === "/qa/native-first-paint" && calls % 96 === 65)
      throw Object.assign(new Error("timeout"), { name: "TimeoutError" });
    return null;
  });
  const result = await stabilizePrivatePaidQaIngress({ ...harness, nativeInput });
  assert.deepEqual(result, {
    globallyReady: true,
    completeWaves: 3,
    edge404: 0,
    edge500: 0,
    preflightTimeouts: 1,
  });
  assert.equal(harness.calls, 3 * 3 * 32);
  assert.equal(harness.sleeps, 2);
});

test("one TimeoutError per round exhausts all protected pre-measurement waves", async () => {
  const harness = probeHarness(({ route, calls }) => {
    if (route === "/qa/native-first-paint" && calls % 96 === 65)
      throw Object.assign(new Error("timeout"), { name: "TimeoutError" });
    return null;
  });
  await assert.rejects(
    stabilizePrivatePaidQaIngress({ ...harness, nativeInput }),
    /paid_qa_ingress_readonly_unstable:edge404=0:edge500=0:timeouts=12/,
  );
  assert.equal(harness.calls, 12 * 3 * 32);
  assert.equal(harness.sleeps, 11);
});

test("unexpected network and application failures still fail immediately", async () => {
  const harness = probeHarness(({ route }) => {
    if (route === "/qa/native-first-paint") throw Error("unexpected_transport");
    return null;
  });
  await assert.rejects(
    stabilizePrivatePaidQaIngress({ ...harness, nativeInput }),
    /unexpected_transport/,
  );
  assert.equal(harness.sleeps, 0);
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
