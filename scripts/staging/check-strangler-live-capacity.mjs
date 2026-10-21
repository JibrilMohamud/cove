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
const p95MaximumMs = 650;
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
    const valid =
      resp.status === 200 &&
      resp.headers.get("cache-control")?.includes("no-store") &&
      (route === "/"
        ? resp.headers.get("x-cove-renderer") === "strangler-evaluation" &&
          /data-rights-country="[A-Z]{2}"/.test(html) &&
          /data-product="/.test(html)
        : /<html/i.test(html));
    return {
      ttfbMs: Math.round(headersAt - start),
      valid: Boolean(valid),
      status: resp.status,
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
  const pass =
    dropped === 0 &&
    rows.length === offered &&
    valid === offered &&
    maxMs < strictMaximumMs &&
    p95Ms < p95MaximumMs;
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
  };
  results.phases.push(output);
  console.log("COVE_STRANGLER_CAPACITY " + JSON.stringify(output));
  return pass;
}
async function burst(n, name) {
  const rows = await Promise.all(Array.from({ length: n }, () => requestOne()));
  report(name, n, rows);
}
async function scheduled(rate, seconds) {
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
    const task = requestOne();
    pending.add(task);
    task.then((result) => rows.push(result)).finally(() => pending.delete(task));
  }
  await Promise.allSettled([...pending]);
  report(rate + "-rps-10s", offered, rows, dropped);
}
try {
  if (results.mode === "cold") {
    const rows = [];
    for (let i = 0; i < 20; i++) rows.push(await requestOne());
    report("new-deployment-cold-20", 20, rows);
  } else {
    for (const size of [1, 4, 8, 16, 32]) await burst(size, size + "-concurrent");
    for (const rate of [25, 50, 100]) await scheduled(rate, 10);
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
