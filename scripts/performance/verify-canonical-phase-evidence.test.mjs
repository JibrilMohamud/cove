import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
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
      secret: "NEVER_COPY_ME",
    })),
    failures: [],
  }));

const concurrency = () => {
  let ordinal = 0;
  return {
    results: Object.entries({ 1: 8, 4: 12, 8: 16, 16: 24 }).flatMap(([k, n]) =>
      Array.from({ length: n }, () => ({
        sequence: ++ordinal,
        concurrency: Number(k),
        status: 200,
        error: null,
        ttfbMs: 520,
        cards: 24,
        timing,
        auth: "Bearer NEVER_COPY_ME",
        url: "https://private.invalid/never",
      })),
    ),
  };
};

test("long raw server-timing headers retain only bounded canonical numeric phases", () => {
  const longHeader = Array.from({ length: 90 }, (_, i) => "irrelevant_" + i + ";dur=3").join(", ") +
    ", " + timing + ', attacker;desc="NEVER_COPY_ME"';
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
  assert.equal(result.strictLimitedStagingGate, true);
  assert.equal(result.releaseCertified, false);
  assert.doesNotMatch(JSON.stringify(result), /NEVER_COPY_ME|private\.invalid|Bearer/);
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
  assert.match(frontend, /COVE_SSR_STAGING = "1"/);
  assert.doesNotMatch(frontend, /COVE_SSR_STAGING_COMMERCE_QA\s*=\s*"1"/);
  assert.doesNotMatch(frontend, /^\s*route\s*=|^\s*routes\s*=/m);
});
