import assert from "node:assert/strict";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import { validateHtml } from "../check-production-storefront-performance.mjs";
import { stageFetch, closeStageTransport } from "./stage-http-transport.mjs";

const account = "d26430caa63ec55f6612e32f36aca5e9";
const worker = "cove-commercial-parity-ssr-staging-20261020";
const origin = "https://" + worker + ".cove-jibrilmohamud.workers.dev";
const gate = process.env.COVE_SSR_STAGING_GATE_KEY;
const admin = process.env.CLOUDFLARE_API_TOKEN;
assert.match(gate || "", /^[a-f0-9]{64}$/);
assert.ok(admin?.length > 24);
assert.equal(process.env.COVE_STAGE_EXPERIMENT_ARM, "one-read");
const headers = {
  Authorization: "Bearer " + gate,
  "Accept-Encoding": "br, gzip, deflate",
  "Cache-Control": "no-store",
};
async function probe() {
  const started = performance.now();
  const response = await stageFetch(origin + "/", {
    headers,
    redirect: "error",
    signal: AbortSignal.timeout(15000),
  });
  const ttfbMs = performance.now() - started;
  const text = await response.text();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-cove-stage-context-mode"), "one-read");
  assert.match(response.headers.get("cache-control") || "", /no-store/);
  assert.ok(validateHtml(response.status, response.headers.get("content-type") || "", text));
  return { valid: true, ttfbMs: Math.round(ttfbMs) };
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
const rows = [];
let offered = 0;
let dropped = 0;
async function drive() {
  const pending = new Set();
  const launch = () => {
    offered++;
    if (pending.size >= 64) {
      dropped++;
      return;
    }
    const task = probe().then(
      (result) => rows.push(result),
      () => rows.push({ valid: false }),
    );
    pending.add(task);
    void task.finally(() => pending.delete(task));
  };
  const started = performance.now();
  for (let index = 0; index < 320; index++) {
    await sleep(started + (index * 1000) / 20 - performance.now());
    if (index === 80 || index === 200) {
      for (let burst = 0; burst < 32; burst++) launch();
    }
    launch();
  }
  await Promise.all([...pending]);
}
async function capture() {
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${account}/workers/workers/${worker}/versions/latest-deployed/profile`,
    {
      method: "POST",
      headers: { Authorization: "Bearer " + admin, "Content-Type": "application/json" },
      body: JSON.stringify({ duration_ms: 12000, profile_type: "cpu" }),
      redirect: "error",
      signal: AbortSignal.timeout(30000),
    },
  );
  if (!response.ok) {
    let code = "unknown";
    try {
      code = String((await response.json()).errors?.[0]?.code || "unknown");
    } catch {}
    throw new Error("Cloudflare CPU capture failed: HTTP " + response.status + ", code " + code);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.ok(bytes.length > 100 && bytes.length < 32 * 1024 * 1024);
  assert.notEqual(bytes[0], 123, "A JSON error must not be treated as a CPU profile");
  fs.writeFileSync("artifacts/commercial-parity-cpu.pprof", bytes);
  return bytes.length;
}
fs.mkdirSync("artifacts", { recursive: true });
const report = {
  scope: "Actual hosted CPU capture; isolated synthetic stage; no production, customers or writers",
  workerClock: "Cloudflare in-Worker clocks advance on I/O and do not measure CPU-only execution",
  driver:
    "20 RPS for 16 seconds plus two 32-request bursts; at most 64 in flight; attribution only",
  boundary: "After measured HTTP/browser comparison; attribution only; not a capacity gate",
  commercialCertified: false,
};
try {
  // Capture selects a recently active isolate. Warm the intended code path
  // before capture, then keep it busy throughout the profile's eight seconds.
  for (let index = 0; index < 3; index++) await probe();
  const results = await Promise.allSettled([capture(), drive()]);
  report.offered = offered;
  report.completed = rows.length;
  report.dropped = dropped;
  report.valid = rows.filter((row) => row.valid).length;
  report.profileCaptured = results[0].status === "fulfilled";
  if (report.profileCaptured) report.profileBytes = results[0].value;
  else report.profileError = String(results[0].reason?.message || "Capture unavailable");
  assert.equal(report.valid, offered, "Profile traffic must exercise real authorized HTML");
  assert.equal(report.profileCaptured, true, report.profileError);
  const summary = spawnSync(
    "go",
    ["tool", "pprof", "-top", "-nodecount=40", "-unit=ms", "artifacts/commercial-parity-cpu.pprof"],
    { encoding: "utf8" },
  );
  assert.equal(summary.status, 0, "Cannot decode deployed CPU profile");
  const top = summary.stdout;
  fs.writeFileSync("artifacts/commercial-parity-cpu-top.txt", top);
  console.log(top);
  const frames = top
    .split("\n")
    .map((line) => /^\s*\S+\s+[\d.]+%\s+[\d.]+%\s+\S+\s+[\d.]+%\s+(.+)$/.exec(line)?.[1])
    .filter((name) => name && !/^\((?:root|idle|program|garbage collector|external)\)$/.test(name));
  report.callableFrames = frames.length;
  report.profileUseful = frames.length > 0;
  assert.equal(
    report.profileUseful,
    true,
    "A profile without function stacks cannot establish request CPU attribution",
  );
} finally {
  closeStageTransport();
  fs.writeFileSync("artifacts/commercial-parity-cpu.json", JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
}
