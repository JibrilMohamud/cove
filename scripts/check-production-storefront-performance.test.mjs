import assert from "node:assert/strict";
import test from "node:test";

import {
  evaluateProbes,
  percentile,
  productionOrigin,
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
  assert.throws(() => validateHtml(200, "text/html", "<main>Finding books</main>"), /no server-rendered/);
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
  const samples = languages.flatMap((language) => [
    { language, ttfbMs: 1100 },
    { language, ttfbMs: 1400 },
  ]);
  assert.equal(evaluateProbes(samples, []).status, "pass");
  assert.equal(
    evaluateProbes(samples.map((s) => ({ ...s, ttfbMs: 3500 })), []).status,
    "warn",
  );
  assert.equal(
    evaluateProbes(samples.map((s) => ({ ...s, ttfbMs: 8000 })), []).status,
    "fail",
  );
  assert.equal(evaluateProbes(samples.slice(0, 4), []).status, "fail");
  assert.equal(
    evaluateProbes(samples, [
      { language: languages[0], sample: 1, error: "Homepage had no server-rendered book cards." },
    ]).status,
    "fail",
  );
});
