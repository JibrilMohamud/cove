import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";

const requestedLanguages = ["en-US,en;q=0.9", "fr-FR,fr;q=0.9", "de-DE,de;q=0.9"];

export function productionOrigin(value) {
  const url = new URL(value);
  assert.equal(url.protocol, "https:", "The production probe requires HTTPS.");
  assert.equal(url.username, "", "Credentials must not be in the probe URL.");
  assert.equal(url.password, "", "Credentials must not be in the probe URL.");
  assert.equal(url.pathname, "/", "Probe URLs must target the site origin.");
  assert.equal(url.search, "", "Probe URLs cannot contain query parameters.");
  assert.equal(url.hash, "", "Probe URLs cannot contain fragments.");
  return url.origin;
}

export function percentile(values, fraction) {
  if (!values.length) return null;
  assert.ok(fraction > 0 && fraction <= 1);
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(sorted.length * fraction) - 1];
}

export function visibleServerBookCount(html) {
  return (html.match(/class=["']book-card["']/g) || []).length;
}

export function validateHtml(status, contentType, html) {
  if (status !== 200) throw new Error("Unexpected HTTP status: " + status);
  if (!contentType.toLowerCase().includes("text/html"))
    throw new Error("Homepage returned a non-HTML content type.");
  if (html.length > 4_000_000) throw new Error("Homepage HTML exceeded the safety limit.");
  const cards = visibleServerBookCount(html);
  if (cards < 1) throw new Error("Homepage had no server-rendered book cards.");
  return cards;
}

export async function probeHomepage(origin, language, sample) {
  const started = performance.now();
  const response = await fetch(origin + "/", {
    method: "GET",
    headers: {
      Accept: "text/html",
      "Accept-Language": language,
    },
    redirect: "manual",
    signal: AbortSignal.timeout(15_000),
  });
  const ttfbMs = Math.round(performance.now() - started);
  if (response.status !== 200) throw new Error("Unexpected HTTP status: " + response.status);
  const html = await response.text();
  const totalMs = Math.round(performance.now() - started);
  const cards = validateHtml(response.status, response.headers.get("content-type") || "", html);
  if (!/\bno-store\b/i.test(response.headers.get("cache-control") || ""))
    throw new Error("Personalized storefront HTML was not marked no-store.");
  return {
    language,
    sample,
    ttfbMs,
    totalMs,
    cards,
    bytes: Buffer.byteLength(html),
  };
}

export function evaluateProbes(results, failures) {
  const ttfb = results.map((result) => result.ttfbMs);
  const p75 = percentile(ttfb, 0.75);
  const p95 = percentile(ttfb, 0.95);
  const missingLanguage = requestedLanguages.some(
    (language) => !results.some((result) => result.language === language),
  );
  const invalidResponse = failures.some((failure) =>
    /no server-rendered book cards|non-HTML content type|exceeded the safety limit|not marked no-store/.test(
      failure.error,
    ),
  );
  const hardFailure =
    results.length < 4 || missingLanguage || invalidResponse || (p75 !== null && p75 > 6_000);
  return {
    p75,
    p95,
    failures: failures.length,
    status: hardFailure ? "fail" : p75 !== null && p75 > 2_500 ? "warn" : "pass",
  };
}

async function main() {
  const origin = productionOrigin(
    process.env.COVE_PUBLIC_URL || "https://cove-puce-theta.vercel.app",
  );
  const results = [];
  const failures = [];
  for (const language of requestedLanguages) {
    for (let sample = 1; sample <= 2; sample += 1) {
      try {
        results.push(await probeHomepage(origin, language, sample));
      } catch (error) {
        failures.push({ language, sample, error: String(error) });
      }
    }
  }
  const assessment = evaluateProbes(results, failures);
  const report = {
    observedAt: new Date().toISOString(),
    origin,
    note: "Synthetic runner TTFB is not field Core Web Vitals or a cold-cache guarantee.",
    assessment,
    results,
    failures,
  };
  const artifactPath = path.join("artifacts", "production-storefront-performance.json");
  fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
  fs.writeFileSync(artifactPath, JSON.stringify(report, null, 2) + "\n");

  const lines = [
    "## Production Bookstore performance canary",
    "",
    "This measures synthetic runner time to first response byte, not field LCP/INP/CLS.",
    "The request does not forge a storefront rights territory or read customer data.",
    "",
    "| Language request | Sample | TTFB | Total HTML | SSR books |",
    "| --- | ---: | ---: | ---: | ---: |",
    ...results.map(
      (r) => `| ${r.language} | ${r.sample} | ${r.ttfbMs} ms | ${r.totalMs} ms | ${r.cards} |`,
    ),
    "",
    `Result: **${assessment.status}** — TTFB p75 ${assessment.p75 ?? "n/a"} ms, p95 ${assessment.p95 ?? "n/a"} ms; ${failures.length} errors.`,
    ...failures.map((f) => `- ${f.language}, sample ${f.sample}: ${f.error}`),
  ];
  if (process.env.GITHUB_STEP_SUMMARY)
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join("\n") + "\n");
  console.log(lines.join("\n"));
  if (assessment.status === "warn")
    console.warn("Cove public homepage is above its 2.5-second synthetic warning budget.");
  if (assessment.status === "fail") process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === new URL("file://" + path.resolve(process.argv[1])).href)
  await main();
