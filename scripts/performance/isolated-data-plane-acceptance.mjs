// Protected synthetic-only ABBA campaign. All failures and arrivals are retained.
import assert from "node:assert/strict";
import fs from "node:fs";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { produceHomepagePresentation } from "../../.output/strangler/presentation.mjs";
import {
  closeStageTransport,
  setStageTransportOrigin,
  stageFetch,
  stageTransport,
  stageTransportSpan,
  stageTransportCounters,
} from "../staging/strangler-http-transport.mjs";

const account = "d26430caa63ec55f6612e32f36aca5e9";
const primary = "e4cbb0ef-6288-4fa1-9dbb-fb42fe01d4f3";
const discovery = "cc842ee5-c526-431e-96ee-5e093fb45e6d";
const content = "7a26c27d-966c-468a-a3ad-d06cfff68010";
const production = "4bd657ac-8789-403e-a28c-93aba8d0a989";
const bucket = "cove-strangler-private-presentation-stage";
const token = process.env.CLOUDFLARE_API_TOKEN;
const runId = process.env.GITHUB_RUN_ID;
assert.ok(token && /^\d+$/.test(runId));
assert.equal(new Set([primary, discovery, content, production]).size, 4);
const directory = "artifacts/isolated-data-plane";
fs.mkdirSync(directory, { recursive: true });
const evidence = {
  sha: process.env.GITHUB_SHA,
  primary,
  discovery,
  content,
  productionRouted: false,
  cold: [],
  bursts: [],
  controls: [],
  phases: [],
  pass: false,
  transport: stageTransport,
};
const save = () => fs.writeFileSync(directory + "/results.json", JSON.stringify(evidence, null, 2));
const names = [];
let origin, gate;
evidence.workers = names;
let shutdown;
function cleanup() {
  return (shutdown ||= (async () => {
    closeStageTransport();
    for (const name of names) {
      try {
        await api("DELETE", `/accounts/${account}/workers/workers/${name}`);
      } catch {
        evidence.cleanupFailed = true;
      }
    }
    try {
      await sql(content, "DELETE FROM cove_arch_load WHERE run_id=?", [runId]);
    } catch {
      evidence.cleanupFailed = true;
    }
    save();
  })());
}
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, () => {
    evidence.cancelled = true;
    evidence.pass = false;
    void cleanup().finally(() => process.exit(130));
  });

function cli(args, input) {
  const r = spawnSync(
    "npm",
    ["exec", "--yes", "--package=wrangler@4.151.0", "--", "wrangler", ...args],
    {
      input,
      encoding: "utf8",
      timeout: 180000,
      env: { ...process.env, CLOUDFLARE_SEND_METRICS: "false" },
    },
  );
  if (r.status !== 0)
    throw Error(
      "Wrangler " +
        args[0] +
        " failed: " +
        String(r.stderr)
          .replace(/Bearer\s+\S+/g, "Bearer [redacted]")
          .slice(-600),
    );
}
async function api(method, path, body) {
  const r = await fetch("https://api.cloudflare.com/client/v4" + path, {
    method,
    headers: { authorization: "Bearer " + token, "content-type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(30000),
  });
  const j = await r.json();
  if (!r.ok || !j.success)
    throw Error("Cloudflare " + method + " " + r.status + " " + JSON.stringify(j.errors));
  return j.result;
}
async function sql(id, query, params = []) {
  assert.notEqual(id, production);
  return (
    await api("POST", `/accounts/${account}/d1/database/${id}/query`, { sql: query, params })
  )[0];
}
function readOnlyDB(id) {
  assert.equal(id, discovery);
  function statement(query, params = []) {
    assert.match(query.trim(), /^(SELECT|WITH)\b/i);
    return {
      bind(...args) {
        return statement(query, args);
      },
      async all() {
        return sql(id, query, params);
      },
      async first() {
        return (await sql(id, query, params)).results[0] || null;
      },
    };
  }
  return {
    prepare: statement,
    async batch(statements) {
      return Promise.all(statements.map((s) => s.all()));
    },
  };
}
function summary(rows) {
  const values = rows.map((x) => x.ms).sort((a, b) => a - b);
  const p = (q) => values[Math.ceil(values.length * q) - 1] ?? null;
  return {
    total: rows.length,
    valid: rows.filter((x) => x.ok).length,
    p95: p(0.95),
    p99: p(0.99),
    max: values.at(-1) ?? null,
    colos: [...new Set(rows.map((x) => x.colo).filter(Boolean))],
  };
}
async function sample(model = "projection", path = "/") {
  const started = performance.now();
  try {
    const r = await stageFetch(origin + path, {
      headers: {
        authorization: "Bearer " + gate,
        "x-cove-perf-client": String(Math.floor(started) % 2048),
        ...(model === "canonical" ? { "x-cove-perf-serving-model": "canonical" } : {}),
      },
      signal: AbortSignal.timeout(10000),
    });
    const ms = performance.now() - started;
    const transportSpan = stageTransportSpan(r);
    const body = await r.text();
    const ok =
      r.status === 200 &&
      (path.endsWith("transport")
        ? body === "ok"
        : path.endsWith("presentation")
          ? JSON.parse(body).country === "US"
          : body.includes('data-rights-country="US"') &&
            body.includes('id="thin-discovery-form"') &&
            !body.includes('data-product="perf-synth-000107"') &&
            !body.includes('data-product="perf-synth-000097"'));
    return {
      ok,
      ms,
      status: r.status,
      transportSpan: transportSpan
        ? {
            connectionMs: transportSpan.sent ? transportSpan.sent - transportSpan.created : null,
            responseMs:
              transportSpan.sent && transportSpan.received
                ? transportSpan.received - transportSpan.sent
                : null,
          }
        : null,
      colo: r.headers.get("cf-ray")?.split("-").at(-1),
      timing: r.headers.get("server-timing"),
      failure: r.headers.get("x-cove-stage-failure"),
      placement: r.headers.get("x-cove-stage-placement"),
    };
  } catch (e) {
    return {
      ok: false,
      ms: performance.now() - started,
      error: e.name,
      transportCode: typeof e.code === "string" && /^[A-Z0-9_]{3,60}$/.test(e.code) ? e.code : null,
    };
  }
}
async function deploy(round) {
  const name = `cove-arch-${runId}-${round}`;
  names.push(name);
  origin = `https://${name}.cove-jibrilmohamud.workers.dev`;
  setStageTransportOrigin(origin);
  gate = randomBytes(32).toString("hex");
  const c = JSON.parse(fs.readFileSync("wrangler.storefront-strangler.stage.jsonc"));
  assert.equal(c.d1_databases[0].database_id, primary);
  Object.assign(c, {
    name,
    workers_dev: true,
    preview_urls: false,
    services: [],
    placement: { region: "aws:us-east-1" },
    r2_buckets: [{ binding: "PRESENTATION", bucket_name: bucket }],
  });
  Object.assign(c.vars, {
    COVE_STRANGLER_READ_MODEL: "2",
    COVE_PRESENTATION_PREFIX: `campaign/${runId}/synthetic/`,
    COVE_SSR_DIAGNOSTICS: "1",
    FORE_PUBLIC_URL: origin,
  });
  // No hedging, shared pending I/O or primary-rights microbatch experiment.
  delete c.vars.COVE_THIN_METADATA_COALESCE;
  assert.ok(!JSON.stringify(c).includes(production));
  const config = "wrangler.arch-campaign.jsonc";
  fs.writeFileSync(config, JSON.stringify(c));
  cli(["deploy", "--config", config]);
  const before = (await api("GET", `/accounts/${account}/workers/scripts/${name}/deployments`))
    .deployments[0].id;
  cli(["secret", "put", "COVE_SSR_STAGING_GATE_KEY", "--config", config], gate);
  let published = false;
  for (let attempt = 0; attempt < 20; attempt++) {
    const latest = (await api("GET", `/accounts/${account}/workers/scripts/${name}/deployments`))
      .deployments[0];
    if (latest.id !== before && latest.versions.some((v) => v.percentage === 100)) {
      published = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  assert.ok(published);
  // Propagation only; no warming request before the measured first visit.
  await new Promise((r) => setTimeout(r, 25000));
}
async function phase(model) {
  const rows = [],
    background = [],
    transportControls = [],
    beforeConnections = stageTransportCounters(),
    inflight = new Set();
  let dropped = 0,
    maxSchedulerLagMs = 0,
    stopped = false;
  const bg = (async () => {
    let n = 0;
    while (!stopped) {
      const began = performance.now();
      try {
        // Physically independent claims/receipts and discovery ranking work. No
        // production writes, customer identity or artificial rights bypass.
        const results = await Promise.all([
          sql(
            content,
            "INSERT INTO cove_arch_load(run_id,sequence,payload) VALUES(?,?,?) ON CONFLICT(run_id) DO UPDATE SET sequence=excluded.sequence,payload=excluded.payload",
            [runId, String(n), "derived-preparation-" + n],
          ),
          sql(
            discovery,
            "SELECT product_id FROM catalog_search_documents INDEXED BY idx_search_popular_stable WHERE currency='USD' AND availability='available' AND suppressed=0 ORDER BY fore_bestseller_score DESC,external_book_id ASC,product_id ASC LIMIT 128",
          ),
        ]);
        background.push({
          ok: true,
          ms: performance.now() - began,
          meta: results.map((r) => r.meta),
        });
      } catch (e) {
        background.push({ ok: false, error: e.message });
      }
      n++;
      await new Promise((r) => setTimeout(r, 1000));
    }
  })();
  // Run D1-free transport controls on the same ingress/client connection
  // throughout each 120-second phase. Never exclude a failed control.
  const controlLoop = (async () => {
    while (!stopped) {
      transportControls.push(await sample("projection", "/__cove_perf/transport"));
      if (!stopped) await new Promise((r) => setTimeout(r, 1500));
    }
  })();
  const start = performance.now();
  await Promise.all(
    Array.from(
      { length: 12000 },
      (_, i) =>
        new Promise((resolve) =>
          setTimeout(() => {
            const lag = Math.max(0, performance.now() - start - i * 10);
            maxSchedulerLagMs = Math.max(maxSchedulerLagMs, lag);
            if (lag > 100 || inflight.size >= 200) {
              dropped++;
              resolve();
              return;
            }
            const task = sample(model).then((row) => {
              rows.push(row);
              inflight.delete(task);
              resolve();
            });
            inflight.add(task);
          }, i * 10),
        ),
    ),
  );
  stopped = true;
  await Promise.all([bg, controlLoop]);
  const result = {
    model,
    seconds: 120,
    targetRps: 100,
    offered: 12000,
    dropped,
    maxSchedulerLagMs,
    ...summary(rows),
    background,
    transportControls: { ...summary(transportControls), rows: transportControls },
    connectionDelta: Object.fromEntries(
      Object.entries(stageTransportCounters()).map(([key, value]) => [
        key,
        value - beforeConnections[key],
      ]),
    ),
    rows,
  };
  evidence.phases.push(result);
  save();
  // Tail attribution is diagnostic only. The acceptance rule below still
  // fails on the absolute slowest response; no outlier is discarded.
  console.log(
    "ARCH_PHASE_TAIL",
    JSON.stringify({
      model,
      slowest: [...rows]
        .sort((a, b) => b.ms - a.ms)
        .slice(0, 8)
        .map((row) => ({
          ms: row.ms,
          ok: row.ok,
          status: row.status,
          colo: row.colo,
          transportSpan: row.transportSpan,
          timing: row.timing,
          failure: row.failure,
          placement: row.placement,
          transportCode: row.transportCode,
        })),
    }),
  );
  console.log(
    "ARCH_PHASE",
    JSON.stringify({
      ...result,
      background: summary(background.map((x) => ({ ...x, ms: x.ms ?? 0 }))),
      transportControls: {
        ...summary(transportControls),
        failed: transportControls.filter((x) => !x.ok).length,
      },
      connectionDelta: result.connectionDelta,
      rows: undefined,
    }),
  );
}
try {
  const fixture = await sql(
    primary,
    "SELECT COUNT(*) n,SUM(CASE WHEN id NOT LIKE 'perf-synth-%' THEN 1 ELSE 0 END) bad FROM products",
  );
  assert.ok(fixture.results[0].n >= 40000 && fixture.results[0].bad === 0);
  await sql(
    content,
    "CREATE TABLE IF NOT EXISTS cove_arch_load(run_id TEXT PRIMARY KEY,sequence INTEGER,payload TEXT)",
  );
  await produceHomepagePresentation(readOnlyDB(discovery), "US", {
    async get() {
      throw Error("producer must not read R2");
    },
    async put(key, body) {
      const file = directory + "/presentation.json";
      fs.writeFileSync(file, body);
      cli([
        "r2",
        "object",
        "put",
        bucket + `/campaign/${runId}/synthetic/` + key,
        "--remote",
        "--file",
        file,
      ]);
    },
  });
  for (let round = 1; round <= 3; round++) {
    await deploy(round);
    const cold = await sample();
    evidence.cold.push(cold);
    save();
    console.log("ARCH_COLD", JSON.stringify({ round, ...cold }));
  }
  for (const path of ["/__cove_perf/transport", "/__cove_perf/presentation"]) {
    const rows = [];
    for (let i = 0; i < 20; i++) rows.push(await sample("projection", path));
    evidence.controls.push({ path, ...summary(rows), rows });
    save();
  }
  for (const concurrency of [1, 4, 8, 16, 32]) {
    const rows = await Promise.all(Array.from({ length: concurrency }, () => sample()));
    evidence.bursts.push({ concurrency, ...summary(rows), rows });
    save();
  }
  // Matched geography, immutable source, database, ingress, schedule and ABBA.
  for (const model of ["canonical", "projection", "projection", "canonical"]) await phase(model);
  const projected = evidence.phases.filter((p) => p.model === "projection");
  evidence.pass =
    evidence.cold.every((r) => r.ok && r.ms < 800) &&
    evidence.bursts.every((b) => b.valid === b.concurrency && b.max < 800) &&
    projected.every(
      (p) =>
        p.valid === 12000 &&
        p.dropped === 0 &&
        p.p95 < 600 &&
        p.p99 < 750 &&
        p.max < 800 &&
        p.transportControls.valid === p.transportControls.total &&
        p.transportControls.max < 800 &&
        p.background.every((r) => r.ok),
    );
  save();
  assert.ok(
    evidence.pass,
    "Isolated architecture has not passed absolute release performance gates; inspect all raw evidence",
  );
} finally {
  await cleanup();
  if (evidence.cleanupFailed) throw Error("Stage cleanup failed");
}
