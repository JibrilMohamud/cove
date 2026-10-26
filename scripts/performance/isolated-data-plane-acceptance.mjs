// Protected synthetic-only ABBA campaign. All failures and arrivals are retained.
import assert from "node:assert/strict";
import fs from "node:fs";
import { randomBytes } from "node:crypto";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { spawnSync } from "node:child_process";
import { produceHomepagePresentation } from "../../.output/strangler/presentation.mjs";
import {
  closeStageTransport,
  setStageTransportOrigin,
  stageFetch,
  stageTransport,
  stageTransportSpan,
  stageTransportCounters,
  stageTransportSessionSnapshot,
} from "../staging/strangler-http-transport.mjs";
import {
  takeAnonymizedTcpSnapshot,
  compareTcpSnapshots,
} from "./anonymized-tcp-evidence.mjs";
import { projectedRequestFailure, strictProjectionPhasePass } from "./capacity-release-gate.mjs";
import {
  syntheticOperatorFixturePlan,
  REQUIRED_BOOK_CARDS,
} from "./synthetic-operator-fixture.mjs";

const account = "d26430caa63ec55f6612e32f36aca5e9";
const primary = "e4cbb0ef-6288-4fa1-9dbb-fb42fe01d4f3";
const discovery = "cc842ee5-c526-431e-96ee-5e093fb45e6d";
const content = "7a26c27d-966c-468a-a3ad-d06cfff68010";
const production = "4bd657ac-8789-403e-a28c-93aba8d0a989";
const bucket = "cove-strangler-private-presentation-stage";
// Same private QA-only namespace as the real-catalog presentation accelerator.
// Every key is isolated by the unique GitHub run ID and expires after 30 min.
const presentationKv = "8245d5f2116a445d9571405b41b7c8c3";
const token = process.env.CLOUDFLARE_API_TOKEN;
const runId = process.env.GITHUB_RUN_ID;
assert.ok(token && /^\d+$/.test(runId));
assert.equal(new Set([primary, discovery, content, production]).size, 4);
const directory = "artifacts/isolated-data-plane";
// Only an explicit diagnostic rerun collects all phases after an irreversible
// projected arrival failure. Neither mode may reclassify a failure as a pass.
const failFast = process.env.COVE_CAPACITY_FAIL_FAST !== "0";
// Compare pinned-primary execution with ingress-local execution on the SAME
// isolated DB, offered load and strict absolute gates. Never alter production.
const stagePlacement = process.env.COVE_CAPACITY_PLACEMENT || "primary-pinned";
assert.ok(["primary-pinned", "ingress-local"].includes(stagePlacement));
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
  failFastEnabled: failFast,
  stagePlacement,
  presentationAccelerator: "private-stage-kv-with-r2-fallback",
};
const save = () => fs.writeFileSync(directory + "/results.json", JSON.stringify(evidence, null, 2));
const names = [];
const kvKeys = [];
let syntheticFixture = null;
let fixtureActivated = false;
let origin, gate;
evidence.workers = names;
let shutdown;
function cleanup() {
  return (shutdown ||= (async () => {
    closeStageTransport();
    /* eslint-disable prettier/prettier -- Stage-only rollback and rights proof. */
    if (syntheticFixture) {
      // Atomic QA rollback: never leave a storefront offer with the wrong
      // catalog source after a failed/cancelled measurement.
      try {
        const q = syntheticFixture;
        const result = await api("POST", `/accounts/${account}/d1/database/${primary}/query`, {
          batch: [q.dropOffers, q.restore],
        });
        if (fixtureActivated && result[1]?.meta?.changes !== REQUIRED_BOOK_CARDS)
          evidence.cleanupFailed = true;
      } catch {
        evidence.cleanupFailed = true;
      }
    }
    /* eslint-enable prettier/prettier */
    for (const key of kvKeys) {
      try {
        await api(
          "DELETE",
          `/accounts/${account}/storage/kv/namespaces/${presentationKv}/values/${encodeURIComponent(key)}`,
        );
      } catch {
        evidence.cleanupFailed = true;
      }
    }
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
// Some freshly provisioned Workers are briefly absent from Cloudflare's
// versions API (10007). Retry only this pre-traffic provisioning race. No
// benchmark request or app error is replayed or ignored.
async function deployStage(config) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      cli(["deploy", "--config", config]);
      return;
    } catch (error) {
      if (attempt === 3 || !/Worker does not exist|code:\s*10007/i.test(String(error))) throw error;
      console.warn("Stage Worker provisioning delayed; retry " + attempt);
      await new Promise((resolve) => setTimeout(resolve, attempt * 1500));
    }
  }
}

async function api(method, path, body) {
  // Cloudflare's deployment-metadata GET can transiently return 10500
  // internal-authentication errors during the stage secret rollout. Retry
  // ONLY these read-only, pre-traffic control-plane requests. Never retry
  // D1, user traffic, load measurements, SQL, or response-bearing streams.
  const stageRead =
    method === "GET" &&
    path.startsWith(`/accounts/${account}/workers/scripts/`) &&
    /\/(?:deployments|subdomain)$/.test(path);
  for (let attempt = 0; attempt < (stageRead ? 4 : 1); attempt++) {
    const r = await fetch("https://api.cloudflare.com/client/v4" + path, {
      method,
      headers: { authorization: "Bearer " + token, "content-type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(30000),
    });
    const j = await r.json();
    if (r.ok && j.success) return j.result;
    const transient =
      stageRead &&
      r.status >= 500 &&
      Array.isArray(j.errors) &&
      j.errors.some((e) => e.code === 10500);
    if (!transient || attempt === 3)
      throw Error("Cloudflare " + method + " " + r.status + " " + JSON.stringify(j.errors));
    console.warn("Stage deployment control-plane transient 10500; retry " + (attempt + 1));
    await new Promise((resolve) => setTimeout(resolve, 750 * (attempt + 1)));
  }
  throw Error("Stage deployment metadata unavailable");
}
async function putPrivateStageKv(key, body) {
  assert.ok(key.startsWith(`campaign/${runId}/synthetic/private/presentation/v2/`));
  assert.ok(Buffer.byteLength(body, "utf8") < 512 * 1024);
  const path = `/accounts/${account}/storage/kv/namespaces/${presentationKv}/values/${encodeURIComponent(key)}`;
  const response = await fetch(
    "https://api.cloudflare.com/client/v4" + path + "?expiration_ttl=1800",
    {
      method: "PUT",
      headers: {
        authorization: "Bearer " + token,
        "content-type": "application/octet-stream",
      },
      body,
      signal: AbortSignal.timeout(30000),
    },
  );
  const receipt = await response.json();
  assert.ok(response.ok && receipt.success, "Isolated QA KV seed failed");
  kvKeys.push(key);
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
        // Real browsers negotiate response compression over HTTP/2.
        // The isolated load client already decodes br/gzip; without this
        // header it artificially sends uncompressed HTML at 100 RPS.
        // Do not change sample counting, response integrity or the 800ms gate.
        "accept-encoding": "br, gzip",
        "x-cove-perf-client": String(Math.floor(started) % 2048),
        ...(model === "canonical" ? { "x-cove-perf-serving-model": "canonical" } : {}),
      },
      signal: AbortSignal.timeout(10000),
    });
    const ms = performance.now() - started;
    const completedAtUnixMs = Date.now();
    const transportSpan = stageTransportSpan(r);
    const serverTiming = r.headers.get("server-timing") || "";
    const handlerMs = /(?:^|, )cove_handler;dur=(\d+(?:\.\d+)?)/.exec(serverTiming);
    const catalogMs = /(?:^|, )cove_catalog;dur=(\d+(?:\.\d+)?)/.exec(serverTiming);
    const firstIsolate = /(?:^|, )cove_isolate_first;desc="([01])"/.exec(serverTiming);
    const isolateSeen = /(?:^|, )cove_isolate_seen;desc="(\d{1,3})"/.exec(serverTiming);
    const body = await r.text();
    const wireBytes = transportSpan?.wireBytes ?? null;
    const decodedBytes = transportSpan?.decodedBytes ?? null;
    const contentEncoding = r.headers.get("content-encoding") || "identity";
    const ok =
      r.status === 200 &&
      (path.endsWith("transport")
        ? body === "ok"
        : path.endsWith("presentation")
          ? JSON.parse(body).country === "US"
          : body.includes('data-rights-country="US"') &&
            body.includes('id="thin-discovery-form"') &&
            // Previously a 200 HTML shell with ZERO authorized books could
            // pass the capacity gate after Gutenberg proof was hardened.
            // Assert real live-primary-authorized cards, not merely HTTP 200.
            [...body.matchAll(/data-product="(perf-synth-[0-9]{6})"/g)].length ===
              REQUIRED_BOOK_CARDS &&
            body.includes('data-product="perf-synth-000001"') &&
            !body.includes('data-product="perf-synth-000107"') &&
            !body.includes('data-product="perf-synth-000097"'));
    return {
      ok,
      ms,
      completedAtUnixMs,
      status: r.status,
      transportSpan: transportSpan
        ? {
            connectionMs: transportSpan.sent ? transportSpan.sent - transportSpan.created : null,
            responseMs:
              transportSpan.sent && transportSpan.received
                ? transportSpan.received - transportSpan.sent
                : null,
            wireBytes,
            decodedBytes,
            contentEncoding,
            sessionId: transportSpan.sessionId,
          }
        : null,
      colo: r.headers.get("cf-ray")?.split("-").at(-1),
      ray: /^[a-f0-9]{12,30}(?:-[A-Z]{3})?$/.test(r.headers.get("cf-ray") || "")
        ? r.headers.get("cf-ray")
        : null,
      handlerMs: handlerMs ? Number(handlerMs[1]) : null,
      catalogServiceMs: catalogMs ? Number(catalogMs[1]) : null,
      outsideHandlerMs: handlerMs ? Math.max(0, ms - Number(handlerMs[1])) : null,
      isolateFirst: firstIsolate ? firstIsolate[1] === "1" : null,
      isolateOrdinal: isolateSeen ? Number(isolateSeen[1]) : null,
      timing: serverTiming,
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
    r2_buckets: [{ binding: "PRESENTATION", bucket_name: bucket }],
    kv_namespaces: [{ binding: "PRESENTATION_KV", id: presentationKv }],
  });
  // Explicit placement can add an inter-colo hop even when the primary D1
  // query itself is fast. Ingress-local is an isolated test arm only.
  if (stagePlacement === "ingress-local") delete c.placement;
  else c.placement = { region: "aws:us-east-1" };
  Object.assign(c.vars, {
    COVE_STRANGLER_READ_MODEL: "2",
    COVE_PRESENTATION_PREFIX: `campaign/${runId}/synthetic/`,
    COVE_PRESENTATION_KV_ACCELERATE: "1",
    COVE_SSR_DIAGNOSTICS: "1",
    FORE_PUBLIC_URL: origin,
  });
  // No hedging, shared pending I/O or primary-rights microbatch experiment.
  delete c.vars.COVE_THIN_METADATA_COALESCE;
  assert.ok(!JSON.stringify(c).includes(production));
  const config = "wrangler.arch-campaign.jsonc";
  fs.writeFileSync(config, JSON.stringify(c));
  await deployStage(config);
  const before = (await api("GET", `/accounts/${account}/workers/scripts/${name}/deployments`))
    .deployments[0].id;
  cli(["secret", "put", "COVE_SSR_STAGING_GATE_KEY", "--config", config], gate);
  let publishedAt = null;
  for (let attempt = 0; attempt < 20; attempt++) {
    const latest = (await api("GET", `/accounts/${account}/workers/scripts/${name}/deployments`))
      .deployments[0];
    if (latest.id !== before && latest.versions.some((v) => v.percentage === 100)) {
      publishedAt = Date.parse(latest.created_on);
      break;
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  assert.ok(Number.isFinite(publishedAt), "Stage secret rollout timestamp unavailable");
  const subdomain = await api("GET", `/accounts/${account}/workers/scripts/${name}/subdomain`);
  assert.equal(subdomain.enabled, true, "Staging route is not enabled");
  // Brand-new workers.dev routes can still return edge-generated 404 after
  // the deployment API reports a completed 100% rollout. Wait for route
  // propagation BEFORE the first actual Worker request. We must not poll the
  // application route: doing so would warm the isolate and invalidate the
  // cold-start gate. The first request remains one measured, strict sample.
  const waitMs = Math.max(0, publishedAt + 75000 - Date.now());
  evidence.routePropagation ||= [];
  evidence.routePropagation.push({ round, waitMs, rolloutConfirmed: true });
  save();
  console.log("ARCH_ROUTE_PROPAGATION_GRACE", JSON.stringify({ round, waitMs }));
  await new Promise((r) => setTimeout(r, waitMs));
}
async function phase(model) {
  const rows = [],
    background = [],
    transportControls = [],
    beforeConnections = stageTransportCounters(),
    inflight = new Set();
  let dropped = 0,
    maxSchedulerLagMs = 0,
    stopped = false,
    scheduled = 0,
    cancelledUnsent = 0,
    irreversibleFailure = null;
  const pendingTimers = new Map();
  // Capture baseline kernel TCP counters BEFORE the measured 100-RPS window.
  // Never hide any slow request; this is diagnostic-only.
  const tcpBefore = await takeAnonymizedTcpSnapshot(stageTransportSessionSnapshot());
  const loopDelay = monitorEventLoopDelay({ resolution: 10 });
  loopDelay.enable();
  const stopOnViolation = (code, row) => {
    if (!failFast || model !== "projection" || irreversibleFailure) return;
    irreversibleFailure = {
      code,
      ms: Number.isFinite(row?.ms) ? row.ms : null,
      status: row?.status ?? null,
      sample: rows.length,
    };
    stopped = true;
    // Resolve only unsent scheduled arrivals. Never cancel or replay a
    // dispatched request; let all in-flight samples finish and be recorded.
    for (const [timer, resolve] of pendingTimers) {
      clearTimeout(timer);
      pendingTimers.delete(timer);
      cancelledUnsent++;
      resolve();
    }
  };
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
        stopOnViolation("background-failed");
      }
      n++;
      await new Promise((r) => setTimeout(r, 1000));
    }
  })();
  // Run D1-free transport controls on the same ingress/client connection
  // throughout each 120-second phase. Never exclude a failed control.
  const controlLoop = (async () => {
    while (!stopped) {
      const control = await sample("projection", "/__cove_perf/transport");
      transportControls.push(control);
      const failure = projectedRequestFailure(control);
      if (failure) stopOnViolation("transport-control-" + failure, control);
      if (!stopped) await new Promise((r) => setTimeout(r, 1500));
    }
  })();
  const start = performance.now();
  await Promise.all(
    Array.from(
      { length: 12000 },
      (_, i) =>
        new Promise((resolve) => {
          const timer = setTimeout(() => {
            pendingTimers.delete(timer);
            if (irreversibleFailure) {
              cancelledUnsent++;
              resolve();
              return;
            }
            scheduled++;
            const lag = Math.max(0, performance.now() - start - i * 10);
            maxSchedulerLagMs = Math.max(maxSchedulerLagMs, lag);
            if (lag > 100 || inflight.size >= 200) {
              dropped++;
              stopOnViolation("dropped-arrival");
              resolve();
              return;
            }
            const task = sample(model).then((row) => {
              rows.push(row);
              const failure = projectedRequestFailure(row);
              if (failure) stopOnViolation(failure, row);
              inflight.delete(task);
              resolve();
            });
            inflight.add(task);
          }, i * 10);
          pendingTimers.set(timer, resolve);
        }),
    ),
  );
  stopped = true;
  await Promise.all([bg, controlLoop]);
  loopDelay.disable();
  // The HTTP/2 sessions are still alive when samples settle. Read per-socket
  // Linux recovery counters AFTER measuring all completed requests, not during
  // the timed request scheduler. No edge IP or bearer is persisted.
  const tcpAfter = irreversibleFailure
    ? await takeAnonymizedTcpSnapshot(stageTransportSessionSnapshot())
    : null;
  const slowestSessions = [...rows]
    .sort((a, b) => b.ms - a.ms)
    .slice(0, 8)
    .map((r) => r.transportSpan?.sessionId)
    .filter(Number.isInteger);
  const tcpEvidence = irreversibleFailure
    ? compareTcpSnapshots(tcpBefore, tcpAfter, slowestSessions)
    : null;
  if (tcpEvidence) console.log("ARCH_TCP_RECOVERY", JSON.stringify(tcpEvidence));
  const result = {
    tcpEvidence,
    clientEventLoopMaxMs: loopDelay.max / 1e6,
    clientEventLoopP99Ms: loopDelay.percentile(99) / 1e6,
    model,
    seconds: 120,
    targetRps: 100,
    offered: 12000,
    scheduled,
    cancelledUnsent,
    earlyStopped: !!irreversibleFailure,
    earlyStopReason: irreversibleFailure,
    elapsedSeconds: (performance.now() - start) / 1000,
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
  if (irreversibleFailure) {
    evidence.failFast = { model, ...irreversibleFailure, scheduled, cancelledUnsent };
    evidence.pass = false;
  }
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
          ray: row.ray,
          handlerMs: row.handlerMs,
          catalogServiceMs: row.catalogServiceMs,
          outsideHandlerMs: row.outsideHandlerMs,
          isolateFirst: row.isolateFirst,
          isolateOrdinal: row.isolateOrdinal,
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
  if (irreversibleFailure)
    throw Error("Release failed fast: " + irreversibleFailure.code + " (evidence preserved)");
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
      // R2 remains the durable source. KV is only an untrusted presentation
      // accelerator; every request still rechecks rights/prices on primary D1.
      await putPrivateStageKv(`campaign/${runId}/synthetic/` + key, body);
    },
  });
  /* eslint-disable prettier/prettier -- Bounded synthetic market fixture must be auditable. */
  // Recover a previous GitHub Actions cancellation before touching any
  // new fixture. This QA D1 contains only perf-synth-* products; permanent
  // content and production rights are physically separate. GitHub workflow
  // concurrency serializes hosted-capacity jobs on this database.
  const recovery = await api(
    "POST",
    `/accounts/${account}/d1/database/${primary}/query`,
    { batch: [
      { sql: `UPDATE products SET source_name='gutenberg'
          WHERE source_name='operator'
            AND id GLOB 'perf-synth-[0-9][0-9][0-9][0-9][0-9][0-9]'` },
      { sql: `DELETE FROM offers WHERE id LIKE 'cove-arch-qa-%'
          AND product_id GLOB 'perf-synth-[0-9][0-9][0-9][0-9][0-9][0-9]'` },
    ]},
  );
  evidence.recoveredSyntheticQA = {
    sourceLabels: recovery[0]?.meta?.changes ?? null,
    offers: recovery[1]?.meta?.changes ?? null,
  };
  const snapshot=JSON.parse(fs.readFileSync(directory + "/presentation.json","utf8"));
  // Existing 50k-row capacity fixture contains *operator-issued* retail grants
  // but mislabels all products Gutenberg and has no Gutenberg evidence or
  // offers. Those rows were categorically ineligible, so previous 200-shell
  // benchmarks measured an EMPTY bookstore. Make ONLY 24 synthetic QA cards
  // coherent with the grants they already own, then restore in cleanup.
  syntheticFixture=syntheticOperatorFixturePlan(snapshot.candidates?.productIds,runId);
  const preflight=await sql(primary,syntheticFixture.preflight.sql,syntheticFixture.preflight.params);
  assert.equal(preflight.results?.[0]?.n,REQUIRED_BOOK_CARDS,
    "Synthetic QA operator-grant fixture is missing authoritative US allow grants");
  const changed=await sql(primary,syntheticFixture.operatorize.sql,syntheticFixture.operatorize.params);
  assert.equal(changed.meta?.changes,REQUIRED_BOOK_CARDS,
    "Refused to mutate non-synthetic or already reassigned product provenance");
  fixtureActivated = true;
  const offerWrite=syntheticFixture.issueOffers;
  const added=await sql(primary,offerWrite.sql,offerWrite.params);
  assert.equal(added.meta?.changes,REQUIRED_BOOK_CARDS,
    "Synthetic QA storefront retail offers could not be activated");
  const proof=await sql(primary,syntheticFixture.verify.sql,syntheticFixture.verify.params);
  assert.equal(proof.results?.[0]?.n,REQUIRED_BOOK_CARDS,
    "No 24-book authoritative-and-purchasable synthetic storefront fixture");
  evidence.authenticatedFixture={operatorBooks:REQUIRED_BOOK_CARDS,
    legalAuthority:"live-primary-retail-grant",offerSource:"primary-only"};
  save();
  /* eslint-enable prettier/prettier */
  for (let round = 1; round <= 3; round++) {
    await deploy(round);
    const cold = await sample();
    evidence.cold.push(cold);
    save();
    console.log("ARCH_COLD", JSON.stringify({ round, ...cold }));
    const coldFailure = projectedRequestFailure(cold);
    if (failFast && coldFailure) {
      evidence.failFast = { stage: "cold", round, code: coldFailure, ms: cold.ms };
      save();
      throw Error("Release failed fast in cold deployment: " + coldFailure);
    }
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
    // Keep the absolute release gate unchanged, but make the first failing
    // burst diagnosable without downloading a private artifact. Retain the
    // complete unfiltered request samples in results.json for Ray analysis.
    console.log(
      "ARCH_BURST_TAIL",
      JSON.stringify({
        concurrency,
        ...summary(rows),
        slowest: [...rows]
          .sort((a, b) => b.ms - a.ms)
          .slice(0, 8)
          .map((row) => ({
            ok: row.ok,
            status: row.status,
            ms: row.ms,
            ray: row.ray,
            colo: row.colo,
            timing: row.timing,
            transportSpan: row.transportSpan,
            handlerMs: row.handlerMs,
            catalogServiceMs: row.catalogServiceMs,
            outsideHandlerMs: row.outsideHandlerMs,
            isolateFirst: row.isolateFirst,
            failure: row.failure,
            transportCode: row.transportCode,
            error: row.error,
          })),
      }),
    );
    const invalid = rows.find((row) => projectedRequestFailure(row));
    if (failFast && invalid) {
      evidence.failFast = {
        stage: "burst",
        concurrency,
        code: projectedRequestFailure(invalid),
        ms: invalid.ms,
      };
      save();
      throw Error("Release failed fast in burst: " + evidence.failFast.code);
    }
  }
  // Release runs only the two required projection phases. Canonical ABBA
  // attribution belongs in the explicitly selected full diagnostic workflow.
  const models = failFast
    ? ["projection", "projection"]
    : ["canonical", "projection", "projection", "canonical"];
  for (const model of models) await phase(model);
  const projected = evidence.phases.filter((p) => p.model === "projection");
  evidence.pass =
    evidence.cold.every((r) => r.ok && r.ms < 800) &&
    evidence.bursts.every((b) => b.valid === b.concurrency && b.max < 800) &&
    projected.length === 2 &&
    projected.every(strictProjectionPhasePass);
  save();
  assert.ok(
    evidence.pass,
    "Isolated architecture has not passed absolute release performance gates; inspect all raw evidence",
  );
} finally {
  await cleanup();
  if (evidence.cleanupFailed) throw Error("Stage cleanup failed");
}
