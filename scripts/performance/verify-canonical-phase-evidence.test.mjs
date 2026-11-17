import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  CANONICAL_STAGE_THRESHOLDS,
  canonicalStageP95Limit,
} from "./canonical-stage-thresholds.mjs";
import {
  compactCanonicalPhaseTiming,
  evaluateStageCohort,
  parseBoundedPhases,
} from "./verify-canonical-phase-evidence.mjs";

const timing = [
  "cove_backend_lean;dur=0",
  "cove_ssr_local_rights;dur=0",
  "cove_backend_catalog;dur=310",
  "cove_backend_catalog_sql;dur=4",
  "cove_backend_catalog_rpc;dur=300",
  "cove_backend_catalog_rest_headers;dur=250",
  "cove_backend_catalog_rest_body;dur=35",
  "cove_backend_catalog_rest_decode;dur=3",
  "cove_total;dur=410",
].join(", ");

const cold = () =>
  Array.from({ length: 3 }, () => ({
    results: Array.from({ length: 20 }, (_, n) => ({
      sequence: n + 1,
      ttfbMs: 500,
      cards: 24,
      timing,
      clientQueueMs: 7,
      clientToHeadersMs: 493,
      secret: "NEVER_COPY_ME",
    })),
    failures: [],
  }));

const concurrency = () => {
  let ordinal = 0;
  return {
    pairedPhaseControls: true,
    deniedControls: [1, 4, 8, 16].flatMap((wave) =>
      Array.from({ length: 8 }, () => ({
        concurrency: wave,
        status: 401,
        denied: true,
        ttfbMs: 60,
        clientQueueMs: 2,
        sentToHeadersMs: 55,
        secret: "NEVER_COPY_ME",
      })),
    ),
    controlSummaries: [1, 4, 8, 16].map((concurrency) => ({
      concurrency,
      requests: 8,
      denied401: 8,
    })),
    results: Object.entries({ 1: 8, 4: 12, 8: 16, 16: 24 }).flatMap(([k, n]) =>
      Array.from({ length: n }, () => ({
        sequence: ++ordinal,
        concurrency: Number(k),
        status: 200,
        error: null,
        ttfbMs: 520,
        cards: 24,
        timing,
        clientQueueMs: 18,
        sentToHeadersMs: 502,
        auth: "Bearer NEVER_COPY_ME",
        url: "https://private.invalid/never",
      })),
    ),
  };
};

test("long raw server-timing headers retain only bounded canonical numeric phases", () => {
  const longHeader =
    Array.from({ length: 90 }, (_, i) => "irrelevant_" + i + ";dur=3").join(", ") +
    ", " +
    timing +
    ', attacker;desc="NEVER_COPY_ME"';
  assert.ok(longHeader.length > 650);
  assert.ok(longHeader.length < 4096);
  const packed = compactCanonicalPhaseTiming(longHeader);
  assert.ok(typeof packed === "string" && packed.length < 650);
  assert.ok(packed.includes("cove_backend_catalog_rest_headers;dur=250"));
  assert.ok(packed.includes("cove_ssr_local_rights;dur=0"));
  assert.doesNotMatch(packed, /irrelevant|attacker|NEVER_COPY_ME/);
  assert.equal(compactCanonicalPhaseTiming(longHeader + longHeader + longHeader), null);
});

test("complete synthetic evidence is not equivalent to release certification", () => {
  const result = evaluateStageCohort({
    cold: cold(),
    concurrency: concurrency(),
  });
  assert.equal(result.observed, 120);
  assert.equal(result.validResponses, 120);
  assert.equal(result.fullyAttributed, 120);
  assert.equal(result.completeNumericPhaseCoverage, true);
  assert.equal(result.edgeControlsExpected, 32);
  assert.equal(result.edgeControlsObserved, 32);
  assert.equal(result.edgeControlsSecure, true);
  assert.deepEqual(
    result.edgeControlCohorts.map((x) => x.concurrency),
    [1, 4, 8, 16],
  );
  assert.equal(result.edgeControlCohorts[0].p95Ms, 60);
  assert.equal(result.strictLimitedStagingGate, true);
  assert.equal(result.releaseCertified, false);
  assert.deepEqual(
    {
      catalog: result.samples[0].catalogMs,
      sql: result.samples[0].sqlMs,
      rpc: result.samples[0].rpcMs,
      headers: result.samples[0].restHeadersMs,
      body: result.samples[0].restBodyMs,
      decode: result.samples[0].restDecodeMs,
      worker: result.samples[0].workerMs,
      outside: result.samples[0].outsideWorkerMs,
      rpcUnaccounted: result.samples[0].rpcUnaccountedMs,
      queue: result.samples[0].runnerQueueMs,
      clientToHeaders: result.samples[0].runnerSentToHeadersMs,
    },
    {
      catalog: 310,
      sql: 4,
      rpc: 300,
      headers: 250,
      body: 35,
      decode: 3,
      worker: 410,
      outside: 90,
      rpcUnaccounted: 12,
      queue: 7,
      clientToHeaders: 493,
    },
  );
  assert.equal(result.samples[60].runnerQueueMs, 18);
  assert.equal(result.samples[60].runnerSentToHeadersMs, 502);
  assert.doesNotMatch(JSON.stringify(result), /NEVER_COPY_ME|private\.invalid|Bearer/);
});

test("independent evidence rejects protected #86-style cohort p95 regressions", () => {
  assert.deepEqual(CANONICAL_STAGE_THRESHOLDS, { maxTtfbMs: 800, p95TtfbMs: 650 });
  assert.deepEqual([1, 4, 8, 16].map(canonicalStageP95Limit), [650, 650, 650, 800]);
  assert.throws(() => canonicalStageP95Limit(32));

  for (const wave of [1, 4, 8]) {
    const source = concurrency();
    const row = source.results.find((item) => item.concurrency === wave);
    row.ttfbMs = 702;
    source.status = "pass";
    source.summaries = [{ concurrency: wave, p95Ms: 120, pass: true }];
    const result = evaluateStageCohort({ cold: cold(), concurrency: source });
    assert.equal(result.validResponses, 120);
    assert.equal(result.completeNumericPhaseCoverage, true);
    assert.equal(result.slowOrFailed, 0, "All licensed requests are still under 800ms");
    assert.equal(result.edgeControlsSecure, true);
    assert.equal(result.waveCohorts.find((entry) => entry.concurrency === wave)?.p95Ms, 702);
    assert.equal(result.waveCohorts.find((entry) => entry.concurrency === wave)?.pass, false);
    assert.equal(result.strictLimitedStagingGate, false);
    assert.equal(result.releaseCertified, false);
  }
});

test("p95 boundary and 16-concurrent hard max retain existing strict contract", () => {
  const limit = concurrency();
  limit.results.find((row) => row.concurrency === 8).ttfbMs = 650;
  limit.results.find((row) => row.concurrency === 16).ttfbMs = 799;
  let result = evaluateStageCohort({ cold: cold(), concurrency: limit });
  assert.equal(result.strictLimitedStagingGate, true);
  assert.equal(result.waveCohorts.find((row) => row.concurrency === 8).p95Ms, 650);
  assert.equal(result.waveCohorts.find((row) => row.concurrency === 16).maxMs, 799);
  limit.results.find((row) => row.concurrency === 8).ttfbMs = 651;
  result = evaluateStageCohort({ cold: cold(), concurrency: limit });
  assert.equal(result.strictLimitedStagingGate, false);
  limit.results.find((row) => row.concurrency === 8).ttfbMs = 650;
  limit.results.find((row) => row.concurrency === 16).ttfbMs = 800;
  result = evaluateStageCohort({ cold: cold(), concurrency: limit });
  assert.equal(result.strictLimitedStagingGate, false);
  assert.equal(result.slowOrFailed, 1);
});

test("substituting a concurrency ordinal cannot hide a missing scheduled request", () => {
  const falsified = concurrency();
  falsified.results[0].sequence = 601;
  const audit = evaluateStageCohort({ cold: cold(), concurrency: falsified });
  assert.ok(audit.anomalies.includes("unmatched-concurrency-sequence"));
  assert.equal(audit.strictLimitedStagingGate, false);
  assert.equal(audit.completeNumericPhaseCoverage, false);
});

test("one 503 and one slow incomplete sample remain unclassified failures", () => {
  const previous = cold();
  const concurrent = concurrency();
  concurrent.results[0] = {
    ...concurrent.results[0],
    status: 503,
    error: "upstream-5xx",
    cards: 0,
    timing: null,
  };
  previous[0].results[0] = {
    ...previous[0].results[0],
    timing: "cove_ssr_local_rights;dur=0, cove_backend_lean;dur=0, cove_total;dur=850",
    ttfbMs: 920,
  };
  const result = evaluateStageCohort({
    cold: previous,
    concurrency: concurrent,
  });
  assert.equal(result.failedOrInvalid, 1);
  assert.equal(result.fullyAttributed, 118);
  assert.equal(result.completeNumericPhaseCoverage, false);
  assert.equal(result.strictLimitedStagingGate, false);
  assert.equal(result.measuredIntervals["unknown-failed-response"], 1);
  assert.equal(result.measuredIntervals["unknown-missing-phases"], 1);
});

test("missing, duplicated, illegal or unlicensed results can never pass", () => {
  const previous = cold();
  previous[1].results.pop();
  const incomplete = evaluateStageCohort({
    cold: previous,
    concurrency: concurrency(),
  });
  assert.ok(incomplete.anomalies.includes("missing-cold-request"));
  assert.equal(incomplete.observed, 119);
  assert.equal(incomplete.strictLimitedStagingGate, false);

  const invalid = cold();
  invalid[0].results[0].timing = timing.replace(
    "cove_ssr_local_rights;dur=0",
    "cove_ssr_local_rights;dur=2",
  );
  const denied = evaluateStageCohort({
    cold: invalid,
    concurrency: concurrency(),
  });
  assert.equal(denied.validResponses, 119);
  assert.equal(denied.releaseCertified, false);
});

test("impossible and forged timing values are not inferred to be platform faults", () => {
  const previous = cold();
  previous[0].results[0].timing = timing.replace(
    "cove_backend_catalog_sql;dur=4",
    "cove_backend_catalog_sql;dur=480",
  );
  const result = evaluateStageCohort({
    cold: previous,
    concurrency: concurrency(),
  });
  assert.equal(result.fullyAttributed, 119);
  assert.equal(result.samples[0].measuredDominantInterval, "unknown-inconsistent-phases");
  assert.equal(parseBoundedPhases("cove_backend_catalog_rpc;dur=13000, cove_total;dur=400"), null);
  assert.equal(
    parseBoundedPhases("cove_backend_catalog_rpc;dur=100, cove_backend_catalog_rpc;dur=90"),
    null,
  );
});

test("private shared read service cannot opt into staging-only phase emission", () => {
  const original = JSON.parse(
    // The existing Wrangler config is JSONC with a permitted trailing comma.
    readFileSync("wrangler.canonical-readonly.jsonc", "utf8").replace(/,\s*([}\]])/g, "$1"),
  );
  const staged = JSON.parse(readFileSync("wrangler.canonical-phase.staging.jsonc", "utf8"));
  const frontend = readFileSync("wrangler.frontend.phase.staging.toml", "utf8");
  const backend = readFileSync("infra/canonical-readonly/worker.ts", "utf8");
  assert.equal(original.name, "cove-canonical-d1-readonly");
  assert.notEqual(staged.name, original.name);
  assert.equal(original.vars?.COVE_STAGE_READ_PHASE_DIAGNOSTICS, undefined);
  assert.equal(staged.vars.COVE_STAGE_READ_PHASE_DIAGNOSTICS, "1");
  assert.equal(staged.workers_dev, false);
  assert.equal(staged.preview_urls, false);
  assert.deepEqual(staged.routes, []);
  assert.ok(!staged.d1_databases);
  assert.ok(!staged.r2_buckets);
  assert.ok(!staged.services);
  assert.ok(!staged.secrets);
  assert.match(
    backend,
    /this\.env\.COVE_STAGE_READ_PHASE_DIAGNOSTICS !== "1"\) return body\.result/,
  );
  assert.match(frontend, /name = "cove-storefront-phase-staging"/);
  assert.match(frontend, /service = "cove-canonical-phase-readonly-staging"/);
  assert.doesNotMatch(frontend, /\[\[d1_databases\]\]/);
  assert.doesNotMatch(frontend, /\[\[r2_buckets\]\]/);
  assert.match(frontend, /COVE_SSR_STAGING = "1"/);
  assert.doesNotMatch(frontend, /COVE_SSR_STAGING_COMMERCE_QA\s*=\s*"1"/);
  assert.doesNotMatch(frontend, /^\s*route\s*=|^\s*routes\s*=/m);
});

test("invalid, impossible or missing phases never persist numeric timing fields", () => {
  const previous = cold();
  previous[0].results[0].timing = timing.replace(
    "cove_backend_catalog_rest_headers;dur=250",
    "cove_backend_catalog_rest_headers;dur=13000",
  );
  previous[0].results[1].timing = timing.replace(
    "cove_backend_catalog_sql;dur=4",
    "cove_backend_catalog_sql;dur=900",
  );
  const invalid = concurrency();
  invalid.results[0] = {
    ...invalid.results[0],
    status: 503,
    cards: 0,
    error: "upstream-5xx",
    timing: null,
  };
  const evidence = evaluateStageCohort({ cold: previous, concurrency: invalid });
  assert.equal(evidence.strictLimitedStagingGate, false);
  assert.equal(evidence.completeNumericPhaseCoverage, false);
  for (const ordinal of [0, 1, 60]) {
    const sample = evidence.samples[ordinal];
    for (const name of [
      "catalogMs",
      "restHeadersMs",
      "restBodyMs",
      "restDecodeMs",
      "workerMs",
      "outsideWorkerMs",
      "rpcUnaccountedMs",
      "runnerQueueMs",
      "runnerSentToHeadersMs",
    ])
      assert.equal(sample[name], null);
  }
  assert.doesNotMatch(JSON.stringify(evidence), /upstream-5xx/);
});

test("runner-supplied arbitrary strings or oversized numbers never enter archived evidence", () => {
  const previous = cold();
  previous[0].results[0].clientQueueMs = 500_000;
  previous[0].results[0].clientToHeadersMs = "Bearer NEVER_COPY_ME";
  const evidence = evaluateStageCohort({ cold: previous, concurrency: concurrency() });
  assert.equal(evidence.samples[0].runnerQueueMs, null);
  assert.equal(evidence.samples[0].runnerSentToHeadersMs, null);
  assert.equal(evidence.validResponses, 120);
  assert.equal(evidence.releaseCertified, false);
  assert.doesNotMatch(JSON.stringify(evidence), /Bearer|NEVER_COPY_ME/);
});

test("missing or forged anonymous 401 controls block staged rights acceptance", () => {
  for (const mutate of [
    (raw) => {
      raw.deniedControls = [];
    },
    (raw) => {
      delete raw.pairedPhaseControls;
    },
    (raw) => {
      raw.deniedControls[0].status = 200;
      raw.deniedControls[0].denied = false;
    },
    (raw) => {
      raw.deniedControls[0].denied = false;
    },
    (raw) => {
      raw.deniedControls[0].ttfbMs = "Bearer NEVER_COPY_ME";
    },
    (raw) => {
      raw.deniedControls[0].clientQueueMs = 100_000;
    },
    (raw) => {
      raw.controlSummaries[0].denied401 = 7;
    },
    (raw) => {
      raw.deniedControls[8].concurrency = 8;
    },
  ]) {
    const data = concurrency();
    mutate(data);
    const evidence = evaluateStageCohort({ cold: cold(), concurrency: data });
    assert.equal(evidence.observed, 120);
    assert.equal(evidence.validResponses, 120);
    assert.equal(evidence.strictLimitedStagingGate, false);
    assert.equal(evidence.edgeControlsSecure, false);
    assert.ok(evidence.anomalies.some((x) => x.includes("edge")));
    assert.doesNotMatch(JSON.stringify(evidence), /Bearer|NEVER_COPY_ME/);
  }
});

test("phase controls are post-wave, never prewarm true cold, never change 60 licensed checks", () => {
  const source = readFileSync("scripts/performance/cloudflare-concurrency.mjs", "utf8");
  const coldSafe = source.indexOf("const pairedPhaseControls =");
  const wave = source.indexOf("for (const wave of waves) {");
  const licensed = source.indexOf("const rows = await runWave(wave);");
  const paired = source.indexOf(
    "deniedControls.push(...(await runDeniedControlWave(wave.concurrency, 8)))",
  );
  assert.ok(coldSafe > 0 && wave > coldSafe);
  assert.ok(licensed > wave && paired > licensed);
  assert.match(source, /const controlWaves = pairedPhaseControls/);
  assert.match(source, /if \(!pairedPhaseControls\)/);
  assert.match(source, /const controlsSecure =/);
  assert.match(source, /const passed = summaries\.every\(\(s\) => s\.pass\) && controlsSecure/);
  assert.match(source, /assert\.equal\(total, 60,/);
});
