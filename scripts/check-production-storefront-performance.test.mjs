import assert from "node:assert/strict";
import test from "node:test";

import {
  evaluateProbes,
  percentile,
  probeHomepage,
  productionOrigin,
  safeProbeTelemetry,
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

test("a degraded cold storefront warns and sustained bad TTFB fails", () => {
  const languages = ["en-US,en;q=0.9", "fr-FR,fr;q=0.9", "de-DE,de;q=0.9"];
  const samples = languages.flatMap((language) =>
    [1100, 1400, 1200, 1300].map((ttfbMs) => ({ language, ttfbMs })),
  );
  assert.equal(evaluateProbes(samples, []).status, "pass");
  assert.equal(
    evaluateProbes(
      samples.map((s) => ({ ...s, ttfbMs: 3500 })),
      [],
    ).status,
    "warn",
  );
  assert.equal(
    evaluateProbes(
      samples.map((s) => ({ ...s, ttfbMs: 8000 })),
      [],
    ).status,
    "fail",
  );
  assert.equal(evaluateProbes(samples.slice(0, 4), []).status, "fail");
  assert.equal(
    evaluateProbes(
      samples.map((s, i) => ({ ...s, ttfbMs: i === 0 ? 7000 : s.ttfbMs })),
      [],
    ).status,
    "fail",
    "One severe cold response exceeds the p95 reliability budget",
  );
  assert.equal(
    evaluateProbes(
      samples.map((s, i) => ({ ...s, ttfbMs: i === 0 ? 4000 : s.ttfbMs })),
      [],
    ).status,
    "warn",
    "One slow but valid response should warn rather than silently pass",
  );
  for (const error of [
    "Error: Request timed out after 15 seconds",
    "Error: Unexpected HTTP status: 503",
    "AbortError: this operation was aborted",
  ]) {
    assert.equal(
      evaluateProbes(samples.slice(1), [{ language: languages[0], sample: 1, error }]).status,
      "fail",
      "Any failed sample invalidates the synthetic availability result",
    );
  }
  for (const error of [
    "Homepage had no server-rendered book cards.",
    "Homepage returned a non-HTML content type.",
    "Personalized storefront HTML was not marked no-store.",
  ]) {
    assert.equal(
      evaluateProbes(samples, [{ language: languages[0], sample: 1, error }]).status,
      "fail",
    );
  }
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
