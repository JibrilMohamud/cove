import assert from "node:assert/strict";
import fs from "node:fs";
import { performance } from "node:perf_hooks";
import {
  percentile,
  productionOrigin,
  safeProbeTelemetry,
  validateHtml,
} from "../check-production-storefront-performance.mjs";

// Synthetic, read-only authenticated staging probe; NOT a production load test.
// The total is capped at 60 requests to respect the Worker edge rate limiter.
// No client IP, hostname, URL, book contents, headers or bearer key are logged.
const waves = Object.freeze([
  { concurrency: 1, requests: 8 },
  { concurrency: 4, requests: 12 },
  { concurrency: 8, requests: 16 },
  { concurrency: 16, requests: 24 },
]);
const total = waves.reduce((sum, wave) => sum + wave.requests, 0);
assert.equal(total, 60, "Keep the concurrency probe below the per-colo read cap");
const origin = productionOrigin(process.env.COVE_SSR_STAGING_ORIGIN);
const token = process.env.COVE_SSR_STAGING_GATE_KEY;
assert.match(token || "", /^[a-f0-9]{64}$/, "Only protected staging may be load-tested");
assert.match(origin, /-staging\.[a-z0-9.-]+\.workers\.dev$/);
const thresholds = { maxTtfbMs: 800, p95TtfbMs: 650 };

const started = performance.now();
const results = [];
let ordinal = 0;
const languages = ["en-US,en;q=0.9", "es-ES,es;q=0.9", "fr-FR,fr;q=0.9"];

async function fetchOne(concurrency) {
  const sequence = ++ordinal;
  const begin = performance.now();
  let httpStatus = 0;
  try {
    const response = await fetch(origin + "/", {
      method: "GET",
      redirect: "manual",
      headers: {
        Authorization: "Bearer " + token,
        Accept: "text/html",
        "Accept-Language": languages[(sequence - 1) % languages.length],
        "Cache-Control": "no-store",
      },
      signal: AbortSignal.timeout(15000),
    });
    httpStatus = response.status;
    const ttfbMs = Math.round(performance.now() - begin);
    const html = await response.text();
    const totalMs = Math.round(performance.now() - begin);
    // Fully rendered HTML, not a 200 fallback, empty catalogue or 401 asset.
    const cards = validateHtml(response.status, response.headers.get("content-type") || "", html);
    assert.ok(cards >= 1);
    assert.match(response.headers.get("cache-control") || "", /no-store/);
    assert.match(
      response.headers.get("server-timing") || "",
      /cove_ssr_local_rights;dur=0(?:\.0)?(?:,|$)/,
      "Must query live primary D1 territorial rights; no cached rights/fallback",
    );
    const timing = safeProbeTelemetry(response.headers, ttfbMs, totalMs);
    const cfColo = (response.headers.get("cf-ray") || "").match(/-([A-Z]{3})$/)?.[1] || "unknown";
    return {
      sequence,
      concurrency,
      status: httpStatus,
      cards,
      ttfbMs,
      totalMs,
      cfColo,
      timing: timing.timing,
      error: null,
    };
  } catch {
    // Never stringify exceptions; browser/HTTP errors might contain credentials.
    return {
      sequence,
      concurrency,
      status: httpStatus,
      cards: 0,
      ttfbMs: Math.round(performance.now() - begin),
      totalMs: null,
      cfColo: "unknown",
      timing: null,
      error:
        httpStatus && httpStatus !== 200
          ? "http-or-render-failed"
          : "request-or-rights-check-failed",
    };
  }
}

async function runWave({ concurrency, requests }) {
  const rows = [];
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, requests) }, async () => {
    while (next < requests) {
      next += 1;
      const row = await fetchOne(concurrency);
      rows.push(row);
    }
  });
  await Promise.all(workers);
  return rows.sort((a, b) => a.sequence - b.sequence);
}

for (const wave of waves) {
  const rows = await runWave(wave);
  results.push(...rows);
}
const summaries = waves.map(({ concurrency, requests }) => {
  const subset = results.filter((r) => r.concurrency === concurrency);
  const good = subset.filter((r) => !r.error);
  const times = good.map((r) => r.ttfbMs);
  const maxMs = times.length ? Math.max(...times) : null;
  const p95Ms = percentile(times, 0.95);
  return {
    concurrency,
    requests,
    successes: good.length,
    errors: subset.length - good.length,
    p50Ms: percentile(times, 0.5),
    p75Ms: percentile(times, 0.75),
    p95Ms,
    maxMs,
    colo: [...new Set(good.map((r) => r.cfColo))].sort(),
    pass:
      subset.length === requests &&
      good.length === requests &&
      maxMs !== null &&
      maxMs < thresholds.maxTtfbMs &&
      p95Ms !== null &&
      // Higher load may increase p95 but may never breach the hard 800ms gate.
      p95Ms <= (concurrency <= 8 ? thresholds.p95TtfbMs : thresholds.maxTtfbMs),
  };
});
const passed = summaries.every((s) => s.pass);
const artifact = {
  status: passed ? "pass" : "fail",
  total,
  testedConcurrency: waves.map((w) => w.concurrency),
  thresholds,
  elapsedMs: Math.round(performance.now() - started),
  summaries,
  results,
};
fs.mkdirSync("artifacts", { recursive: true });
fs.writeFileSync(
  "artifacts/cloudflare-concurrency-performance.json",
  JSON.stringify(artifact, null, 2) + "\n",
);
const report = [
  "## Protected Cloudflare SSR concurrency gate",
  "",
  "Read-only, rights-authoritative full homepage HTML; HTTP 200 + cards + no-store required.",
  "Staging only, no user traffic replay or borrowed credentials. The slowest sample counts.",
  "Concurrency is in-flight request count, NOT active users or guaranteed worldwide throughput.",
  "",
  "| Concurrency | Requests | Valid | p50 | p75 | p95 | Max | CF colos | Gate |",
  "| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |",
  ...summaries.map(
    (s) =>
      `| ${s.concurrency} | ${s.requests} | ${s.successes} | ${s.p50Ms ?? "n/a"} ms | ${s.p75Ms ?? "n/a"} ms | ${s.p95Ms ?? "n/a"} ms | ${s.maxMs ?? "n/a"} ms | ${s.colo.join(",")} | ${s.pass ? "pass" : "FAIL"} |`,
  ),
  "",
  `Result **${passed ? "pass" : "fail"}** — ${total} bounded requests, no allowed 5xx/429/invalid rights.`,
].join("\n");
console.log(report);
if (process.env.GITHUB_STEP_SUMMARY)
  fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, report + "\n");
if (!passed) process.exitCode = 1;
