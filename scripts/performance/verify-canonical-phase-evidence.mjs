import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

// Credential-free, read-only audit. No source URLs, headers, SQL, visitors,
// book IDs, exception text or tokens may enter the output artifacts.
export const COLD_TRIALS = 3;
export const COLD_PER_TRIAL = 20;
export const WAVE_COUNTS = Object.freeze({ 1: 8, 4: 12, 8: 16, 16: 24 });
const REQUIRED = [
  "cove_backend_catalog",
  "cove_backend_catalog_sql",
  "cove_backend_catalog_rpc",
  "cove_backend_catalog_rest_headers",
  "cove_backend_catalog_rest_body",
  "cove_backend_catalog_rest_decode",
  "cove_total",
];
const ALLOWED = new Set([
  ...REQUIRED,
  "cove_backend_lean",
  "cove_ssr_local_rights",
  "cove_backend_limit",
  "cove_backend_context",
  "cove_backend_page",
  "cove_backend_bootstrap",
  "cove_entry",
  "cove_render",
]);

export function parseBoundedPhases(timing) {
  if (typeof timing !== "string" || timing.length > 650) return null;
  const result = Object.create(null);
  for (const piece of timing.split(",")) {
    const match = /^([a-z_]+);dur=([0-9]+(?:\.[0-9]{1,3})?)$/.exec(piece.trim());
    if (!match || !ALLOWED.has(match[1])) continue;
    const value = Number(match[2]);
    if (!Number.isFinite(value) || value < 0 || value > 12_000 || match[1] in result) return null;
    result[match[1]] = value;
  }
  return result;
}

function bounded(value, cap = 15_000) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= cap
    ? value
    : null;
}

function classify(phases, ttfb) {
  if (!phases || REQUIRED.some((name) => !(name in phases)))
    return { cause: "unknown-missing-phases", complete: false };
  const catalog = phases.cove_backend_catalog;
  const sql = phases.cove_backend_catalog_sql;
  const rpc = phases.cove_backend_catalog_rpc;
  const headers = phases.cove_backend_catalog_rest_headers;
  const body = phases.cove_backend_catalog_rest_body;
  const decode = phases.cove_backend_catalog_rest_decode;
  const worker = phases.cove_total;
  // Nested intervals can overlap. Reject impossible >35ms differences rather
  // than treating absent/broken phase instrumentation as provider latency.
  if (
    headers + body + decode > rpc + 35 ||
    sql > rpc + 35 ||
    rpc > catalog + 35 ||
    worker > ttfb + 100
  )
    return { cause: "unknown-inconsistent-phases", complete: false };
  // Classification describes the dominant measured interval, never a proven
  // service root cause, SQL statement identity or network fault.
  const outside = Math.max(0, ttfb - worker);
  let cause = "no-dominant-measured-interval";
  if (sql >= 400 && sql >= rpc / 2) cause = "measured-sql-heavy";
  else if (headers - sql >= 350 && headers >= rpc / 2) cause = "measured-preheader-excess";
  else if (rpc - headers - body - decode >= 300) cause = "measured-rpc-excess";
  else if (outside >= 300) cause = "measured-client-worker-residual";
  return { cause, complete: true };
}

function examineRow(row, kind, ordinal) {
  const duration = bounded(row?.ttfbMs);
  const http = kind.startsWith("cold-") ? 200 : row?.status;
  const phases = parseBoundedPhases(row?.timing);
  // Both are verified by the original protected staging runner. Recheck in
  // independent evidence processing so HTTP 200 with empty/unlicensed cards
  // can never count as successful authorized first paint.
  const proof = phases?.cove_ssr_local_rights === 0 && phases?.cove_backend_lean === 0;
  const valid =
    duration !== null &&
    http === 200 &&
    Number.isSafeInteger(row?.cards) &&
    row.cards >= 1 &&
    row.cards <= 100 &&
    proof &&
    (kind.startsWith("cold-") || row.error === null);
  const conclusion = valid
    ? classify(phases, duration)
    : { cause: "unknown-failed-response", complete: false };
  return {
    kind,
    ordinal,
    status: valid ? "valid" : "failed",
    httpClass:
      http === 200
        ? "2xx"
        : http === 0
          ? "network"
          : http >= 500
            ? "5xx"
            : http === 429
              ? "429"
              : "other",
    ttfbMs: duration,
    sqlMs: valid && phases ? bounded(phases.cove_backend_catalog_sql, 12_000) : null,
    rpcMs: valid && phases ? bounded(phases.cove_backend_catalog_rpc, 12_000) : null,
    phaseCoverage: conclusion.complete,
    measuredDominantInterval: conclusion.cause,
    below800: valid && duration < 800,
  };
}

export function evaluateStageCohort({ cold, concurrency }) {
  if (
    !Array.isArray(cold) ||
    cold.length !== COLD_TRIALS ||
    !concurrency ||
    !Array.isArray(concurrency.results)
  )
    throw new Error("Missing required 3-cold/60-concurrency artifacts");
  const records = [];
  const anomalies = [];
  for (let trial = 0; trial < COLD_TRIALS; trial++) {
    const file = cold[trial];
    if (!Array.isArray(file.results) || !Array.isArray(file.failures))
      throw new Error("Invalid cold sample structure");
    const seen = new Set();
    for (const row of file.results) {
      const n = row?.sequence;
      if (!Number.isSafeInteger(n) || n < 1 || n > COLD_PER_TRIAL || seen.has(n))
        anomalies.push("invalid-cold-sequence");
      seen.add(n);
      records.push(examineRow(row, "cold-" + (trial + 1), n));
    }
    for (const row of file.failures) {
      const n = row?.sequence;
      if (!Number.isSafeInteger(n) || n < 1 || n > COLD_PER_TRIAL || seen.has(n))
        anomalies.push("invalid-cold-failure-sequence");
      seen.add(n);
      records.push({
        kind: "cold-" + (trial + 1),
        ordinal: n,
        status: "failed",
        httpClass: "unknown",
        ttfbMs: null,
        sqlMs: null,
        rpcMs: null,
        phaseCoverage: false,
        measuredDominantInterval: "unknown-failed-response",
        below800: false,
      });
    }
    if (seen.size !== COLD_PER_TRIAL) anomalies.push("missing-cold-request");
  }
  const waveSeen = new Map(Object.keys(WAVE_COUNTS).map((wave) => [Number(wave), new Set()]));
  for (const row of concurrency.results) {
    const count = Number(row?.concurrency);
    const seen = waveSeen.get(count);
    if (!seen || !Number.isSafeInteger(row?.sequence) || seen.has(row.sequence))
      anomalies.push("invalid-concurrency-sequence");
    else seen.add(row.sequence);
    records.push(examineRow(row, "wave-" + count, row?.sequence));
  }
  for (const [wave, expected] of Object.entries(WAVE_COUNTS)) {
    if (waveSeen.get(Number(wave)).size !== expected) anomalies.push("missing-concurrency-request");
  }
  if (records.length !== 120) anomalies.push("incorrect-total-request-count");
  const good = records.filter((row) => row.status === "valid");
  const measured = good.filter((row) => row.phaseCoverage);
  const limitedStagePass = anomalies.length === 0 && records.every((row) => row.below800);
  const complete = anomalies.length === 0 && measured.length === records.length;
  const categories = Object.create(null);
  for (const row of records) {
    categories[row.measuredDominantInterval] = (categories[row.measuredDominantInterval] || 0) + 1;
  }
  return {
    schema: "cove.stage.canonical-phase-evidence.v1",
    expected: 120,
    observed: records.length,
    validResponses: good.length,
    failedOrInvalid: records.length - good.length,
    slowOrFailed: records.filter((row) => !row.below800).length,
    fullyAttributed: measured.length,
    completeNumericPhaseCoverage: complete,
    strictLimitedStagingGate: limitedStagePass,
    releaseCertified: false, // Never substitutes for geo, 100 RPS or payments.
    anomalies: [...new Set(anomalies)],
    measuredIntervals: categories,
    // Sanitized numeric labels only. Never return any source object fields.
    samples: records,
  };
}

if (process.argv[1]?.endsWith("verify-canonical-phase-evidence.mjs")) {
  const coldPaths = process.argv.slice(2, 5);
  const concurrentPath = process.argv[5];
  if (coldPaths.length !== 3 || !concurrentPath) {
    console.error("Expected three cold JSON files and one concurrency JSON file");
    process.exitCode = 2;
  } else {
    const artifact = evaluateStageCohort({
      cold: coldPaths.map((p) => JSON.parse(readFileSync(p, "utf8"))),
      concurrency: JSON.parse(readFileSync(concurrentPath, "utf8")),
    });
    mkdirSync("artifacts", { recursive: true });
    writeFileSync(
      "artifacts/canonical-stage-phase-evidence.json",
      JSON.stringify(artifact, null, 2) + "\n",
    );
    console.log(
      JSON.stringify({
        observed: artifact.observed,
        validResponses: artifact.validResponses,
        fullyAttributed: artifact.fullyAttributed,
        completeNumericPhaseCoverage: artifact.completeNumericPhaseCoverage,
        strictLimitedStagingGate: artifact.strictLimitedStagingGate,
        releaseCertified: false,
      }),
    );
    if (!artifact.completeNumericPhaseCoverage || !artifact.strictLimitedStagingGate)
      process.exitCode = 1;
  }
}
