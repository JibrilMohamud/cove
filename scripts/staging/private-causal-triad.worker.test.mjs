import test from "node:test";
import assert from "node:assert/strict";
import worker, { privateTriadGuard } from "./private-causal-triad.worker.mjs";

const GATE = "a".repeat(64);
const URL = "https://cove-presentation-capacity-driver-stage.cove-jibrilmohamud.workers.dev";
let d1Calls = 0;
let serviceCalls = 0;
let serviceFailure = null;
const env = {
  COVE_TRIAD_STAGE: "1",
  COVE_TRIAD_ONDEMAND: "1",
  COVE_TRIAD_SYNTHETIC_D1_ID: "e4cbb0ef-6288-4fa1-9dbb-fb42fe01d4f3",
  COVE_TRIAD_CANDIDATE: "cove-presentation-r2-candidate-stage",
  COVE_TRIAD_EXPIRES_AT: "2999-01-01T00:00:00.000Z",
  COVE_TRIAD_PROBE_GATE: GATE,
  GATE: "c".repeat(64),
  BACKEND: "b".repeat(64),
  DB: {
    prepare(sql) {
      d1Calls += 1;
      assert.match(sql, /retail_product_availability_rows/);
      return {
        bind() {
          return {
            all: async () => ({
              results: Array.from({ length: 25 }, (_, i) => ({ product_id: "perf-synth-" + i })),
              meta: { duration: 1.5, rows_read: 346, rows_written: 0 },
            }),
          };
        },
      };
    },
  },
  CANDIDATE: {
    async fetch(request) {
      serviceCalls += 1;
      try {
        assert.equal(request.headers.get("x-cove-backend-token"), "b".repeat(64));
        assert.equal(request.headers.has("cookie"), false);
        return Response.json(
          new globalThis.URL(request.url).pathname.endsWith("/context")
            ? { rightsCountry: "US", currency: "USD" }
            : {
                results: Array.from({ length: 24 }, (_, i) => ({
                  productId: "perf-synth-" + i,
                })),
              },
          { headers: { "x-cove-persistence": "d1-r2" } },
        );
      } catch (error) {
        serviceFailure = (error?.name || "unknown") + ":" + (error?.message || "unknown");
        throw error;
      }
    },
  },
};
const makeRequest = (mode, key = GATE) =>
  new Request(`${URL}/__cove/performance/triad/${mode}?run=synthetic-test&ordinal=3`, {
    headers: key ? { "x-cove-triad-key": key } : {},
  });

test("unauthorized, malformed and expired probes never access D1 or the service binding", async () => {
  d1Calls = 0;
  serviceCalls = 0;
  for (const request of [
    makeRequest("rights", null),
    makeRequest("catalog", "f".repeat(64)),
    makeRequest("unused"),
    new Request(URL + "/catalog", { headers: { "x-cove-triad-key": GATE } }),
  ]) {
    assert.equal((await worker.fetch(request, env)).status, 404);
  }
  assert.equal(privateTriadGuard({ ...env, COVE_TRIAD_EXPIRES_AT: "2026-01-01T00:00:00Z" }, makeRequest("noop")), false);
  assert.equal((await worker.fetch(makeRequest("rights"), { ...env, COVE_TRIAD_EXPIRES_AT: "2026-01-01T00:00:00Z" })).status, 404);
  assert.equal((await worker.fetch(makeRequest("rights"), { ...env, COVE_TRIAD_SYNTHETIC_D1_ID: "4bd657ac-8789-403e-a28c-93aba8d0a989" })).status, 404);
  assert.equal(d1Calls, 0);
  assert.equal(serviceCalls, 0);
});

test("one authenticated ingress tests noop, rights, context and catalog without leaking IDs", async () => {
  d1Calls = 0;
  serviceCalls = 0;
  for (const mode of ["noop", "rights", "context", "catalog"]) {
    const response = await worker.fetch(makeRequest(mode), env);
    const result = await response.json();
    assert.equal(response.status, 200, mode + " " + JSON.stringify({ result, serviceCalls, serviceFailure }));
    assert.match(response.headers.get("server-timing") || "", /cove_stage_worker;dur=/);
    assert.equal(result.mode, mode);
    assert.equal(result.valid, true);
    assert.equal(result.releaseCertified, false);
    assert.equal(JSON.stringify(result).includes("perf-synth-"), false, "Do not disclose candidate IDs");
  }
  assert.equal(d1Calls, 1, "Noop and service-bound paths do not use the driver D1");
  assert.equal(serviceCalls, 2, "Only context/catalog traverse the candidate binding");
});

test("malformed ordinal and run identifiers are rejected before D1", async () => {
  d1Calls = 0;
  assert.equal(
    (await worker.fetch(
      new Request(URL + "/__cove/performance/triad/rights?run=bad%2Fsecret&ordinal=1", {
        headers: { "x-cove-triad-key": GATE },
      }),
      env,
    )).status,
    400,
  );
  assert.equal(d1Calls, 0);
});

test("invalid upstream 200 payload and true 503 are counted separately without raw identifiers", async () => {
  const invalid = {
    ...env,
    CANDIDATE: {
      async fetch() {
        return Response.json(
          { results: Array.from({ length: 24 }, () => ({ productId: "sensitive-nonfixture" })) },
          { headers: { "x-cove-persistence": "d1-r2" } },
        );
      },
    },
  };
  const invalidResponse = await worker.fetch(makeRequest("catalog"), invalid);
  assert.equal(invalidResponse.status, 503);
  const invalidPayload = await invalidResponse.json();
  assert.equal(invalidPayload.downstreamStatus, 200);
  assert.equal(invalidPayload.resultKind, "duplicate-result-id");
  assert.equal(invalidPayload.valid, false);
  assert.doesNotMatch(JSON.stringify(invalidPayload), /sensitive-nonfixture/);

  const overloaded = {
    ...env,
    CANDIDATE: {
      async fetch() {
        return Response.json(
          { error: "D1 DB is overloaded. Do not copy private messages." },
          { status: 503, headers: { "x-cove-persistence": "d1-r2" } },
        );
      },
    },
  };
  const overloadResponse = await worker.fetch(makeRequest("catalog"), overloaded);
  assert.equal(overloadResponse.status, 503);
  const overloadPayload = await overloadResponse.json();
  assert.equal(overloadPayload.downstreamStatus, 503);
  assert.equal(overloadPayload.resultKind, "upstream-http-status");
  assert.doesNotMatch(JSON.stringify(overloadPayload), /D1 DB is overloaded|private messages/);
});
