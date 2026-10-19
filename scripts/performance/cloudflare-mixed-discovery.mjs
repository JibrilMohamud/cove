// Protected, bounded 50:50 discovery and licensed-homepage load test.
// Read-only, IDENTICAL stage probe of real literary candidate SQL in BOTH builds.
import assert from "node:assert/strict";
import fs from "node:fs";
import { performance } from "node:perf_hooks";
import {
  percentile,
  productionOrigin,
  validateHtml,
} from "../check-production-storefront-performance.mjs";

const origin = productionOrigin(process.env.COVE_SSR_STAGING_ORIGIN);
const token = process.env.COVE_SSR_STAGING_GATE_KEY;
assert.match(token || "", /^[a-f0-9]{64}$/, "Isolated staging credential required");
assert.match(origin, /-staging\.[a-z0-9.-]+\.workers\.dev$/);
const waves = [
  { concurrency: 1, requests: 8 },
  { concurrency: 4, requests: 12 },
  { concurrency: 8, requests: 16 },
  { concurrency: 16, requests: 24 },
];
const intents = ["reflective", "friendship", "mystery"];
const rows = [];
let ordinal = 0;

async function requestOne(kind, concurrency) {
  const sequence = ++ordinal;
  const before = performance.now();
  const intent = intents[(sequence - 1) % intents.length];
  const discovery = kind === "discovery";
  const url = discovery
    ? origin + "/api/fore/benchmark/literary-candidates?term=" + intent
    : origin + "/";
  let status = 0;
  let colo = "unknown";
  try {
    const options = {
      method: "GET",
      redirect: "manual",
      headers: {
        Authorization: "Bearer " + token,
        "Cache-Control": "no-store",
        Accept: discovery ? "application/json" : "text/html",
      },
      signal: AbortSignal.timeout(20000),
    };
    const response = await fetch(url, options);
    status = response.status;
    const ttfbMs = Math.round(performance.now() - before);
    colo = (response.headers.get("cf-ray") || "").match(/-([A-Z]{3})$/)?.[1] || "unknown";
    const raw = await response.text();
    let count = 0;
    if (discovery) {
      assert.equal(status, 200, "Discovery HTTP failure");
      assert.match(response.headers.get("content-type") || "", /application\/json/);
      const payload = JSON.parse(raw);
      assert.equal(payload.schema, "cove-stage-literary-rights-read-v1");
      assert.equal(payload.rightsSource, "primary-d1-live");
      assert.ok(Number.isInteger(payload.count) && payload.count >= 0);
      assert.match(response.headers.get("server-timing") || "", /cove_literary_read;dur=/);
      count = payload.count;
    } else {
      count = validateHtml(status, response.headers.get("content-type") || "", raw);
      assert.ok(count >= 1, "No rights-cleared books");
      assert.match(
        response.headers.get("server-timing") || "",
        /cove_ssr_local_rights;dur=0(?:\.0)?(?:,|$)/,
        "Homepage bypassed primary-D1 rights",
      );
    }
    return {
      sequence,
      concurrency,
      kind,
      intent: discovery ? intent : null,
      status,
      ttfbMs,
      totalMs: Math.round(performance.now() - before),
      count,
      colo,
      error: null,
    };
  } catch {
    return {
      sequence,
      concurrency,
      kind,
      intent: discovery ? intent : null,
      status,
      ttfbMs: Math.round(performance.now() - before),
      totalMs: null,
      count: 0,
      colo,
      error: status !== 200 ? "http-failure" : "validation-or-request-failure",
    };
  }
}

for (const wave of waves) {
  const jobs = Array.from({ length: wave.requests }, (_, i) =>
    i % 2 === 0 ? "home" : "discovery",
  );
  let cursor = 0;
  const workers = Array.from({ length: wave.concurrency }, async () => {
    while (cursor < jobs.length) {
      const kind = jobs[cursor++];
      rows.push(await requestOne(kind, wave.concurrency));
    }
  });
  await Promise.all(workers);
}
function summarize(concurrency, kind, expected) {
  const subset = rows.filter((r) => r.concurrency === concurrency && r.kind === kind);
  const valid = subset.filter((r) => !r.error);
  const t = valid.map((r) => r.ttfbMs);
  const maxMs = t.length ? Math.max(...t) : null;
  const p95Ms = percentile(t, 0.95);
  const successful = valid.length === expected;
  return {
    concurrency,
    attempted: expected,
    successes: valid.length,
    errors: subset.length - valid.length,
    p50Ms: percentile(t, 0.5),
    p95Ms,
    maxMs,
    colos: [...new Set(valid.map((r) => r.colo))].sort(),
    valid: successful,
    pass:
      successful &&
      (kind === "discovery" || (maxMs !== null && maxMs < 800 && p95Ms !== null && p95Ms <= 650)),
  };
}
const summary = waves.map((w) => ({
  concurrency: w.concurrency,
  home: summarize(w.concurrency, "home", w.requests / 2),
  discovery: summarize(w.concurrency, "discovery", w.requests / 2),
}));
const report = {
  test: "protected-mixed-read-only-literary-home-v2",
  scope: "actual rights-filtered candidate query, not the POST endpoint or full recommendation logging",
  waves,
  summary,
  results: rows.sort((a, b) => a.sequence - b.sequence),
  pass: summary.every((wave) => wave.home.pass && wave.discovery.pass),
};
fs.mkdirSync("artifacts", { recursive: true });
fs.writeFileSync(
  "artifacts/cloudflare-mixed-discovery-performance.json",
  JSON.stringify(report, null, 2),
);
for (const w of summary) process.stdout.write(JSON.stringify(w) + "\n");
if (!report.pass) process.exitCode = 1;
