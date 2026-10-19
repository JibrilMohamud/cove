// Authenticated, read-only temporary Worker traffic: actual product detail
// (including primary-D1 channel checks) interleaved with licensed homepage SSR.
// No mutation, identity, response bodies or product IDs leave the runner.
import assert from "node:assert/strict";
import fs from "node:fs";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import {
  percentile,
  productionOrigin,
  validateHtml,
} from "../check-production-storefront-performance.mjs";

const origin = productionOrigin(process.env.COVE_SSR_STAGING_ORIGIN);
const token = process.env.COVE_SSR_STAGING_GATE_KEY;
assert.match(token || "", /^[a-f0-9]{64}$/);
assert.match(origin, /-staging\.[a-z0-9.-]+\.workers\.dev$/);
const headers = {
  Authorization: "Bearer " + token,
  "Cache-Control": "no-store",
};
const initial = await fetch(origin + "/api/fore/storefront/bootstrap", {
  headers: { ...headers, Accept: "application/json" },
  redirect: "manual",
  signal: AbortSignal.timeout(20000),
});
assert.equal(initial.status, 200);
assert.match(initial.headers.get("content-type") || "", /application\/json/);
const start = await initial.json();
assert.ok(Array.isArray(start.catalog?.results) && start.catalog.results.length >= 3);
const ids = [...new Set(start.catalog.results.map((r) => String(r.productId || "")).filter(Boolean))].slice(0, 3);
assert.equal(ids.length, 3, "Must test exactly three distinct rights-cleared products");
const cohortProductsSha256 = createHash("sha256").update(ids.join(",")).digest("hex");
const waves = [
  { concurrency: 1, count: 8 },
  { concurrency: 4, count: 12 },
  { concurrency: 8, count: 16 },
  { concurrency: 16, count: 24 },
];
const results = [];
let sequence = 0;
async function probe(kind, concurrency) {
  const seq = ++sequence;
  const before = performance.now();
  const url =
    kind === "home"
      ? origin + "/"
      : origin + "/api/fore/products/" + encodeURIComponent(ids[(seq - 1) % ids.length]) + "/detail";
  let status = 0;
  let colo = "unknown";
  try {
    const response = await fetch(url, {
      headers: { ...headers, Accept: kind === "home" ? "text/html" : "application/json" },
      redirect: "manual",
      signal: AbortSignal.timeout(20000),
    });
    status = response.status;
    const ttfbMs = Math.round(performance.now() - before);
    colo = (response.headers.get("cf-ray") || "").match(/-([A-Z]{3})$/)?.[1] || "unknown";
    const body = await response.text();
    if (kind === "home") {
      assert.ok(validateHtml(status, response.headers.get("content-type") || "", body) >= 1);
      assert.match(
        response.headers.get("server-timing") || "",
        /cove_ssr_local_rights;dur=0(?:\.0)?(?:,|$)/,
      );
    } else {
      assert.equal(status, 200);
      assert.match(response.headers.get("content-type") || "", /application\/json/);
      const payload = JSON.parse(body);
      assert.ok(payload.book?.productId);
      assert.equal(typeof payload.book.subscriptionEligible, "boolean");
      assert.equal(typeof payload.book.libraryEligible, "boolean");
      assert.ok(payload.commerce?.rights?.allowed, "Book detail must reverify live retail rights");
    }
    return { seq, kind, concurrency, status, ttfbMs, colo, valid: true };
  } catch {
    return {
      seq,
      kind,
      concurrency,
      status,
      ttfbMs: Math.round(performance.now() - before),
      colo,
      valid: false,
    };
  }
}
for (const wave of waves) {
  const work = Array.from({ length: wave.count }, (_, i) => (i % 2 ? "detail" : "home"));
  let cursor = 0;
  await Promise.all(
    Array.from({ length: wave.concurrency }, async () => {
      while (cursor < work.length) {
        const kind = work[cursor++];
        results.push(await probe(kind, wave.concurrency));
      }
    }),
  );
}
const summary = waves.map((wave) => {
  const group = {};
  for (const kind of ["home", "detail"]) {
    const rows = results.filter((r) => r.concurrency === wave.concurrency && r.kind === kind);
    const valid = rows.filter((r) => r.valid);
    const times = valid.map((r) => r.ttfbMs);
    const maximum = times.length ? Math.max(...times) : null;
    const p95 = percentile(times, 0.95);
    group[kind] = {
      attempted: rows.length,
      successes: valid.length,
      maxMs: maximum,
      p95Ms: p95,
      colos: [...new Set(valid.map((r) => r.colo))].sort(),
      pass:
        valid.length === wave.count / 2 &&
        (kind === "detail" || (maximum !== null && maximum < 800 && p95 <= 650)),
    };
  }
  return { concurrency: wave.concurrency, ...group };
});
const report = {
  test: "protected-mixed-product-detail-home-v1",
  cohortProductsSha256,
  waves,
  summary,
  results: results.sort((a, b) => a.seq - b.seq),
  pass: summary.every((wave) => wave.home.pass && wave.detail.pass),
};
fs.mkdirSync("artifacts", { recursive: true });
fs.writeFileSync(
  "artifacts/cloudflare-product-detail-mixed-performance.json",
  JSON.stringify(report, null, 2),
);
for (const wave of summary) process.stdout.write(JSON.stringify(wave) + "\n");
if (!report.pass) process.exitCode = 1;
