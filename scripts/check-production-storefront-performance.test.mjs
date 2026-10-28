import assert from "node:assert/strict";
import test from "node:test";

import {
  evaluateProbes,
  percentile,
  probeHomepage,
  probeSequence,
  productionOrigin,
  requestedLanguages,
  safeProbeTelemetry,
  safeCloudflareRay,
  strictTtfbTargetMs,
  validateHtml,
  visibleServerBookCount,
} from "./check-production-storefront-performance.mjs";

test("production probe rejects untrusted origins and accepts only the site root", () => {
  assert.equal(productionOrigin("https://cove.example/"), "https://cove.example");
  for (const origin of [
    "http://cove.example/",
    "https://cove.example/deals",
    "https://cove.example/?q=secret",
    "https://person:password@cove.example/",
  ])
    assert.throws(() => productionOrigin(origin));
});

test("SSR must include actual book cards, a 200 response, and HTML content type", () => {
  const html = '<article class="book-card"></article><article class="book-card"></article>';
  assert.equal(visibleServerBookCount(html), 2);
  assert.equal(validateHtml(200, "text/html; charset=utf-8", html), 2);
  assert.throws(() => validateHtml(503, "text/html", html), /503/);
  assert.throws(() => validateHtml(200, "application/json", html), /non-HTML/);
  assert.throws(
    () => validateHtml(200, "text/html", "<main>Finding books</main>"),
    /no server-rendered/,
  );
});

test("latency percentiles are deterministic and do not mutate inputs", () => {
  const values = [2500, 100, 1250, 500];
  assert.equal(percentile(values, 0.5), 500);
  assert.equal(percentile(values, 0.75), 1250);
  assert.equal(percentile(values, 0.95), 2500);
  assert.deepEqual(values, [2500, 100, 1250, 500]);
  assert.equal(percentile([], 0.75), null);
});

test("all supported locales must satisfy strict 800 ms on every sample", () => {
  assert.equal(strictTtfbTargetMs, 800);
  assert.equal(requestedLanguages.length, 5);
  const samples = requestedLanguages.flatMap((language) =>
    [250, 375, 550, 799].map((ttfbMs, index) => ({ language, sample: index + 1, ttfbMs })),
  );
  const good = evaluateProbes(samples, []);
  assert.equal(good.status, "pass");
  assert.equal(good.slowSamples, 0);
  for (const threshold of [800, 801, 4000, 7000]) {
    const bad = evaluateProbes(
      samples.map((s, i) => (i === 0 ? { ...s, ttfbMs: threshold } : s)),
      [],
    );
    assert.equal(bad.status, "fail", "one slow sample in any language fails");
    assert.equal(bad.slowSamples, 1);
  }
  for (const index of [0, 4, 8, 12, 16]) {
    assert.equal(
      evaluateProbes(
        samples.filter((_, i) => i !== index),
        [],
      ).status,
      "fail",
      "every requested language and sample must be present",
    );
  }
  assert.equal(
    evaluateProbes(samples, [{ language: requestedLanguages[0], sample: 1, error: "503" }]).status,
    "fail",
  );
  assert.equal(evaluateProbes(samples.slice(0, 4), []).status, "fail");
  assert.equal(
    evaluateProbes(
      samples.map((item, i) => (i === 0 ? { ...item, sample: 2 } : item)),
      [],
    ).status,
    "fail",
    "Duplicate locale/sample pairs cannot mask a missing sample",
  );
});

test("failure diagnostics retain only aggregate numeric timings and safe cache labels", () => {
  const telemetry = safeProbeTelemetry(
    new Headers({
      "Server-Timing":
        "cove_entry;dur=12.3, cove_render;dur=1712, exotic;desc=cookie.secret, cove_total;dur=1743.2",
      "X-Vercel-Cache": "MISS",
    }),
    1900,
    1920,
  );
  assert.deepEqual(telemetry, {
    ttfbMs: 1900,
    totalMs: 1920,
    timing: "cove_entry;dur=12.3, cove_render;dur=1712, cove_total;dur=1743.2",
    vercelCache: "MISS",
  });
  assert.deepEqual(
    safeProbeTelemetry(
      new Headers({ "Server-Timing": "cove_foo;dur=11;desc=token", "X-Vercel-Cache": "secrets" }),
      250,
      260,
    ),
    { ttfbMs: 250, totalMs: 260, timing: "", vercelCache: "unknown" },
  );
});

test("Cloudflare request Ray identifiers are tightly validated before provider logging", () => {
  const safe = "a518d36158d88596-MSP";
  assert.equal(safeCloudflareRay(new Headers({ "CF-Ray": safe })), safe);
  for (const value of [
    "", "Ray #123", "not-a-ray-MSP", "a518d36158d88596-abc",
    "a518d36158d88596-MSP\\r\\nSet-Cookie: session=leak",
    "a518d36158d88596-MSP,session=leak",
    "a518d36158d88596-IAD/secret",
    "a518d36158d88596-MSP" + "a".repeat(500),
  ]) {
    assert.equal(safeCloudflareRay(new Headers({ "cf-ray": value })), null);
  }
  assert.equal(safeCloudflareRay(new Headers({ "set-cookie": "private=secret" })), null);
});

test("D1 counters retain bounded numeric attempt and row counts without treating them as time", () => {
  const result = safeProbeTelemetry(
    new Headers({
      "server-timing":
        'cove_backend_catalog_attempts;desc="3", cove_backend_catalog_rows;desc="1024", cove_backend_catalog_attempts;desc="999", cove_backend_catalog_rows;desc="private"',
    }),
    900,
    920,
  );
  assert.equal(result.d1CatalogAttempts, 3);
  assert.equal(result.d1CatalogRowsRead, 1024);
  assert.equal(result.timing, "");
  assert.equal(JSON.stringify(result).includes("private"), false);
});

// A successful cold response must be as diagnosable as a failed response,
// without persisting arbitrary response headers, cookies or visitor context.
test("successful homepage probes retain only numeric phases and a safe cache label", async () => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response('<article class="book-card"></article>', {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "private, no-store",
        "Server-Timing": "cove_ssr_bootstrap;dur=1342.5, leak;desc=secret, cove_total;dur=1350",
        "X-Vercel-Cache": "MISS",
        "Set-Cookie": "session=private",
      },
    });
  try {
    const result = await probeHomepage("https://cove.example", "en-US,en;q=0.9", 1);
    assert.equal(result.cards, 1);
    assert.equal(result.vercelCache, "MISS");
    assert.equal(result.timing, "cove_ssr_bootstrap;dur=1342.5, cove_total;dur=1350");
    assert.equal(Object.keys(result).includes("headers"), false);
    assert.equal(JSON.stringify(result).includes("secret"), false);
    assert.equal(JSON.stringify(result).includes("session"), false);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("production probe interleaves locales without losing or repeating samples", () => {
  const order = probeSequence();
  assert.equal(order.length, 20);
  assert.equal(new Set(order.map((row) => `${row.language}|${row.sample}`)).size, 20);
  assert.deepEqual(
    order.map((row) => row.sequence),
    Array.from({ length: 20 }, (_, i) => i + 1),
  );
  assert.deepEqual(
    [1, 2, 3, 4].map((sample) => order.find((row) => row.sample === sample)?.language),
    [requestedLanguages[0], requestedLanguages[2], requestedLanguages[4], requestedLanguages[1]],
    "Cold first request is not permanently associated with the English locale",
  );
});
