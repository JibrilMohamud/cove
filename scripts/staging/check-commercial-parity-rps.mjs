import assert from "node:assert/strict";
import fs from "node:fs";
import {
  stageFetch,
  stageTransport,
  stageTransportSpan,
  closeStageTransport,
} from "./stage-http-transport.mjs";
import { performance } from "node:perf_hooks";
import { AsyncLocalStorage } from "node:async_hooks";
import { channel } from "node:diagnostics_channel";
import { validateHtml, percentile } from "../check-production-storefront-performance.mjs";

const origin = "https://cove-commercial-parity-ssr-staging-20261020.cove-jibrilmohamud.workers.dev";
const token = process.env.COVE_SSR_STAGING_GATE_KEY;
const expectedArm = process.env.COVE_STAGE_EXPERIMENT_ARM;
if (expectedArm) assert.ok(["baseline", "one-read"].includes(expectedArm));
assert.match(token || "", /^[a-f0-9]{64}$/, "Never load test an unprotected origin");
const baseHeaders = {
  Authorization: "Bearer " + token,
  "Cache-Control": "no-store",
  "Accept-Encoding": "br, gzip, deflate",
};
const maxInflight = 192;
const context = new AsyncLocalStorage();
const requestContexts = new WeakMap();
channel("undici:request:create").subscribe(({ request }) => {
  const measurement = context.getStore();
  if (measurement && request?.origin === origin) {
    measurement.created = performance.now();
    requestContexts.set(request, measurement);
  }
});
channel("undici:client:sendHeaders").subscribe(({ request }) => {
  const m = requestContexts.get(request);
  if (m) m.sent = performance.now();
});
channel("undici:request:headers").subscribe(({ request }) => {
  const m = requestContexts.get(request);
  if (m) m.headers = performance.now();
});
const duration = (end, start) =>
  Number.isFinite(end) && Number.isFinite(start) ? Math.max(0, Math.round(end - start)) : null;
const timing = (value, name) => {
  const found = value.match(new RegExp("(?:^|,)\\s*" + name + ";dur=(\\d+(?:\\.\\d+)?)"));
  return found ? Number(found[1]) : null;
};
const asPercentiles = (values) => {
  const filtered = values.filter(Number.isFinite);
  return {
    count: filtered.length,
    p50: percentile(filtered, 0.5),
    p95: percentile(filtered, 0.95),
    p99: percentile(filtered, 0.99),
    max: Math.max(0, ...filtered),
  };
};
const destinations = [
  { name: "home", path: "/" },
  { name: "bootstrap", path: "/api/fore/storefront/bootstrap" },
  { name: "catalog", path: "/api/fore/catalog?search=&sort=popular&page=1&currency=USD" },
];
const transportFloor = { name: "transport_floor", path: "/__cove/stage/transport-floor" };
const select = (i) =>
  i % 10 < 6 ? destinations[0] : i % 10 < 9 ? destinations[1] : destinations[2];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
const stageReport = {
  transport: stageTransport,
  workerClock: "I/O-progress clock; cannot isolate CPU, queueing or network time",
  scope:
    "Cloudflare protected isolated 508-table staging DB, 1000 synthetic books; NO customer accounts, orders, music, production D1 or routing",
  limits: { maxInflight, hardTtfbMs: 800, p95Ms: 600, p99Ms: 750 },
  stages: [],
  commercialCertified: false,
};
async function fetchOne(route) {
  const started = performance.now();
  const span = {};
  let status = 0;
  try {
    const response = await context.run(span, () =>
      stageFetch(origin + route.path, {
        redirect: "manual",
        headers: {
          ...baseHeaders,
          Accept: route.name === "home" ? "text/html" : "application/json",
        },
        signal: AbortSignal.timeout(12000),
      }),
    );
    status = response.status;
    const ttfbMs = Math.round(performance.now() - started);
    const h2 = stageTransportSpan(response);
    if (h2) Object.assign(span, { created: h2.created, sent: h2.sent, headers: h2.received });
    const body = await response.text();
    const failureReasons = [];
    if (expectedArm && response.headers.get("x-cove-stage-context-mode") !== expectedArm)
      failureReasons.push("context-mode");
    if (
      expectedArm &&
      response.headers.get("x-cove-stage-bootstrap-transport") !==
        (expectedArm === "one-read" ? "primary-batch" : "individual")
    )
      failureReasons.push("bootstrap-transport");
    if (response.status !== 200) failureReasons.push("http-status");
    if (!/no-store/i.test(response.headers.get("cache-control") || ""))
      failureReasons.push("cache-policy");
    let valid = failureReasons.length === 0;
    if (valid && route.name === "home") {
      try {
        validateHtml(status, response.headers.get("content-type") || "", body);
      } catch {
        failureReasons.push("invalid-html");
      }
      if (!/cove_ssr_local_rights;dur=0/.test(response.headers.get("server-timing") || ""))
        failureReasons.push("live-rights-timing");
      valid = failureReasons.length === 0;
    } else if (valid) {
      try {
        const data = JSON.parse(body);
        if (route.name === "transport_floor") {
          valid = data?.kind === "transport_floor";
          if (!valid) failureReasons.push("invalid-transport-floor");
        } else if (route.name === "bootstrap") {
          valid =
            data.context?.rightsCountry === "US" &&
            Array.isArray(data.catalog?.results) &&
            data.catalog.results.length > 0 &&
            data.catalog.results.every((x) => String(x.productId).startsWith("p_stage_"));
          if (!valid) failureReasons.push("invalid-bootstrap");
        } else {
          // Search output is a public, authorized catalog: verify the exact
          // isolated synthetic product namespace, not simply HTTP status.
          const books = Array.isArray(data.results)
            ? data.results
            : Array.isArray(data.books)
              ? data.books
              : Array.isArray(data.catalog?.results)
                ? data.catalog.results
                : null;
          valid =
            Array.isArray(books) &&
            books.length > 0 &&
            books.every((x) => String(x.productId || x.id || "").startsWith("p_stage_"));
          if (!valid) failureReasons.push("invalid-catalog");
        }
      } catch {
        valid = false;
        failureReasons.push("invalid-json");
      }
    }
    const timingHeader = response.headers.get("server-timing") || "";
    const workerDispatchMs = timing(timingHeader, "cove_worker_dispatch");
    // Not measured network time: includes edge scheduling, service dispatch,
    // client transit and any provider delays outside our Worker timing span.
    const outsideWorkerMs =
      workerDispatchMs === null ? null : Math.max(0, Math.round(ttfbMs - workerDispatchMs));
    return {
      status,
      contextMode: response.headers.get("x-cove-stage-context-mode") || "unknown",
      bootstrapTransport: response.headers.get("x-cove-stage-bootstrap-transport") || "unknown",
      valid,
      failureReasons,
      ttfbMs,
      contentEncoding: response.headers.get("content-encoding") || "identity",
      decodedBytes: Buffer.byteLength(body, "utf8"),
      wireBytes: stageTransportSpan(response)?.wireBytes ?? null,
      totalMs: Math.round(performance.now() - started),
      outsideWorkerMs,
      class: route.name,
      queueMs: duration(span.sent, span.created),
      transportMs: duration(span.headers, span.sent),
      phases: Object.fromEntries(
        [
          "cove_entry",
          "cove_render",
          "cove_worker_dispatch",
          "cove_edge_floor",
          "cove_total",
          "cove_ssr_bootstrap",
          "cove_catalog",
          "cove_context",
          "cove_page",
          "cove_limit",
          "cove_backend_catalog",
          "cove_backend_catalog_sql",
          "cove_backend_context",
          "cove_backend_bootstrap",
          "cove_backend_limit",
          "cove_backend_page",
          "cove_auth",
          "cove_identity",
          "cove_catalog_query",
          "cove_catalog_rate_limit",
          "cove_lean_catalog",
          "cove_catalog_context",
          "cove_api",
          "cove_log_queued",
        ].map((key) => [key, timing(timingHeader, key)]),
      ),
      placement: response.headers.get("x-cove-stage-placement") || "unknown",
      colo: (response.headers.get("cf-ray") || "").match(/-([A-Z]{3})$/)?.[1] || "unknown",
    };
  } catch {
    return {
      status,
      valid: false,
      failureReasons: ["transport"],
      ttfbMs: Math.round(performance.now() - started),
      class: route.name,
      queueMs: duration(span.sent, span.created),
      transportMs: duration(span.headers, span.sent),
    };
  }
}
async function runStage(rate, seconds) {
  const offered = rate * seconds;
  const rows = [];
  const pending = new Set();
  let dropped = 0;
  const started = performance.now();
  for (let i = 0; i < offered; i++) {
    const due = started + (i * 1000) / rate;
    await sleep(due - performance.now());
    if (pending.size >= maxInflight) {
      dropped++;
      continue;
    }
    const job = fetchOne(select(i));
    pending.add(job);
    job.then((v) => rows.push(v)).finally(() => pending.delete(job));
  }
  const offeringElapsedMs = performance.now() - started;
  await Promise.allSettled([...pending]);
  const completionElapsedMs = performance.now() - started;
  const valid = rows.filter((x) => x.valid).length;
  const times = rows.map((x) => x.ttfbMs);
  const statusCounts = Object.fromEntries(
    [...new Set(rows.map((x) => x.status))].map((status) => [
      String(status),
      rows.filter((r) => r.status === status).length,
    ]),
  );
  const byRoute = Object.fromEntries(
    destinations.map((d) => [
      d.name,
      {
        offered: offered
          ? Array.from({ length: offered }, (_, i) => select(i).name).filter((x) => x === d.name)
              .length
          : 0,
        delivered: rows.filter((x) => x.class === d.name).length,
        valid: rows.filter((x) => x.class === d.name && x.valid).length,
        maxMs: Math.max(0, ...rows.filter((x) => x.class === d.name).map((x) => x.ttfbMs)),
      },
    ]),
  );
  const routeDiagnostics = Object.fromEntries(
    destinations.map((route) => {
      const subset = rows.filter((r) => r.class === route.name);
      return [
        route.name,
        {
          ttfb: asPercentiles(subset.map((r) => r.ttfbMs)),
          decodedBytes: asPercentiles(subset.map((r) => r.decodedBytes)),
          wireBytes: asPercentiles(subset.map((r) => r.wireBytes)),
          contentEncodings: [...new Set(subset.map((r) => r.contentEncoding).filter(Boolean))],
          clientQueue: asPercentiles(subset.map((r) => r.queueMs)),
          sentToHeaders: asPercentiles(subset.map((r) => r.transportMs)),
          outsideMeasuredWorker: asPercentiles(subset.map((r) => r.outsideWorkerMs)),
          serverTimings: Object.fromEntries(
            [
              "cove_worker_dispatch",
              "cove_total",
              "cove_ssr_bootstrap",
              "cove_catalog",
              "cove_context",
              "cove_page",
              "cove_limit",
              "cove_backend_catalog",
              "cove_backend_catalog_sql",
              "cove_backend_context",
              "cove_backend_bootstrap",
              "cove_backend_limit",
              "cove_backend_page",
              "cove_auth",
              "cove_identity",
              "cove_catalog_query",
              "cove_catalog_rate_limit",
              "cove_lean_catalog",
              "cove_catalog_context",
              "cove_api",
              "cove_log_queued",
            ].map((phase) => [phase, asPercentiles(subset.map((r) => r.phases?.[phase]))]),
          ),
          placement: [...new Set(subset.map((r) => r.placement).filter(Boolean))].sort(),
          colo: [...new Set(subset.map((r) => r.colo).filter(Boolean))].sort(),
        },
      ];
    }),
  );
  const result = {
    offered,
    delivered: rows.length,
    valid,
    failed: rows.length - valid,
    dropped,
    rps: rate,
    offeringElapsedMs: Math.round(offeringElapsedMs),
    completionElapsedMs: Math.round(completionElapsedMs),
    achievedCompletionRps: Number(((rows.length * 1000) / completionElapsedMs).toFixed(2)),
    diagnostics: routeDiagnostics,
    slowest: [...rows].sort((a, b) => b.ttfbMs - a.ttfbMs).slice(0, 8),
    // Fast failures must remain reviewable even when they fall outside the
    // slowest sample. These records contain only bounded aggregate telemetry.
    failedResponses: rows.filter((row) => !row.valid),
    seconds,
    statusCounts,
    byRoute,
    p50Ms: percentile(times, 0.5),
    p95Ms: percentile(times, 0.95),
    p99Ms: percentile(times, 0.99),
    maxMs: Math.max(0, ...times),
    pass:
      dropped === 0 &&
      valid === offered &&
      Math.max(...times) < 800 &&
      percentile(times, 0.95) <= 600 &&
      percentile(times, 0.99) <= 750,
  };
  stageReport.stages.push(result);
  return result;
}
/** Diagnostic floor is a separate campaign, never substituted for real traffic.
 * Run after the strict mixed workload to avoid prewarming its result. */
async function runTransportFloor() {
  const offered = 125;
  const rows = [];
  const pending = new Set();
  let dropped = 0;
  const started = performance.now();
  for (let i = 0; i < offered; i++) {
    await sleep(started + i * 40 - performance.now());
    if (pending.size >= maxInflight) {
      dropped++;
      continue;
    }
    const job = fetchOne(transportFloor);
    pending.add(job);
    job.then((row) => rows.push(row)).finally(() => pending.delete(job));
  }
  await Promise.allSettled([...pending]);
  const byColo = {};
  for (const row of rows) (byColo[row.colo || "unknown"] ??= []).push(row);
  return {
    offered,
    delivered: rows.length,
    valid: rows.filter((row) => row.valid).length,
    dropped,
    p95Ms: percentile(
      rows.map((row) => row.ttfbMs),
      0.95,
    ),
    maxMs: Math.max(0, ...rows.map((row) => row.ttfbMs)),
    outsideMeasuredWorker: asPercentiles(rows.map((row) => row.outsideWorkerMs)),
    colos: Object.fromEntries(
      Object.entries(byColo).map(([colo, subset]) => [
        colo,
        { count: subset.length, maxMs: Math.max(...subset.map((row) => row.ttfbMs)) },
      ]),
    ),
    // This validates the instrument only: it cannot certify storefront SLOs.
    diagnosticValid: dropped === 0 && rows.length === offered && rows.every((row) => row.valid),
  };
}
fs.mkdirSync("artifacts", { recursive: true });
try {
  // First verify individual account-free read routes before launching load.
  const probes = await Promise.all(destinations.map(fetchOne));
  stageReport.smoke = probes.map((p) => ({
    route: p.class,
    status: p.status,
    valid: p.valid,
    failureReasons: p.failureReasons,
  }));
  if (!probes.every((p) => p.valid)) {
    stageReport.reason = "One or more required actual API routes failed isolated smoke";
    process.exitCode = 1;
  } else {
    for (const [rps, seconds] of [
      [25, 5],
      [50, 6],
      [100, 10],
    ]) {
      const result = await runStage(rps, seconds);
      // No expensive extension if the candidate fails at low/medium RPS.
      if (!result.pass) break;
    }
    if (stageReport.stages.length === 3 && stageReport.stages.every((x) => x.pass)) {
      await runStage(100, 60);
    }
    if (!stageReport.stages.every((x) => x.pass)) process.exitCode = 1;
    if (process.env.COVE_STAGE_TRANSPORT_FLOOR === "1") {
      stageReport.transportFloor = await runTransportFloor();
      if (!stageReport.transportFloor.diagnosticValid) process.exitCode = 1;
    }
  }
} finally {
  fs.writeFileSync(
    `artifacts/commercial-parity-mixed-rps-${stageTransport}.json`,
    JSON.stringify(stageReport, null, 2),
  );
  console.log(JSON.stringify(stageReport));
  closeStageTransport();
}
