import assert from "node:assert/strict";
import fs from "node:fs";
import { performance } from "node:perf_hooks";
import { stageFetch, stageTransport, closeStageTransport } from "./strangler-http-transport.mjs";

const origin = "https://cove-strangler-m1-staging.cove-jibrilmohamud.workers.dev";
const key = process.env.COVE_STRANGLER_STAGE_KEY || "";
assert.match(key, /^[a-f0-9]{64}$/);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
const maxInflight = 128;
const strictMaximumMs = 800;
const p95MaximumMs = 600;
const p99MaximumMs = 750;
const results = {
  transport: stageTransport,
  mode: process.env.COVE_STRANGLER_MODE || "bursts",
  phases: [],
};

async function requestOne(route = "/") {
  const start = performance.now();
  try {
    const resp = await stageFetch(origin + route, {
      headers: { authorization: "Bearer " + key },
      signal: AbortSignal.timeout(10000),
    });
    const headersAt = performance.now();
    const html = await resp.text();
    const isControl = route === "/__cove_perf/transport";
    const valid =
      resp.status === 200 &&
      resp.headers.get("cache-control")?.includes("no-store") &&
      (isControl
        ? resp.headers.get("x-cove-renderer") === "transport-control" && html === "ok"
        : route === "/"
          ? resp.headers.get("x-cove-renderer") === "strangler-evaluation" &&
            /data-rights-country="[A-Z]{2}"/.test(html) &&
            /data-product="/.test(html)
          : /<html/i.test(html));
    // Browser/runner wall clock includes client and Cloudflare transit.
    // Server-Timing exposes separately measured Worker bootstrap stages.
    const serverTiming = {};
    for (const match of (resp.headers.get("server-timing") || "").matchAll(
      /(cove_[a-z_]+);dur=([0-9]+(?:\.[0-9]+)?)/g,
    ))
      serverTiming[match[1]] = Number(match[2]);
    // Preserve immutable Cloudflare Ray evidence for the slowest requests.
    // Ray IDs identify edge processing without exposing reader identity,
    // request authorization, or page content. All responses still count.
    const ray = resp.headers.get("cf-ray") || "";
    const edgeRay = /^[a-f0-9]{12,32}-[A-Z]{3}$/.test(ray) ? ray : null;
    return {
      ttfbMs: Math.round(headersAt - start),
      valid: Boolean(valid),
      status: resp.status,
      edgeRay,
      serverTiming,
    };
  } catch (error) {
    return {
      ttfbMs: Math.round(performance.now() - start),
      valid: false,
      error: error instanceof Error ? error.name : "unknown",
    };
  }
}
function percentile(values, fraction) {
  if (!values.length) return 0;
  const ordered = [...values].sort((a, b) => a - b);
  return ordered[Math.min(ordered.length - 1, Math.ceil(ordered.length * fraction) - 1)];
}
function report(name, offered, rows, dropped = 0) {
  const valid = rows.filter((row) => row.valid).length;
  const all = rows.map((row) => row.ttfbMs);
  const maxMs = Math.max(0, ...all);
  const p95Ms = percentile(all, 0.95);
  const p99Ms = percentile(all, 0.99);
  // Bursts/cold rounds have an 800 ms hard maximum. The p95/p99 tail
  // requirements belong to the sustained 100-RPS, 2,000-arrival phase.
  const sustained100Rps = name === "100-rps-20s";
  const pass =
    dropped === 0 &&
    rows.length === offered &&
    valid === offered &&
    maxMs < strictMaximumMs &&
    (!sustained100Rps || (p95Ms < p95MaximumMs && p99Ms < p99MaximumMs));
  const observed = rows.filter((row) => Number.isFinite(row.serverTiming?.cove_bootstrap));
  const boot = observed.map((row) => row.serverTiming.cove_bootstrap);
  const catalog = observed
    .map((row) => row.serverTiming.cove_catalog)
    .filter((value) => Number.isFinite(value));
  const residual = observed.map((row) => Math.max(0, row.ttfbMs - row.serverTiming.cove_bootstrap));
  // Retain the *real* five worst samples, not a best-of-N selection or
  // redacted percentile. These provider Ray IDs distinguish slow Worker
  // execution from slow Cloudflare delivery at the exact release boundary.
  const worstSamples = [...rows]
    .sort((a, b) => b.ttfbMs - a.ttfbMs)
    .slice(0, 5)
    .map((row) => ({
      ttfbMs: row.ttfbMs,
      valid: row.valid,
      status: row.status ?? null,
      error: row.error ?? null,
      ray: row.edgeRay ?? null,
      workerMs: Number.isFinite(row.serverTiming?.cove_bootstrap)
        ? row.serverTiming.cove_bootstrap
        : null,
      residualMs: Number.isFinite(row.serverTiming?.cove_bootstrap)
        ? Math.max(0, Math.round(row.ttfbMs - row.serverTiming.cove_bootstrap))
        : null,
    }));
  const output = {
    name,
    offered,
    delivered: rows.length,
    valid,
    dropped,
    p95Ms,
    p99Ms,
    maxMs,
    pass,
    bootstrapSamples: observed.length,
    bootstrapP95Ms: boot.length ? Math.round(percentile(boot, 0.95)) : null,
    bootstrapMaxMs: boot.length ? Math.round(Math.max(...boot)) : null,
    catalogP95Ms: catalog.length ? Math.round(percentile(catalog, 0.95)) : null,
    residualP95Ms: residual.length ? Math.round(percentile(residual, 0.95)) : null,
    residualMaxMs: residual.length ? Math.round(Math.max(...residual)) : null,
    worstSamples,
  };
  results.phases.push(output);
  console.log("COVE_STRANGLER_CAPACITY " + JSON.stringify(output));
  return pass;
}
async function burst(n, name, route = "/") {
  const rows = await Promise.all(Array.from({ length: n }, () => requestOne(route)));
  report(name, n, rows);
}
async function scheduled(rate, seconds, route = "/") {
  const offered = rate * seconds,
    rows = [];
  let dropped = 0;
  const pending = new Set();
  const started = performance.now();
  for (let i = 0; i < offered; i++) {
    await sleep(started + (i * 1000) / rate - performance.now());
    if (pending.size >= maxInflight) {
      dropped++;
      continue;
    }
    const task = requestOne(route);
    pending.add(task);
    task.then((result) => rows.push(result)).finally(() => pending.delete(task));
  }
  await Promise.allSettled([...pending]);
  report(
    (route === "/" ? "" : "transport-") + rate + "-rps-" + seconds + "s",
    offered,
    rows,
    dropped,
  );
}
try {
  if (results.mode === "cold") {
    const rows = [];
    for (let i = 0; i < 20; i++) rows.push(await requestOne());
    report("new-deployment-cold-20", 20, rows);
  } else {
    for (const size of [1, 4, 8, 16, 32]) await burst(size, size + "-concurrent");
    for (const rate of [25, 50, 100]) await scheduled(rate, rate === 100 ? 20 : 10);
    await burst(32, "transport-control-32", "/__cove_perf/transport");
    await scheduled(25, 10, "/__cove_perf/transport");
    // Additional protected authentic application path. This isn't a
    // complete checkout/reader/payment or UI parity certification.
    const core = await requestOne("/?storefront=full");
    report("real-core-delegation", 1, [core]);
  }
} finally {
  closeStageTransport();
  fs.mkdirSync("artifacts", { recursive: true });
  fs.writeFileSync(
    "artifacts/strangler-" + results.mode + "-" + results.transport + ".json",
    JSON.stringify(results, null, 2),
  );
}
if (!results.phases.every((phase) => phase.pass)) process.exitCode = 1;
