import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import {
  requestedLanguages,
  probeSequence,
  validateHtml,
  percentile,
  safeProbeTelemetry,
  productionOrigin,
} from "./check-production-storefront-performance.mjs";

const origin = productionOrigin(
  process.env.COVE_SSR_STAGING_ORIGIN ||
    "https://cove-storefront-ssr-staging.cove-jibrilmohamud.workers.dev",
);
const token = process.env.COVE_SSR_STAGING_GATE_KEY;
assert.match(token || "", /^[a-f0-9]{64}$/, "Ephemeral staging key required.");

function headers(extra = {}) {
  return { Authorization: "Bearer " + token, ...extra };
}

async function assertProtected() {
  const denied = await fetch(origin + "/", {
    redirect: "manual",
    signal: AbortSignal.timeout(12_000),
  });
  assert.equal(denied.status, 401, "Unauthenticated homepage must not load.");
  const deniedAsset = await fetch(origin + "/assets/not-real.js", {
    redirect: "manual",
    signal: AbortSignal.timeout(12_000),
  });
  assert.equal(deniedAsset.status, 401, "Static assets must not bypass authentication.");
  const deniedMutation = await fetch(origin + "/", {
    method: "POST",
    headers: headers(),
    redirect: "manual",
    signal: AbortSignal.timeout(12_000),
  });
  assert.equal(deniedMutation.status, 405, "Staging must remain read-only.");
}

async function assertRightsIsolation() {
  const endpoint = origin + "/api/fore/storefront/bootstrap";
  const common = { redirect: "manual", signal: AbortSignal.timeout(12_000) };
  const first = await fetch(endpoint, { ...common, headers: headers() });
  assert.equal(first.status, 200, "Trusted Cloudflare country must enable bootstrap.");
  const expected = await first.json();
  assert.match(expected.context.rightsCountry, /^[A-Z]{2}$/);
  assert.ok(expected.catalog.results.length >= 1);
  const forged = await fetch(endpoint, {
    ...common,
    headers: headers({
      "x-cove-client-country": "ZZ",
      "cf-ipcountry": "ZZ",
      "x-vercel-ip-country": "ZZ",
    }),
  });
  assert.equal(forged.status, 200);
  const untrusted = await forged.json();
  assert.equal(
    untrusted.context.rightsCountry,
    expected.context.rightsCountry,
    "Spoofable HTTP country headers cannot change licensed inventory",
  );
  assert.deepEqual(
    untrusted.catalog.results.map((book) => book.productId),
    expected.catalog.results.map((book) => book.productId),
    "Country spoofing cannot alter book eligibility",
  );
}

async function probe(language, sample, sequence) {
  const started = performance.now();
  const response = await fetch(origin + "/", {
    headers: headers({ Accept: "text/html", "Accept-Language": language }),
    redirect: "manual",
    signal: AbortSignal.timeout(15_000),
  });
  const ttfbMs = Math.round(performance.now() - started);
  const html = await response.text();
  const totalMs = Math.round(performance.now() - started);
  const cards = validateHtml(response.status, response.headers.get("content-type") || "", html);
  if (!/no-store/.test(response.headers.get("cache-control") || ""))
    throw new Error("Stage homepage must never be cached.");
  if (!/cove_ssr_local_rights;dur=0/.test(response.headers.get("server-timing") || ""))
    throw new Error("No evidence of in-Worker D1 rights authority.");
  return { language, sample, sequence, cards, ...safeProbeTelemetry(response.headers, ttfbMs, totalMs) };
}

await assertProtected();
await assertRightsIsolation();
const results = [];
const failures = [];
for (const { language, sample, sequence } of probeSequence()) {
  try {
    results.push(await probe(language, sample, sequence));
  } catch (error) {
    failures.push({ sequence, language, sample, error: String(error).slice(0,300) });
  }
}
const allPass =
  failures.length === 0 &&
  results.length === requestedLanguages.length * 4 &&
  results.every((r) => r.ttfbMs < 800 && r.cards >= 1);
const summary = {
  status: allPass ? "pass" : "fail",
  targetMs: 800,
  successes: results.length,
  errors: failures.length,
  slowSamples: results.filter((r) => r.ttfbMs >= 800).length,
  p75: percentile(results.map((r) => r.ttfbMs), 0.75),
  p95: percentile(results.map((r) => r.ttfbMs), 0.95),
  results,
  failures,
};
fs.mkdirSync("artifacts", { recursive: true });
fs.writeFileSync("artifacts/cloudflare-ssr-staging-performance.json", JSON.stringify(summary, null, 2) + "\n");
const table = [
  "## Authenticated Cloudflare-native SSR staging canary",
  "",
  "All requests use a temporary secret; no private visitor or credential fields are retained.",
  "This is synthetic runner TTFB, not a field performance guarantee.",
  "Workers.dev staging is not the production hostname.",
  "",
  "| Sequence | Locale | Sample | TTFB | SSR cards |",
  "| ---: | --- | ---: | ---: | ---: |",
  ...results.map((r) => `| ${r.sequence} | ${r.language} | ${r.sample} | ${r.ttfbMs} ms | ${r.cards} |`),
  "",
  `Result **${summary.status}** — p75 ${summary.p75 ?? "n/a"} ms, p95 ${summary.p95 ?? "n/a"} ms; ${summary.slowSamples} >=800 ms; ${summary.errors} failures.`,
  ...failures.map((r) => `- request ${r.sequence}: ${r.error}`),
].join("\n");
console.log(table);
if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, table + "\n");
if (!allPass) process.exitCode = 1;
