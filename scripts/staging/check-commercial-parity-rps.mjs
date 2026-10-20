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
assert.match(token || "", /^[a-f0-9]{64}$/, "Never load test an unprotected origin");
const baseHeaders = { Authorization: "Bearer " + token, "Cache-Control": "no-store" };
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
const select = (i) =>
  i % 10 < 6 ? destinations[0] : i % 10 < 9 ? destinations[1] : destinations[2];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
const stageReport = {
  transport: stageTransport,
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
    let valid =
      response.status === 200 && /no-store/i.test(response.headers.get("cache-control") || "");
    if (valid && route.name === "home") {
      try {
        valid =
          validateHtml(status, response.headers.get("content-type") || "", body) > 0 &&
          /cove_ssr_local_rights;dur=0/.test(response.headers.get("server-timing") || "");
      } catch {
        valid = false;
      }
    } else if (valid) {
      try {
        const data = JSON.parse(body);
        if (route.name === "bootstrap") {
          valid =
            data.context?.rightsCountry === "US" &&
            Array.isArray(data.catalog?.results) &&
            data.catalog.results.length > 0 &&
            data.catalog.results.every((x) => String(x.productId).startsWith("p_stage_"));
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
        }
      } catch {
        valid = false;
      }
    }
    const timingHeader = response.headers.get("server-timing") || "";
    return {
      status,
      valid,
      ttfbMs,
      class: route.name,
      queueMs: duration(span.sent, span.created),
      transportMs: duration(span.headers, span.sent),
      phases: Object.fromEntries(
        [
          "cove_entry",
          "cove_render",
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
  await Promise.allSettled([...pending]);
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
          clientQueue: asPercentiles(subset.map((r) => r.queueMs)),
          sentToHeaders: asPercentiles(subset.map((r) => r.transportMs)),
          serverTimings: Object.fromEntries(
            [
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
    diagnostics: routeDiagnostics,
    slowest: [...rows].sort((a, b) => b.ttfbMs - a.ttfbMs).slice(0, 8),
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
fs.mkdirSync("artifacts", { recursive: true });
try {
  // First verify individual account-free read routes before launching load.
  const probes = await Promise.all(destinations.map(fetchOne));
  stageReport.smoke = probes.map((p) => ({ route: p.class, status: p.status, valid: p.valid }));
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
  }
} finally {
  fs.writeFileSync(
    `artifacts/commercial-parity-mixed-rps-${stageTransport}.json`,
    JSON.stringify(stageReport, null, 2),
  );
  console.log(JSON.stringify(stageReport));
  closeStageTransport();
}
