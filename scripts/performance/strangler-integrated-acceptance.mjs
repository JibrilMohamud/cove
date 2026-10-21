// Immutable-SHA hosted acceptance. Dedicated synthetic D1 only; no customer traffic.
import assert from "node:assert/strict";
import fs from "node:fs";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { performance } from "node:perf_hooks";

const account = "d26430caa63ec55f6612e32f36aca5e9";
const dbId = "e4cbb0ef-6288-4fa1-9dbb-fb42fe01d4f3";
const prodDbId = "4bd657ac-8789-403e-a28c-93aba8d0a989";
const token = process.env.CLOUDFLARE_API_TOKEN;
assert.ok(token && token.length > 16, "Isolated hosted acceptance requires Cloudflare credentials");
assert.match(process.env.GITHUB_RUN_ID || "", /^\d+$/);
const name = "cove-strangler-perf-" + process.env.GITHUB_RUN_ID;
const origin = `https://${name}.cove-jibrilmohamud.workers.dev`;
const configPath = "wrangler.strangler-perf-run.jsonc";
const config = JSON.parse(fs.readFileSync("wrangler.storefront-strangler.stage.jsonc", "utf8"));
assert.equal(config.d1_databases[0].database_id, dbId);
assert.equal(config.workers_dev, false);
assert.equal(config.vars.COVE_STRANGLER_EXPERIENCE, "1");
config.name = name;
config.workers_dev = true;
config.preview_urls = false;
// All protected commerce, account, and reader delegation is separately
// exercised with a fake CORE by the same-SHA local integration suite.
config.services = [];
config.vars.FORE_PUBLIC_URL = origin;
const configString = JSON.stringify(config, null, 2);
assert.ok(!configString.includes(prodDbId), "Production D1 must never be bound");
assert.ok(!config.routes && !config.route && !config.r2_buckets && !config.queues);
fs.writeFileSync(configPath, configString);
const evidence = {
  sha: process.env.GITHUB_SHA,
  worker: name,
  syntheticD1: dbId,
  productionRouted: false,
  fixtureProducts: null,
  cold: [],
  bursts: [],
  sustained: null,
  pass: false,
};
fs.mkdirSync("artifacts/strangler-acceptance", { recursive: true });
const save = () =>
  fs.writeFileSync(
    "artifacts/strangler-acceptance/results.json",
    JSON.stringify(evidence, null, 2),
  );
let stageKey = "";
function command(args, input) {
  const run = spawnSync(
    "npm",
    ["exec", "--yes", "--package=wrangler@4.151.0", "--", "wrangler", ...args],
    {
      input,
      encoding: "utf8",
      timeout: 180_000,
      env: { ...process.env, CLOUDFLARE_SEND_METRICS: "false" },
    },
  );
  if (run.status !== 0 || run.error)
    throw Error(
      "Wrangler " +
        args.slice(0, 2).join(" ") +
        " failed: " +
        String(run.error?.message || run.stderr)
          .replace(/Bearer\s+\S+/g, "Bearer [redacted]")
          .slice(-900),
    );
}
async function cloudflare(method, path, body) {
  const response = await fetch("https://api.cloudflare.com/client/v4" + path, {
    method,
    headers: {
      authorization: "Bearer " + token,
      "content-type": "application/json",
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(60_000),
  });
  const json = await response.json();
  if (!response.ok || !json.success)
    throw Error("Cloudflare API " + method + " " + response.status);
  return json.result;
}
function percentile(data, pct) {
  const sorted = [...data].sort((a, b) => a - b);
  return sorted[Math.ceil(sorted.length * pct) - 1] ?? null;
}
function summarize(results) {
  const valid = results.filter((x) => x.ok);
  const values = valid.map((x) => x.ms);
  return {
    total: results.length,
    valid: valid.length,
    p95: percentile(values, 0.95),
    p99: percentile(values, 0.99),
    max: values.length ? Math.max(...values) : null,
  };
}
let client = 0;
async function sample() {
  const start = performance.now();
  try {
    const response = await fetch(origin + "/", {
      headers: {
        authorization: "Bearer " + stageKey,
        "x-cove-perf-client": String(client++ % 2048),
      },
      signal: AbortSignal.timeout(10_000),
    });
    const ms = performance.now() - start;
    const html = await response.text();
    const ok =
      response.status === 200 &&
      html.includes('id="thin-discovery-form"') &&
      html.includes('data-rights-country="US"') &&
      html.includes('id="thin-merchandising"') &&
      !html.includes('data-product="perf-synth-000107"') &&
      !html.includes('data-product="perf-synth-000097"');
    return { ok, ms, status: response.status };
  } catch (error) {
    return { ok: false, ms: performance.now() - start, error: error.name };
  }
}
async function deployFresh() {
  command(["deploy", "--config", configPath]);
  stageKey = randomBytes(32).toString("hex");
  command(["secret", "put", "COVE_SSR_STAGING_GATE_KEY", "--config", configPath], stageKey);
  // Never run customer data through this Worker; the stage gate must reject
  // every anonymous request before touching the wholly synthetic fixture.
  let unauthorized = null;
  for (let attempt = 0; attempt < 12; attempt++) {
    try {
      unauthorized = await fetch(origin, { signal: AbortSignal.timeout(6000) });
      if (unauthorized.status === 401) break;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  assert.equal(unauthorized?.status, 401, "Staging gate must reject unauthenticated traffic");
}
const startedAt = performance.now();
try {
  const fixture = await cloudflare("POST", `/accounts/${account}/d1/database/${dbId}/query`, {
    sql: "SELECT COUNT(*) AS n, SUM(CASE WHEN id NOT LIKE 'perf-synth-%' THEN 1 ELSE 0 END) AS bad FROM products",
  });
  assert.ok(Number(fixture?.[0]?.results?.[0]?.n) >= 40_000);
  assert.equal(Number(fixture?.[0]?.results?.[0]?.bad), 0);
  evidence.fixtureProducts = Number(fixture[0].results[0].n);
  for (let i = 0; i < 3; i++) {
    await deployFresh();
    const cold = await sample();
    evidence.cold.push(cold);
    save();
    assert.ok(cold.ok && cold.ms < 800, "Independent cold visit exceeded 800ms");
  }
  for (const concurrency of [1, 4, 8, 16, 32]) {
    const results = await Promise.all(Array.from({ length: concurrency }, () => sample()));
    const summary = summarize(results);
    evidence.bursts.push({ concurrency, ...summary });
    save();
    assert.equal(summary.valid, concurrency, "Concurrent request failed");
    assert.ok(summary.max < 800, "Concurrent maximum exceeded 800ms");
  }
  const offered = 2000;
  const inFlight = new Set();
  const results = [];
  let dropped = 0;
  const start = performance.now();
  for (let i = 0; i < offered; i++) {
    const planned = start + 10 * i;
    const delay = planned - performance.now();
    if (delay > 1) await new Promise((resolve) => setTimeout(resolve, delay));
    if (performance.now() - planned > 100 || inFlight.size >= 200) {
      dropped++;
      continue;
    }
    const task = sample().then((result) => results.push(result));
    inFlight.add(task);
    task.finally(() => inFlight.delete(task));
  }
  await Promise.all(inFlight);
  const summary = summarize(results);
  evidence.sustained = { targetRps: 100, seconds: 20, offered, dropped, ...summary };
  save();
  assert.equal(dropped, 0, "Offered arrivals dropped");
  assert.equal(summary.valid, offered, "Sustained requests failed");
  assert.ok(
    summary.p95 < 600 && summary.p99 < 750 && summary.max < 800,
    "Integrated 100-RPS tails exceeded release envelope",
  );
  evidence.pass = true;
  console.log(
    "PASS integrated thin performance acceptance",
    JSON.stringify({
      cold: evidence.cold.map((x) => Math.round(x.ms)),
      bursts: evidence.bursts.map((x) => ({ n: x.concurrency, max: Math.round(x.max) })),
      sustained: evidence.sustained,
    }),
  );
} catch (error) {
  evidence.failure = String(error.message || error);
  throw error;
} finally {
  evidence.elapsedMs = Math.round(performance.now() - startedAt);
  save();
  try {
    await cloudflare("DELETE", `/accounts/${account}/workers/scripts/${name}?force=true`);
  } catch {
    console.error("Stage cleanup not confirmed; remove only " + name);
  }
}
