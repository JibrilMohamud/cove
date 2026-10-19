// Bounded, stage-gated mixed literary discovery + rights-approved homepage stress.
// No production routes, no account cookies, no identities or bearer tokens in artifacts.
import assert from "node:assert/strict";
import fs from "node:fs";
import { performance } from "node:perf_hooks";
import { randomUUID, createHash } from "node:crypto";
import { percentile, productionOrigin, validateHtml } from "../check-production-storefront-performance.mjs";

const origin = productionOrigin(process.env.COVE_SSR_STAGING_ORIGIN);
const token = process.env.COVE_SSR_STAGING_GATE_KEY;
assert.match(token || "", /^[a-f0-9]{64}$/, "A protected isolated stage is required");
assert.match(origin, /-staging\.[a-z0-9.-]+\.workers\.dev$/);
const waves = [
  { concurrency: 1, home: 4, discovery: 4 },
  { concurrency: 4, home: 6, discovery: 6 },
  { concurrency: 8, home: 8, discovery: 8 },
  { concurrency: 16, home: 12, discovery: 12 },
];
const visitor = randomUUID();
const intents = ["reflective", "friendship", "mystery"];
const results = [];
const rootHeaders = {
  Authorization: "Bearer " + token,
  "Cache-Control": "no-store",
};
let index = 0;
function hashedIds(payload) {
  return createHash("sha256")
    .update(JSON.stringify((payload.rails || []).flatMap((r) => (r.items || []).map((x) => x.productId))))
    .digest("hex").slice(0, 16);
}
async function one(kind, concurrency) {
  const sequence = ++index;
  const before = performance.now();
  const intentIndex = (sequence - 1) % intents.length;
  let status = 0;
  let colo = "unknown";
  try {
    const discovery = kind === "discovery";
    const response = await fetch(
      origin + (discovery ? "/api/fore/recommendations/discover?visitor=" + visitor : "/"),
      {
        method: discovery ? "POST" : "GET",
        redirect: "manual",
        headers: {
          ...rootHeaders,
          Accept: discovery ? "application/json" : "text/html",
          ...(discovery ? { "Content-Type": "application/json", Origin: origin } : {}),
        },
        ...(discovery
          ? { body: JSON.stringify({ query: intents[intentIndex], limit: 12 }) }
          : {}),
        signal: AbortSignal.timeout(20000),
      },
    );
    status = response.status;
    const ttfbMs = Math.round(performance.now() - before);
    colo = (response.headers.get("cf-ray") || "").match(/-([A-Z]{3})$/)?.[1] || "unknown";
    const raw = await response.text();
    let count = 0, digest = null;
    if (discovery) {
      assert.equal(status, 200, "Non-200 discovery is not an optimization");
      assert.match(response.headers.get("content-type") || "", /application\/json/);
      const payload = JSON.parse(raw);
      assert.equal(payload.version, "cove-discovery-v1");
      assert.ok(Array.isArray(payload.rails));
      assert.ok(payload.rails.every((r) => Array.isArray(r.books) && Array.isArray(r.items)));
      assert.ok(payload.rails.length > 0 || typeof payload.emptyReason === "string");
      count = payload.rails.reduce((n, r) => n + r.books.length, 0);
      digest = hashedIds(payload);
    } else {
      count = validateHtml(status, response.headers.get("content-type") || "", raw);
      assert.ok(count >= 1, "Homepage must contain live-rights-approved cards");
      assert.match(response.headers.get("server-timing") || "",
        /cove_ssr_local_rights;dur=0(?:\.0)?(?:,|$)/,
        "Homepage must use live primary D1 rights, never stale fallback");
    }
    return { sequence, concurrency, kind, intent: discovery ? intents[intentIndex] : null,
      status, ttfbMs, totalMs: Math.round(performance.now() - before),
      count, digest, colo, error: null };
  } catch {
    return { sequence, concurrency, kind, intent: kind === "discovery" ? intents[intentIndex] : null,
      status, ttfbMs: Math.round(performance.now() - before),
      totalMs: null, count: 0, digest: null, colo,
      error: status !== 200 ? "http-status-or-security-check-failed" : "validation-or-request-failed" };
  }
}
for (const wave of waves) {
  // Deterministic 50:50 service mix per wave, with same workload in each cohort.
  const jobs = Array.from({ length: wave.home + wave.discovery },
    (_, i) => i % 2 === 0 ? "home" : "discovery");
  let next = 0;
  const workers = Array.from({ length: Math.min(wave.concurrency, jobs.length) }, async () => {
    while (next < jobs.length) {
      const job = jobs[next++];
      results.push(await one(job, wave.concurrency));
    }
  });
  await Promise.all(workers);
}
const summary = waves.map((w) => Object.fromEntries(
  ["home", "discovery"].map((kind) => {
    const arr = results.filter((r) => r.kind === kind && r.concurrency === w.concurrency);
    const valid = arr.filter((r) => !r.error);
    const t = valid.map((r) => r.ttfbMs);
    const p95Ms = percentile(t, 0.95);
    const maxMs = t.length ? Math.max(...t) : null;
    return [kind, {
      concurrency: w.concurrency, attempted: kind === "home" ? w.home : w.discovery,
      successes: valid.length, errors: arr.length - valid.length,
      p50Ms: percentile(t, 0.5), p95Ms, maxMs,
      colos: [...new Set(valid.map((r) => r.colo))].sort(),
      valid: valid.length === (kind === "home" ? w.home : w.discovery),
      // Discovery requires correctness but has no user-declared 800ms hard SLO.
      pass: valid.length === (kind === "home" ? w.home : w.discovery) &&
        (kind !== "home" || (maxMs !== null && maxMs < 800 && p95Ms !== null && p95Ms <= 650)),
    }];
  }),
));
const report = {
  test: "isolated-stage-mixed-discovery-home-v1",
  note: "Measured response headers only; no authenticated or territorial rights bypass",
  waves,
  summary,
  results: results.sort((a,b) => a.sequence - b.sequence),
  pass: summary.every((wave) => wave.home.pass && wave.discovery.pass),
};
fs.mkdirSync("artifacts", { recursive: true });
fs.writeFileSync("artifacts/cloudflare-mixed-discovery-performance.json", JSON.stringify(report, null, 2));
for (const w of summary) process.stdout.write(
  "Mixed concurrency " + w.home.concurrency + " home max=" + w.home.maxMs +
  "ms, discovery max=" + w.discovery.maxMs + "ms; valid=" + w.home.valid + "/" + w.discovery.valid + "\n");
if (!report.pass) process.exitCode = 1;
