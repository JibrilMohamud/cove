import assert from "node:assert/strict";
import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";
import {
  percentile,
  safeCloudflareRay,
  validateHtml,
} from "../check-production-storefront-performance.mjs";

const origin = "https://ssr-canary.covereads.com";
const concurrencyLevels = [1, 4, 8, 16, 32];
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));

// A failure, missing response or late scheduler arrival is retained and fails
// the phase. Percentiles never filter down to successful/favorable requests.
export function summarizeOwnedPhase(name, offered, rows, dropped = 0, sustained = false) {
  const times = rows.map((row) => row.ttfbMs);
  const valid = rows.filter((row) => row.valid).length;
  const maxMs = times.length ? Math.max(...times) : null;
  const p95Ms = percentile(times, 0.95);
  const p99Ms = percentile(times, 0.99);
  const lateArrivals = rows.filter((row) => row.launchDelayMs >= 100).length;
  return {
    name,
    offered,
    responses: rows.length,
    valid,
    dropped,
    lateArrivals,
    p95Ms,
    p99Ms,
    maxMs,
    colos: [...new Set(rows.map((row) => row.colo).filter(Boolean))].sort(),
    pass:
      offered > 0 &&
      rows.length === offered &&
      valid === offered &&
      dropped === 0 &&
      lateArrivals === 0 &&
      maxMs !== null &&
      maxMs < 800 &&
      (!sustained || (p95Ms !== null && p95Ms < 600 && p99Ms !== null && p99Ms < 750)),
    rows,
  };
}

async function main() {
  assert.equal(
    process.env.COVE_SSR_STAGING_ORIGIN,
    origin,
    "Only the protected ephemeral owned canary may receive this load campaign",
  );
  const key = process.env.COVE_SSR_STAGING_GATE_KEY;
  assert.match(key || "", /^[a-f0-9]{64}$/, "Ephemeral canary bearer missing");
  const mode = process.env.COVE_OWNED_CAPACITY_MODE || "warm";
  assert.ok(["cold-burst", "warm"].includes(mode));
  const coldConcurrency = Number(process.env.COVE_OWNED_COLD_CONCURRENCY || 0);
  if (mode === "cold-burst") assert.ok(concurrencyLevels.includes(coldConcurrency));
  const phases = [];
  const startedAt = new Date().toISOString();

  async function requestOne(ordinal, scheduledAt) {
    const launchedAt = performance.now();
    const launchDelayMs = Math.max(0, launchedAt - scheduledAt);
    let status = 0;
    let ttfbMs = 0;
    let edgeRay = null;
    let serverTiming = {};
    try {
      const response = await fetch(origin + "/", {
        method: "GET",
        redirect: "manual",
        cache: "no-store",
        headers: {
          authorization: "Bearer " + key,
          accept: "text/html",
          "accept-language": "en-US,en;q=0.9",
          "cache-control": "no-store",
        },
        signal: AbortSignal.timeout(15000),
      });
      ttfbMs = performance.now() - scheduledAt;
      status = response.status;
      edgeRay = safeCloudflareRay(response.headers);
      for (const match of (response.headers.get("server-timing") || "").matchAll(
        /\b(cove_[a-z_]+);dur=([0-9]+(?:\.[0-9]+)?)/g,
      ))
        serverTiming[match[1]] = Number(match[2]);
      const html = await response.text();
      const cards = validateHtml(status, response.headers.get("content-type") || "", html);
      assert.ok(cards > 0, "Full native SSR cards required");
      assert.match(response.headers.get("cache-control") || "", /no-store/);
      assert.match(
        response.headers.get("server-timing") || "",
        /cove_ssr_local_rights;dur=0/,
        "Every request must execute the real primary legal-rights path",
      );
      return {
        ordinal,
        status,
        valid: true,
        cards,
        ttfbMs,
        launchDelayMs,
        totalMs: performance.now() - scheduledAt,
        edgeRay,
        colo: edgeRay?.split("-")[1] || null,
        serverTiming,
      };
    } catch {
      return {
        ordinal,
        status,
        valid: false,
        cards: 0,
        ttfbMs: ttfbMs || performance.now() - scheduledAt,
        launchDelayMs,
        totalMs: performance.now() - scheduledAt,
        edgeRay,
        colo: edgeRay?.split("-")[1] || null,
        serverTiming,
        error: status ? "invalid-http-or-rights-response" : "request-failed",
      };
    }
  }
  async function burst(size, temperature) {
    const started = performance.now();
    const rows = await Promise.all(
      Array.from({ length: size }, (_, index) => requestOne(index + 1, started)),
    );
    phases.push(summarizeOwnedPhase(`${temperature}-${size}-concurrent`, size, rows));
  }
  async function sustained(phase) {
    const rows = [],
      pending = new Set();
    const started = performance.now();
    let dropped = 0;
    for (let index = 0; index < 2000; index++) {
      const scheduledAt = started + index * 10;
      await wait(scheduledAt - performance.now());
      if (pending.size >= 128) {
        dropped++;
        continue;
      }
      const task = requestOne(index + 1, scheduledAt);
      pending.add(task);
      task.then((row) => rows.push(row)).finally(() => pending.delete(task));
    }
    await Promise.allSettled([...pending]);
    rows.sort((a, b) => a.ordinal - b.ordinal);
    phases.push(summarizeOwnedPhase(`100-rps-20s-phase-${phase}`, 2000, rows, dropped, true));
  }
  try {
    if (mode === "cold-burst") {
      // The workflow rotates BOTH private Worker secrets and settles their
      // control-plane deployments immediately before this sole burst. No HTTP
      // readiness or first-page warm-up request may precede it.
      await burst(coldConcurrency, "cold");
    } else {
      for (const size of concurrencyLevels) await burst(size, "warm");
      await sustained(1);
      await sustained(2);
    }
  } finally {
    const passed = phases.length === (mode === "cold-burst" ? 1 : 7) && phases.every((p) => p.pass);
    const output = {
      schema: "cove.owned-native-ssr-capacity.v1",
      startedAt,
      completedAt: new Date().toISOString(),
      sha: process.env.GITHUB_SHA || null,
      runId: process.env.GITHUB_RUN_ID || null,
      mode,
      origin,
      transport: "node-fetch",
      maxInflight: 128,
      thresholds: { maxTtfbMs: 800, p95Ms: 600, p99Ms: 750 },
      geographyCertified: false,
      productionRoutingChanged: false,
      passed,
      phases,
    };
    fs.mkdirSync("artifacts", { recursive: true });
    const suffix = mode === "cold-burst" ? `-cold-${coldConcurrency}` : "";
    fs.writeFileSync(
      `artifacts/owned-ssr-capacity-performance${suffix}.json`,
      JSON.stringify(output, null, 2) + "\n",
    );
    const summary = phases.map(({ rows, ...values }) => values);
    console.log(JSON.stringify({ passed, mode, phases: summary }));
    if (process.env.GITHUB_STEP_SUMMARY)
      fs.appendFileSync(
        process.env.GITHUB_STEP_SUMMARY,
        `\nOwned native SSR ${mode}: **${passed ? "PASS" : "FAIL"}**. All samples preserved; geography is not certified.\n\n` +
          "| Phase | Offered | Valid | Drops | Late arrivals | p95 ms | p99 ms | Max ms | Gate |\n" +
          "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |\n" +
          summary
            .map(
              (p) =>
                `| ${p.name} | ${p.offered} | ${p.valid} | ${p.dropped} | ${p.lateArrivals} | ${p.p95Ms?.toFixed(1)} | ${p.p99Ms?.toFixed(1)} | ${p.maxMs?.toFixed(1)} | ${p.pass ? "PASS" : "FAIL"} |`,
            )
            .join("\n") +
          "\n",
      );
    if (!passed) process.exitCode = 1;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
