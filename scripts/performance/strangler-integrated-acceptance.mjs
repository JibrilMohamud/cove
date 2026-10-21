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
const namePrefix = "cove-strangler-perf-" + process.env.GITHUB_RUN_ID;
let name = namePrefix + "-1";
let origin = `https://${name}.cove-jibrilmohamud.workers.dev`;
const createdWorkers = [];
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
  workers: createdWorkers,
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
    return {
      ok,
      ms,
      status: response.status,
      failure: response.headers.get("x-cove-stage-failure") || null,
      observedCountry: /data-rights-country="([^"]+)"/.exec(html)?.[1] || null,
      renderer: response.headers.get("x-cove-renderer"),
    };
  } catch (error) {
    return { ok: false, ms: performance.now() - start, error: error.name };
  }
}
async function deployFresh(round) {
  // A unique Worker identity prevents stale encrypted secrets from previous
  // deployments in remote POPs contaminating an independent cold observation.
  name = namePrefix + "-" + round;
  origin = `https://${name}.cove-jibrilmohamud.workers.dev`;
  createdWorkers.push(name);
  config.name = name;
  config.vars.FORE_PUBLIC_URL = origin;
  const scopedConfig = JSON.stringify(config, null, 2);
  assert.ok(!scopedConfig.includes(prodDbId));
  fs.writeFileSync(configPath, scopedConfig);
  command(["deploy", "--config", configPath]);
  const before = await cloudflare(
    "GET",
    `/accounts/${account}/workers/scripts/${name}/deployments`,
  );
  const beforeId = before.deployments?.[0]?.id;
  assert.ok(beforeId, "Initial Worker deployment is unavailable");
  stageKey = randomBytes(32).toString("hex");
  const rotatedAt = Date.now();
  command(["secret", "put", "COVE_SSR_STAGING_GATE_KEY", "--config", configPath], stageKey);
  // Only a distinct post-secret 100% rollout is eligible for testing.
  for (let attempt = 0; attempt < 18; attempt++) {
    const result = await cloudflare(
      "GET",
      `/accounts/${account}/workers/scripts/${name}/deployments`,
    );
    const latest = result.deployments?.[0];
    if (
      latest &&
      latest.id !== beforeId &&
      Date.parse(latest.created_on) >= rotatedAt - 3000 &&
      latest.versions?.some((version) => version.percentage === 100)
    ) {
      await new Promise((resolve) => setTimeout(resolve, 3500));
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 1800));
  }
  throw new Error("Fresh post-secret Worker deployment not confirmed");
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
    await deployFresh(i + 1);
    const cold = await sample();
    evidence.cold.push(cold);
    console.log("COLD_PROBE", JSON.stringify({ round: i + 1, ...cold }));
    save();
  }
  assert.ok(
    evidence.cold.every((cold) => cold.ok && cold.ms < 800),
    "Independent cold visits failed validity or 800ms bound",
  );
  const unauthorized = await fetch(origin, { signal: AbortSignal.timeout(6000) });
  assert.equal(unauthorized.status, 401, "Stage gate must reject requests without bearer");
  for (const concurrency of [1, 4, 8, 16, 32]) {
    const results = await Promise.all(Array.from({ length: concurrency }, () => sample()));
    const summary = summarize(results);
    evidence.bursts.push({ concurrency, ...summary });
    console.log("BURST_RESULT", JSON.stringify({ concurrency, ...summary }));
    save();
    assert.equal(summary.valid, concurrency, "Concurrent request failed");
    assert.ok(summary.max < 800, "Concurrent maximum exceeded 800ms");
  }
  const offered = 2000;
  const inFlight = new Set();
  const results = [];
  let dropped = 0;
  let maxSchedulerLagMs = 0;
  let maxOutstanding = 0;
  const start = performance.now();
  // Schedule all offered arrivals independently. A sequential await loop
  // could itself drift under runner GC and falsely count missing arrivals.
  const scheduled = Array.from(
    { length: offered },
    (_, i) =>
      new Promise((resolve) => {
        setTimeout(() => {
          const lag = Math.max(0, performance.now() - (start + i * 10));
          maxSchedulerLagMs = Math.max(maxSchedulerLagMs, lag);
          if (lag > 100 || inFlight.size >= 200) {
            dropped++;
            resolve();
            return;
          }
          const task = sample().then((result) => {
            results.push(result);
            inFlight.delete(task);
            resolve();
          });
          inFlight.add(task);
          maxOutstanding = Math.max(maxOutstanding, inFlight.size);
        }, 10 * i);
      }),
  );
  await Promise.all(scheduled);
  const summary = summarize(results);
  evidence.sustained = {
    targetRps: 100,
    seconds: 20,
    offered,
    dropped,
    maxSchedulerLagMs,
    maxOutstanding,
    ...summary,
  };
  console.log("SUSTAINED_RESULT", JSON.stringify(evidence.sustained));
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
  for (const workerName of createdWorkers) {
    try {
      await cloudflare("DELETE", `/accounts/${account}/workers/scripts/${workerName}?force=true`);
    } catch {
      console.error("Stage cleanup not confirmed; remove only " + workerName);
    }
  }
}
