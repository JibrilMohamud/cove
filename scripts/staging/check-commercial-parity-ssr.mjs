import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { AsyncLocalStorage } from "node:async_hooks";
import { channel } from "node:diagnostics_channel";
import fs from "node:fs";
import {
  stageFetch,
  stageTransport,
  stageTransportSpan,
  closeStageTransport,
} from "./stage-http-transport.mjs";
import { validateHtml, percentile } from "../check-production-storefront-performance.mjs";

const origin = "https://cove-commercial-parity-ssr-staging-20261020.cove-jibrilmohamud.workers.dev";
const key = process.env.COVE_SSR_STAGING_GATE_KEY;
const expectedArm = process.env.COVE_STAGE_EXPERIMENT_ARM;
const expectedBootstrapTransport = expectedArm === "one-read" ? "primary-batch" : "individual";
if (expectedArm) assert.ok(["baseline", "one-read"].includes(expectedArm));
assert.match(key || "", /^[a-f0-9]{64}$/, "A temporary 256-bit staging bearer is mandatory");
const headers = {
  Authorization: "Bearer " + key,
  Accept: "text/html",
  "Accept-Encoding": "br, gzip, deflate",
  "Cache-Control": "no-store",
};
const traceContext = new AsyncLocalStorage();
const requests = new WeakMap();
channel("undici:request:create").subscribe(({ request }) => {
  const span = traceContext.getStore();
  if (span && request?.origin === origin) {
    span.created = performance.now();
    requests.set(request, span);
  }
});
channel("undici:client:sendHeaders").subscribe(({ request }) => {
  const span = requests.get(request);
  if (span) span.sent = performance.now();
});
channel("undici:request:headers").subscribe(({ request }) => {
  const span = requests.get(request);
  if (span) span.received = performance.now();
});
const elapsed = (a, b) =>
  Number.isFinite(a) && Number.isFinite(b) ? Math.max(0, Math.round(a - b)) : null;
const serverDuration = (header, key) => {
  const m = header.match(new RegExp("(?:^|,)\\s*" + key + ";dur=(\\d+(?:\\.\\d+)?)"));
  return m ? Number(m[1]) : null;
};
async function request(path = "/", options = {}) {
  const began = performance.now();
  const span = {};
  try {
    const response = await traceContext.run(span, () =>
      stageFetch(origin + path, {
        method: options.method || "GET",
        redirect: "manual",
        headers: options.noAuth ? { "Cache-Control": "no-store" } : headers,
        signal: AbortSignal.timeout(15000),
      }),
    );
    const ttfbMs = Math.round(performance.now() - began);
    Object.assign(span, stageTransportSpan(response));
    const body = await response.text();
    return {
      status: response.status,
      contextMode: response.headers.get("x-cove-stage-context-mode") || "unknown",
      bootstrapTransport: response.headers.get("x-cove-stage-bootstrap-transport") || "unknown",
      ttfbMs,
      contentEncoding: response.headers.get("content-encoding") || "identity",
      decodedBytes: Buffer.byteLength(body, "utf8"),
      wireBytes: stageTransportSpan(response)?.wireBytes ?? null,
      totalMs: Math.round(performance.now() - began),
      body,
      contentType: response.headers.get("content-type") || "",
      cacheControl: response.headers.get("cache-control") || "",
      timings: response.headers.get("server-timing") || "",
      placement: response.headers.get("x-cove-stage-placement") || "unknown",
      colo: (response.headers.get("cf-ray") || "").match(/-([A-Z]{3})$/)?.[1] || "unknown",
      clientQueueMs: elapsed(span.sent, span.created),
      clientSentToHeadersMs: elapsed(span.received, span.sent),
    };
  } catch {
    return {
      status: 0,
      ttfbMs: Math.round(performance.now() - began),
      body: "",
      contentType: "",
      cacheControl: "",
      timings: "",
      colo: "unknown",
      clientQueueMs: null,
      clientSentToHeadersMs: null,
    };
  }
}
const results = {
  transport: stageTransport,
  workerClock: "I/O-progress clock; cannot isolate CPU, queueing or network time",
  scope: "schema-parity isolated D1, 1000 SYNTHETIC books, zero customer accounts/orders",
  validations: {},
  waves: [],
};
let denied = { status: 0 };
for (let i = 0; i < 15; i++) {
  denied = await request("/", { noAuth: true });
  if (denied.status === 401) break;
  await new Promise((r) => setTimeout(r, 1000));
}
assert.equal(denied.status, 401, "Protected stage must deny unauthenticated homepage");
results.validations.unauthorized401 = true;
let ready = { status: 0 };
for (let attempt = 0; attempt < 20; attempt++) {
  ready = await request("/api/fore/health/ready");
  if (
    ready.status === 200 &&
    (!expectedArm ||
      (ready.contextMode === expectedArm &&
        ready.bootstrapTransport === expectedBootstrapTransport))
  )
    break;
  await new Promise((resolve) => setTimeout(resolve, 1000));
}
assert.equal(ready.status, 200, "Authorized D1 readiness must pass before performance sampling");
if (expectedArm) {
  assert.equal(ready.contextMode, expectedArm, "Fresh deployment arm must be active");
  assert.equal(
    ready.bootstrapTransport,
    expectedBootstrapTransport,
    "Fresh bootstrap transport must be active",
  );
}
const health = JSON.parse(ready.body);
assert.equal(health.ok, true);
assert.equal(health.database, true);
results.validations.isolatedD1Ready = true;
results.validations.experimentArm = expectedArm || "unspecified";
const post = await request("/", { method: "POST" });
assert.equal(post.status, 405, "Protected SSR must reject POST");
results.validations.authenticatedWritesDenied = true;
const bootstrap = await request("/api/fore/storefront/bootstrap");
if (bootstrap.status !== 200) {
  const message = bootstrap.body.slice(0, 400).replace(/Bearer\\s+[\\w.-]+/gi, "Bearer ");
  console.error(
    JSON.stringify({
      stage: "catalog-bootstrap",
      status: bootstrap.status,
      contentType: bootstrap.contentType,
      serverTiming: bootstrap.timings.slice(0, 200),
      responsePreview: message,
    }),
  );
}
assert.equal(bootstrap.status, 200, "Authorized synthetic catalog bootstrap must return 200");
const catalog = JSON.parse(bootstrap.body);
assert.ok(catalog.catalog?.results?.length > 0, "Rights-authorized catalog must not be empty");
assert.equal(catalog.context?.rightsCountry, "US");
results.validations.liveUSRights = true;
const waves = [
  { concurrency: 1, requests: 4 },
  { concurrency: 4, requests: 8 },
  { concurrency: 8, requests: 16 },
  { concurrency: 16, requests: 24 },
  { concurrency: 32, requests: 32 },
];
for (const wave of waves) {
  let next = 0;
  const rows = [];
  await Promise.all(
    Array.from({ length: wave.concurrency }, async () => {
      while (next < wave.requests) {
        next++;
        const response = await request("/");
        let cards = 0;
        try {
          cards = validateHtml(response.status, response.contentType, response.body);
        } catch {}
        rows.push({
          status: response.status,
          cards,
          ttfbMs: response.ttfbMs,
          contentEncoding: response.contentEncoding,
          decodedBytes: response.decodedBytes,
          wireBytes: response.wireBytes,
          totalMs: response.totalMs,
          contextMode: response.contextMode,
          bootstrapTransport: response.bootstrapTransport,
          colo: response.colo,
          placement: response.placement,
          clientQueueMs: response.clientQueueMs,
          clientSentToHeadersMs: response.clientSentToHeadersMs,
          dispatchMs: serverDuration(response.timings, "cove_worker_dispatch"),
          workerTotalMs: serverDuration(response.timings, "cove_total"),
          bootstrapMs: serverDuration(response.timings, "cove_ssr_bootstrap"),
          catalogMs: serverDuration(response.timings, "cove_backend_catalog"),
          catalogSqlMs: serverDuration(response.timings, "cove_backend_catalog_sql"),
          pageMs: serverDuration(response.timings, "cove_backend_page"),
          contextMs: serverDuration(response.timings, "cove_backend_context"),
          limitMs: serverDuration(response.timings, "cove_backend_limit"),
          edgeBootstrapMs: serverDuration(response.timings, "cove_backend_bootstrap"),
          authorized:
            (!expectedArm || response.contextMode === expectedArm) &&
            (!expectedArm || response.bootstrapTransport === expectedBootstrapTransport) &&
            !!cards &&
            response.status === 200 &&
            /no-store/i.test(response.cacheControl) &&
            /cove_ssr_local_rights;dur=0/.test(response.timings),
          hasRightsTiming: /cove_ssr_local_rights;dur=0/.test(response.timings),
          hasNoStore: /no-store/i.test(response.cacheControl),
        });
      }
    }),
  );
  const times = rows.map((x) => x.ttfbMs);
  const valid = rows.filter((x) => x.authorized).length;
  const summary = {
    concurrency: wave.concurrency,
    offered: wave.requests,
    valid,
    failed: wave.requests - valid,
    statusCounts: Object.fromEntries(
      [...new Set(rows.map((x) => x.status))].map((status) => [
        String(status),
        rows.filter((x) => x.status === status).length,
      ]),
    ),
    invalidWithoutCards: rows.filter((x) => !x.cards).length,
    invalidWithoutRightsTiming: rows.filter((x) => !x.hasRightsTiming).length,
    invalidWithoutNoStore: rows.filter((x) => !x.hasNoStore).length,
    p50Ms: percentile(times, 0.5),
    p95Ms: percentile(times, 0.95),
    maxMs: Math.max(...times),
    placements: [...new Set(rows.map((x) => x.placement).filter(Boolean))].sort(),
    slowest: [...rows].sort((a, b) => b.ttfbMs - a.ttfbMs).slice(0, 5),
    colocations: [...new Set(rows.map((x) => x.colo))].sort(),
    p95WorkerDispatchMs: percentile(rows.map((x) => x.dispatchMs).filter(Number.isFinite), 0.95),
    p95WorkerMs: percentile(rows.map((x) => x.workerTotalMs).filter(Number.isFinite), 0.95),
    p95CatalogMs: percentile(rows.map((x) => x.catalogMs).filter(Number.isFinite), 0.95),
    p95CatalogSqlMs: percentile(rows.map((x) => x.catalogSqlMs).filter(Number.isFinite), 0.95),
    p95ContextMs: percentile(rows.map((x) => x.contextMs).filter(Number.isFinite), 0.95),
    p95PageMs: percentile(rows.map((x) => x.pageMs).filter(Number.isFinite), 0.95),
    p95LimitMs: percentile(rows.map((x) => x.limitMs).filter(Number.isFinite), 0.95),
    p95EdgeBootstrapMs: percentile(
      rows.map((x) => x.edgeBootstrapMs).filter(Number.isFinite),
      0.95,
    ),
    p95BootstrapMs: percentile(rows.map((x) => x.bootstrapMs).filter(Number.isFinite), 0.95),
    p95ClientQueueMs: percentile(rows.map((x) => x.clientQueueMs).filter(Number.isFinite), 0.95),
    p95SentToHeadersMs: percentile(
      rows.map((x) => x.clientSentToHeadersMs).filter(Number.isFinite),
      0.95,
    ),
    pass: valid === wave.requests && Math.max(...times) < 800,
  };
  results.waves.push(summary);
}
results.validations.noFastUnauthorizedResponses = results.waves.every((w) => w.valid === w.offered);
results.performancePass = results.waves.every((w) => w.pass);
results.commercialCertified = false;
fs.mkdirSync("artifacts", { recursive: true });
fs.writeFileSync(
  `artifacts/commercial-parity-ssr-smoke-${stageTransport}.json`,
  JSON.stringify(results, null, 2),
);
console.log(JSON.stringify(results));
if (!results.performancePass) process.exitCode = 1;

closeStageTransport();
