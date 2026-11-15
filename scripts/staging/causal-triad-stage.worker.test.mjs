import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import worker, {
  triadStageBindingGuard,
  triadModes,
  triadSql,
  stageSyntheticIp,
  singleTriadProbe,
  summarizeTriad,
  runTriadPhase,
} from "./causal-triad-stage.worker.mjs";
import privateWorker from "./private-causal-triad.worker.mjs";

const config = JSON.parse(readFileSync("wrangler.performance-triad.stage.jsonc", "utf8"));
const TEST_DB = "e4cbb0ef-6288-4fa1-9dbb-fb42fe01d4f3";
const env = {
  COVE_TRIAD_STAGE: "1",
  COVE_TRIAD_SYNTHETIC_D1_ID: TEST_DB,
  COVE_TRIAD_CANDIDATE: "cove-presentation-r2-candidate-stage",
  BACKEND: "b".repeat(64),
  GATE: "a".repeat(64),
  DB: {
    prepare: (sql) => ({
      bind: (...args) => {
        assert.equal(sql, triadSql);
        assert.deepEqual(args, ["available", "US", "USD", 25]);
        return {
          all: async () => ({
            results: Array.from({ length: 25 }, (_, i) => ({ product_id: "perf-synth-" + i })),
            meta: { duration: 1 },
          }),
        };
      },
    }),
  },
  CANDIDATE: {
    fetch: async (request) => {
      assert.equal(request.headers.get("x-cove-backend-token"), "b".repeat(64));
      assert.equal(request.headers.get("x-cove-client-country"), "US");
      assert.match(request.headers.get("x-cove-client-ip"), /^192\.0\.2\.\d+$/);
      assert.equal(request.headers.get("cookie"), null);
      return Response.json(
        request.url.includes("/storefront/context")
          ? { rightsCountry: "US", currency: "USD", language: "en", availableMarkets: ["US"] }
          : {
              results: Array.from({ length: 24 }, (_, i) => ({
                productId: "perf-synth-" + i,
              })),
            },
        { headers: { "x-cove-persistence": "d1-r2" } },
      );
    },
  },
};
test("staging is private, read-only, and not bound to production", () => {
  assert.equal(config.name, "cove-presentation-capacity-driver-stage");
  assert.equal(config.workers_dev, false);
  assert.equal(config.preview_urls, false);
  assert.deepEqual(
    config.d1_databases.map((d) => d.database_id),
    [TEST_DB],
  );
  assert.deepEqual(config.services, [
    { binding: "CANDIDATE", service: "cove-presentation-r2-candidate-stage" },
  ]);
  for (const denied of ["routes", "r2_buckets", "kv_namespaces", "durable_objects", "triggers"])
    assert.equal(config[denied], undefined);
  assert.equal(config.vars.COVE_TRIAD_EXPIRES_AT, "1970-01-01T00:00:00Z");
  assert.equal(config.vars.COVE_TRIAD_RUN_MINUTE, "0");
  assert.equal(triadStageBindingGuard(env), true);
  assert.equal(triadStageBindingGuard({ ...env, COVE_TRIAD_STAGE: "0" }), false);
  assert.equal(
    triadStageBindingGuard({
      ...env,
      COVE_TRIAD_SYNTHETIC_D1_ID: "4bd657ac-8789-403e-a28c-93aba8d0a989",
    }),
    false,
  );
  assert.deepEqual(triadModes, [
    "noop",
    "context",
    "rights",
    "catalog",
    "single",
    "r2live",
    "r2page2",
    "r2cursor",
    "r2cursorseed",
    "r2seed",
  ]);
  assert.match(triadSql, /retail_product_availability_rows/);
  assert.match(triadSql, /INDEXED BY idx_search_popular_stable/);
});
test("all paths validate stage identity and independent rights provenance", async () => {
  assert.equal((await singleTriadProbe("noop", env, 0, "probe")).valid, true);
  const rights = await singleTriadProbe("rights", env, 1, "probe");
  assert.equal(rights.valid, true);
  assert.equal(rights.sqlMs, 1);
  const context = await singleTriadProbe("context", env, 2, "probe");
  assert.equal(context.valid, true);
  assert.equal(context.status, 200);
  const contextStats = summarizeTriad("context", "single", 1, [{ ...context, launched: true }], 50);
  assert.equal(contextStats.transportLayer, "candidate-service-binding");
  assert.ok(Number.isFinite(contextStats.firstByteP95Ms));
  assert.ok(contextStats.responseBodyP95Ms >= 0);
  const full = await singleTriadProbe("catalog", env, 3, "probe");
  assert.equal(full.valid, true);
  assert.equal(full.status, 200);
  const den = await worker.fetch(new Request("https://triad.invalid/api/fore/catalog"), env);
  assert.equal(den.status, 404);
  assert.equal(
    (await worker.fetch(new Request("https://triad.invalid"), { ...env, BACKEND: undefined }))
      .status,
    503,
  );
});
test("guarded second-page driver preserves fixed query and denies unverified payload", async () => {
  let captured = null;
  const result = await singleTriadProbe(
    "r2page2",
    {
      ...env,
      CANDIDATE: {
        fetch: async (request) => {
          captured = new URL(request.url);
          return Response.json(
            { releaseCertified: false, hasMore: true, mode: "r2-live-retail", results: [] },
            {
            headers: {
              "x-cove-persistence": "d1-live-retail-r2-display-synthetic",
              "x-cove-stage-r2-ms": "3.45",
              "x-cove-stage-cursor-ms": "0.89",
              "x-cove-stage-primary-ms": "98.32",
              "x-cove-stage-assembly-ms": "1.28",
            },
          },
          );
        },
      },
    },
    4,
    "proof",
  );
  assert.equal(captured?.search, "?page=2");
  assert.equal(result.status, 200);
  assert.equal(result.valid, false, "Never accept incomplete page two despite HTTP 200");
  assert.equal(result.errorKind, "unexpected-result-count");
});
test("private cursor carrier isolates one signed anchor from measured page-two D1 reads", async () => {
  const token = "A".repeat(120) + "." + "b".repeat(43);
  let captured = [];
  const visible = Array.from({ length: 24 }, (_, i) => ({
    productId: "perf-synth-" + (i + 24),
    offer: { currency: "USD", amountMinor: 599 },
    subscriptionEligible: false,
    libraryEligible: false,
    downloadable: true,
    releaseStatus: "available",
    drmStatus: "none",
    workId: "work-" + i,
    download_count: 0,
    sourceName: "gutenberg",
    sourceExternalId: "gutenberg-" + i,
    externalIdentifiers: { product: {}, edition: {}, work: {} },
    layout: "reflowable",
    readingAvailability: { state: "stored" },
    formats: {},
  }));
  const stageEnv = {
    ...env,
    COVE_TRIAD_ONDEMAND: "1",
    COVE_TRIAD_EXPIRES_AT: "2099-01-01T00:00:00Z",
    COVE_TRIAD_PROBE_GATE: "f".repeat(64),
    CANDIDATE: {
      fetch: async (req) => {
        const url = new URL(req.url);
        captured.push(url.search);
        assert.equal(req.headers.get("x-cove-backend-token"), env.BACKEND);
        return Response.json(
          {
            results: visible,
            nextCursor: token,
            hasMore: true,
            mode: url.search ? "r2-live-retail-cursor" : "r2-live-retail",
            releaseCertified: false,
          },
          { headers: { "x-cove-persistence": "d1-live-retail-r2-display-synthetic" } },
        );
      },
    },
  };
  assert.equal((await singleTriadProbe("r2cursor", stageEnv, 0, "proof")).status, 400);
  assert.equal(captured.length, 0, "No candidate query without a provided signed cursor");
  const make = (mode, headers = {}) =>
    new Request("https://triad.invalid/__cove/performance/triad/" + mode + "?run=proof&ordinal=7", {
      headers: { "x-cove-triad-key": "f".repeat(64), ...headers },
    });
  const seed = await privateWorker.fetch(make("r2cursorseed"), stageEnv);
  assert.equal(seed.status, 200);
  const seeded = await seed.json();
  assert.equal(seeded.valid, true);
  assert.equal(seeded.cursorToken, token);
  const cursor = await privateWorker.fetch(
    make("r2cursor", { "x-cove-stage-cursor": token }),
    stageEnv,
  );
  assert.equal(cursor.status, 200);
  const result = await cursor.json();
  assert.equal(result.valid, true);
  assert.equal(result.cursorToken, undefined, "Only seed endpoint can return the opaque cursor");
  assert.equal(result.stageR2Ms, 3.45);
  assert.equal(result.stageCursorMs, 0.89);
  assert.equal(result.stagePrimaryMs, 98.32);
  assert.equal(result.stageAssemblyMs, 1.28);
  assert.deepEqual(captured, ["", "?cursor=" + token]);
  const noGate = await privateWorker.fetch(
    new Request(make("r2cursor", { "x-cove-stage-cursor": token }).url),
    stageEnv,
  );
  assert.equal(noGate.status, 404);
  assert.equal(captured.length, 2, "Unauthenticated callers cannot query candidate or cursor");
  const invalidCursor = await privateWorker.fetch(
    make("r2cursor", { "x-cove-stage-cursor": "invalid" }),
    stageEnv,
  );
  assert.equal(invalidCursor.status, 503);
  assert.equal(captured.length, 2, "Malformed cursor is rejected before service binding");
});
test("synthetic 503 retains HTTP status and only allowlisted failure class", async () => {
  const overload = await singleTriadProbe(
    "r2live",
    {
      ...env,
      CANDIDATE: {
        fetch: async () =>
          new Response(null, {
            status: 503,
            headers: { "x-cove-stage-failure-class": "d1-7429-resource-window" },
          }),
      },
    },
    0,
    "proof",
  );
  assert.equal(overload.status, 503);
  assert.equal(overload.valid, false);
  assert.equal(overload.errorKind, "d1-7429-resource-window");
  assert.ok(overload.ms >= 0);
  const unknown = await singleTriadProbe(
    "r2live",
    {
      ...env,
      CANDIDATE: {
        fetch: async () =>
          new Response(null, {
            status: 503,
            headers: { "x-cove-stage-failure-class": "private SQL secret" },
          }),
      },
    },
    0,
    "proof",
  );
  assert.equal(unknown.status, 503);
  assert.equal(unknown.errorKind, "upstream-http-status");
});
test("summarization counts every failure and does not imply a release pass", () => {
  const s = summarizeTriad(
    "catalog",
    "burst-4",
    4,
    [
      { ms: 10, valid: true, status: 200, launched: true },
      { ms: 20, valid: true, status: 200, launched: true },
      { ms: 200, valid: false, status: 503, launched: true },
      { ms: 300, valid: false, status: 0, launched: false, dropped: true, launchDelayMs: 100 },
    ],
    400,
  );
  assert.equal(s.offered, 4);
  assert.equal(s.valid, 2);
  assert.equal(s.failed, 2);
  assert.equal(s.dropped, 1);
  assert.equal(s.p95Ms, 300);
  assert.equal(s.firstByteP95Ms, null);
  assert.equal(s.responseBodyP95Ms, null);
  assert.equal(s.transportLayer, "candidate-service-binding");
  assert.equal(s.externalTtfbCertified, false);
  assert.equal(s.releaseCertified, false);
  assert.equal(s.statusCounts["503"], 1);
});
test("scheduler and synthetic distributed clients retain bounded, valid results", async () => {
  assert.equal(stageSyntheticIp(0), "192.0.2.1");
  assert.equal(stageSyntheticIp(250), "192.0.2.1");
  assert.throws(() => stageSyntheticIp(-1), RangeError);
  const s = await runTriadPhase("rights", "burst-1", 1, 0, env, "test");
  assert.equal(s.offered, 1);
  assert.equal(s.valid, 1);
  assert.equal(s.dropped, 0);
  assert.equal(s.releaseCertified, false);
  await assert.rejects(() => runTriadPhase("rights", "bad", 101, 0, env, "test"), RangeError);
});
