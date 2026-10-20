import { discoveryResponse } from "./discovery-response.mjs";
import { parseDiscoveryBenchmarkConfig } from "./discovery-benchmark-config.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { offeredLoad, summarizeRequests } from "./offered-load.mjs";
import { PERFORMANCE_D1, verifySyntheticD1 } from "./isolated-d1-gate.mjs";

const config = parseDiscoveryBenchmarkConfig(
  fs.readFileSync("wrangler.discovery-benchmark.jsonc", "utf8"),
);
assert.ok(process.env.CLOUDFLARE_API_TOKEN);
const account = "d26430caa63ec55f6612e32f36aca5e9",
  key = randomBytes(32).toString("hex");
const origin = `https://${config.name}.cove-jibrilmohamud.workers.dev`;
const output = "artifacts/discovery-benchmark";
fs.mkdirSync(output, { recursive: true });
const evidence = {
  sha: process.env.GITHUB_SHA,
  kind: "isolated-bounded-delivery-generator-local-v4",
  variants: {
    control: "Classic full-pool authorization + independent engagement + durable HTTP telemetry",
    projection: "Bounded display authorization + independent engagement + durable HTTP telemetry",
  },
  productionD1: false,
  fullCustomerJourney: false,
  realSearchEngine: false,
  releaseApproved: false,
  cold: [],
  bursts: [],
  load: [],
  errors: [],
};
const save = () => fs.writeFileSync(`${output}/results.json`, JSON.stringify(evidence, null, 2));
async function api(method, path, body) {
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}`,
      "content-type": "application/json",
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(60000),
  });
  const json = await response.json();
  if (!response.ok || !json.success)
    throw new Error(`Cloudflare ${method} ${path}: ${response.status}`);
  return json.result;
}
function wrangler(args, input) {
  const r = spawnSync(
    "npm",
    ["exec", "--yes", "--package=wrangler@4.151.0", "--", "wrangler", ...args],
    { input, encoding: "utf8", timeout: 180000, maxBuffer: 4 * 1024 * 1024 },
  );
  if (r.status !== 0) throw new Error(`Wrangler ${args[0]} failed: ${r.stderr?.slice(-1200)}`);
}
let client = 0;
async function probe(route, mode) {
  const url = new URL(route, origin);
  url.searchParams.set("mode", mode);
  url.searchParams.set("visitor", randomUUID());
  url.searchParams.set("language", "en");
  const started = performance.now();
  try {
    const response = await fetch(url, {
      headers: { authorization: `Bearer ${key}`, "x-cove-perf-client": String(++client % 65535) },
      signal: AbortSignal.timeout(8000),
    });
    const ttfbMs = performance.now() - started;
    const payload = await response.json().catch(() => null);
    const shape = discoveryResponse(route, payload);
    const valid = response.ok && shape.valid && response.headers.get("x-cove-read-model") === mode;
    return {
      route,
      mode,
      status: response.status,
      valid,
      ttfbMs,
      totalMs: performance.now() - started,
      statements: Number(response.headers.get("x-cove-d1-statements")),
      primaryPendingStatements: Number(response.headers.get("x-cove-d1-pending-statements")),
      engagementPendingStatements: Number(
        response.headers.get("x-cove-engagement-pending-statements"),
      ),
      engagementStatements: Number(response.headers.get("x-cove-engagement-statements")),
      engagementRowsWritten: Number(response.headers.get("x-cove-engagement-rows-written")),
      sqlMsWithMetadata: Number(response.headers.get("x-cove-d1-sql-ms")),
      sqlMetadataStatements: Number(response.headers.get("x-cove-d1-sql-metadata-statements")),
      rowsReadWithMetadata: Number(response.headers.get("x-cove-d1-rows-read")),
      rowsWrittenWithMetadata: Number(response.headers.get("x-cove-d1-rows-written")),
      serverTiming: response.headers.get("server-timing"),
      requestId: response.headers.get("x-fore-request-id"),
      epoch: response.headers.get("x-cove-benchmark-epoch"),
      colo: response.headers.get("cf-ray")?.split("-").at(-1),
      products: shape.products,
      ...(valid ? {} : { failure: response.ok ? "content" : `http-${response.status}` }),
    };
  } catch (error) {
    return {
      route,
      mode,
      valid: false,
      failure: error.name === "TimeoutError" ? "timeout" : "transport",
      totalMs: performance.now() - started,
    };
  }
}
async function refresh() {
  const r = await fetch(`${origin}/__refresh`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(120000),
  });
  assert.equal(r.status, 200, "Scheduled producer failed before serving trial");
  await r.arrayBuffer();
}
const home = "/api/fore/recommendations/home",
  bootstrap = "/api/fore/storefront/bootstrap",
  merch = "/api/fore/merchandising";
try {
  evidence.fixture = await verifySyntheticD1(
    PERFORMANCE_D1.current.id,
    async (id, sql) => (await api("POST", `/d1/database/${id}/query`, { sql }))[0],
  );
  const primaryLocation = await api("POST", `/d1/database/${PERFORMANCE_D1.current.id}/query`, {
    sql: "SELECT 1 n",
  });
  const ledgerRole = await api("POST", `/d1/database/${config.d1_databases[1].database_id}/query`, {
    sql: "SELECT version FROM engagement_schema",
  });
  assert.deepEqual(
    ledgerRole[0].results,
    [{ version: 1 }],
    "Separate database schema must be initialized",
  );
  evidence.databaseLocations = { primary: primaryLocation[0].meta, engagement: ledgerRole[0].meta };
  const unrelated = await api("POST", `/d1/database/${config.d1_databases[1].database_id}/query`, {
    sql: "SELECT name FROM sqlite_master WHERE name IN ('products','rights_grants','commerce_orders')",
  });
  assert.equal(
    unrelated[0].results.length,
    0,
    "Engagement resource must not contain transactional tables",
  );
  wrangler(["deploy", "--config", "wrangler.discovery-benchmark.jsonc"]);
  wrangler(
    [
      "secret",
      "put",
      "COVE_SSR_STAGING_GATE_KEY",
      "--config",
      "wrangler.discovery-benchmark.jsonc",
    ],
    key,
  );
  await new Promise((r) => setTimeout(r, 6000));
  assert.equal((await fetch(origin)).status, 401, "Stage gate must reject unauthenticated traffic");
  await refresh();
  for (let round = 0; round < 3; round++) {
    const epoch = randomUUID();
    wrangler([
      "deploy",
      "--config",
      "wrangler.discovery-benchmark.jsonc",
      "--var",
      `COVE_BENCHMARK_EPOCH:${epoch}`,
    ]);
    const deployed = await api("GET", `/workers/scripts/${config.name}/deployments`);
    const deployment = deployed.deployments[0];
    assert.ok(deployment.versions.some((v) => v.percentage === 100));
    assert.ok(!evidence.cold.some((row) => row.deployment.id === deployment.id));
    await new Promise((r) => setTimeout(r, 6000));
    const firstRequest = await probe(home, "projection");
    assert.equal(
      firstRequest.epoch,
      epoch,
      "Cold sample must come from the freshly rebound deployment",
    );
    const followups = [];
    for (let i = 0; i < 19; i++) followups.push(await probe(home, "projection"));
    evidence.cold.push({
      round,
      deployment,
      firstRequest,
      warmFollowups: summarizeRequests(followups),
      followups,
    });
    save();
  }
  for (const concurrency of [1, 4, 8, 16, 32])
    for (const route of [home, bootstrap]) {
      const rows = [];
      for (let repeat = 0; repeat < 3; repeat++)
        rows.push(
          ...(await Promise.all(
            Array.from({ length: concurrency }, () => probe(route, "projection")),
          )),
        );
      evidence.bursts.push({ concurrency, route, summary: summarizeRequests(rows), rows });
      save();
    }
  for (const rps of [10, 25]) {
    const order = rps === 10 ? ["control", "projection"] : ["projection", "control"];
    for (const mode of order) {
      await refresh();
      const phase = await offeredLoad({ rps, durationMs: 30000, request: () => probe(home, mode) });
      evidence.load.push({ kind: "recommendations", rps, mode, ...phase });
      save();
    }
    await refresh();
    const phase = await offeredLoad({
      rps,
      durationMs: 30000,
      request: (index) => probe([home, bootstrap, home, merch][index % 4], "projection"),
    });
    evidence.load.push({ kind: "mixed-without-search", rps, mode: "projection", ...phase });
    save();
  }
  // Commit a synthetic rights change, then inspect multiple fresh model deliveries.
  const chosen = (await probe(home, "projection")).products?.find((id) =>
    /^perf-synth-\d+$/.test(id),
  );
  assert.ok(chosen);
  const rows = await api("POST", `/d1/database/${PERFORMANCE_D1.current.id}/query`, {
    sql: "SELECT id,status FROM rights_grants WHERE edition_id=(SELECT edition_id FROM products WHERE id=?) AND territory_code='US'",
    params: [chosen],
  });
  const grants = rows[0].results;
  try {
    await api("POST", `/d1/database/${PERFORMANCE_D1.current.id}/query`, {
      sql: "UPDATE rights_grants SET status='revoked' WHERE edition_id=(SELECT edition_id FROM products WHERE id=?) AND territory_code='US'",
      params: [chosen],
    });
    const fresh = await Promise.all(Array.from({ length: 8 }, () => probe(home, "projection")));
    evidence.revocation = {
      product: chosen,
      rows: fresh,
      passed: fresh.every((row) => row.valid && !row.products.includes(chosen)),
    };
  } finally {
    for (const grant of grants)
      await api("POST", `/d1/database/${PERFORMANCE_D1.current.id}/query`, {
        sql: "UPDATE rights_grants SET status=? WHERE id=?",
        params: [grant.status, grant.id],
      });
  }
  const pass = (summary) => summary.allValid && summary.successfulTtfb.max < 800;
  evidence.architecturalGatePassed =
    evidence.cold.every(
      (round) =>
        round.firstRequest.valid && round.firstRequest.ttfbMs < 800 && pass(round.warmFollowups),
    ) &&
    evidence.bursts.every((row) => pass(row.summary)) &&
    evidence.load.filter((row) => row.mode === "projection").every((row) => pass(row.summary)) &&
    evidence.revocation.passed;
  console.log(
    JSON.stringify({
      cold: evidence.cold.map((r) => ({
        firstMs: r.firstRequest.ttfbMs,
        warmMaxMs: r.warmFollowups.successfulTtfb.max,
      })),
      bursts: evidence.bursts.map(({ rows, ...r }) => r),
      load: evidence.load.map(({ rows, drops, ...r }) => r),
      revocation: evidence.revocation.passed,
      architecturalGatePassed: evidence.architecturalGatePassed,
      releaseApproved: false,
    }),
  );
  if (!evidence.architecturalGatePassed) process.exitCode = 1;
} catch (error) {
  evidence.errors.push(error.message);
  process.exitCode = 1;
  console.error(error.message);
} finally {
  save();
}
