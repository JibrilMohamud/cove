// Synthetic-only protected latency attribution ladder. This is diagnostic,
// not a release gate and not a valid substitute for full-page rights/LCP tests.
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { AsyncLocalStorage } from "node:async_hooks";
import { channel } from "node:diagnostics_channel";
import { percentile, validateHtml } from "../check-production-storefront-performance.mjs";

const stages = ["edge", "d1", "rights", "bootstrap", "ssr"];
const requests = Object.freeze([
  { concurrency: 1, requests: 1 },
  { concurrency: 4, requests: 4 },
  { concurrency: 8, requests: 8 },
]);
// 5*13 + 32 edge + 32 rights + 32 SSR = 161 requests/cohort, under
// the unchanged per-colo staging limit of 180 requests per minute.
// Existing full-page trials run before this after a 65-second cool-off.
const extra = Object.freeze([
  { stage: "edge", concurrency: 32, requests: 32 },
  { stage: "rights", concurrency: 32, requests: 32 },
  { stage: "ssr", concurrency: 32, requests: 32 },
]);
const store = new AsyncLocalStorage();
const spans = new WeakMap();
channel("undici:request:create").subscribe(({ request }) => {
  const s = store.getStore();
  if (!s || !request || request.method !== "GET") return;
  s.createdAt = performance.now();
  spans.set(request, s);
});
channel("undici:client:sendHeaders").subscribe(({ request }) => {
  const s = spans.get(request);
  if (s) s.sentAt = performance.now();
});
channel("undici:request:headers").subscribe(({ request }) => {
  const s = spans.get(request);
  if (s) s.headersAt = performance.now();
});
// Instrument DNS+TCP+TLS *combined* only for exactly one active request.
// Under concurrency, connection events are not request-correlatable; record
// null instead of assigning some other request's handshake to this sample.
let serialConnection = null;
channel("undici:client:beforeConnect").subscribe(({ connectParams }) => {
  if (serialConnection && connectParams?.hostname === serialConnection.hostname)
    serialConnection.span.connectBeginAt = performance.now();
});
channel("undici:client:connected").subscribe(({ connectParams }) => {
  if (serialConnection && connectParams?.hostname === serialConnection.hostname)
    serialConnection.span.connectEndAt = performance.now();
});

function delta(a, b) {
  return Number.isFinite(a) && Number.isFinite(b) ? Math.round(Math.max(0, a - b)) : null;
}
function metric(header, key) {
  const found = (header || "").split(",").map((x) => x.trim())
    .map((s) => s.match(new RegExp("^" + key + ";\\s*dur=(\\d+(?:\\.\\d+)?)", "i")))
    .find(Boolean);
  return found ? Number(found[1]) : null;
}
function timingNumbers(headers) {
  const raw = headers.get("server-timing") || "";
  // cfWorker is provided by Cloudflare only if zone/RUM rules enable it.
  // cove_total excludes CPU time on Workers; never subtract it from TTFB
  // and label the difference as network latency.
  return {
    cfWorkerMs: metric(raw, "cfWorker"),
    coveTotalIoClockMs: metric(raw, "cove_total"),
    coveRenderIoClockMs: metric(raw, "cove_render"),
    coveBootstrapIoClockMs: metric(raw, "cove_ssr_bootstrap"),
  };
}
function colo(headers) {
  return (headers.get("cf-ray") || "").match(/-([A-Z]{3})$/)?.[1] || "unknown";
}
const languages = ["en-US,en;q=0.9", "es-ES,es;q=0.9", "fr-FR,fr;q=0.9"];
let seq = 0;
async function one(cohort, stage, concurrency) {
  const sequence = ++seq;
  const begin = performance.now();
  const span = {};
  let status = 0;
  try {
    const origin = `https://${cohort.name}.cove-jibrilmohamud.workers.dev`;
    if (concurrency === 1)
      serialConnection = { hostname: new URL(origin).hostname, span };
    const response = await store.run(span, () => fetch(
      origin + (stage === "ssr" ? "/" : "/__cove_perf/" + stage),
      {
        method: "GET",
        redirect: "manual",
        headers: {
          Authorization: "Bearer " + cohort.key,
          Accept: stage === "ssr" ? "text/html" : "application/json",
          "Accept-Language": languages[sequence % languages.length],
          "Cache-Control": "no-store",
        },
        signal: AbortSignal.timeout(15000),
      },
    ));
    status = response.status;
    const ttfbMs = delta(performance.now(), begin);
    const body = await response.text();
    const totalMs = delta(performance.now(), begin);
    assert.equal(status, 200);
    assert.match(response.headers.get("cache-control") || "", /no-store/);
    let books = null, sqlMs = null, rowsRead = null;
    if (stage === "ssr") {
      books = validateHtml(status, response.headers.get("content-type") || "", body);
      assert.ok(books > 0, "Full rights-eligible HTML shelf missing");
      assert.match(response.headers.get("server-timing") || "", /cove_ssr_local_rights;dur=0/);
    } else {
      assert.equal(response.headers.get("x-cove-diagnostic"), stage);
      const data = JSON.parse(body);
      assert.equal(data.stage, stage);
      assert.equal(data.ok, true);
      if (stage === "rights" || stage === "bootstrap") {
        assert.ok(Number.isInteger(data.books) && data.books > 0);
        books = data.books;
      }
      if (stage === "rights") {
        sqlMs = Number.isFinite(data.sqlMs) ? data.sqlMs : null;
        rowsRead = Number.isInteger(data.rowsRead) ? data.rowsRead : null;
      }
    }
    return {
      sequence, stage, concurrency, status, valid: true,
      ttfbMs, totalMs, colo: colo(response.headers),
      clientQueueMs: delta(span.sentAt, span.createdAt),
      sentToHeadersMs: delta(span.headersAt, span.sentAt),
      connectMs: concurrency === 1 ? delta(span.connectEndAt, span.connectBeginAt) : null,
      connectionAttribution: concurrency === 1 ? "serial-handshake-only-when-observed" : "unattributable-under-concurrency",
      ...timingNumbers(response.headers),
      sqlMs, rowsRead, books,
    };
  } catch {
    return {
      sequence, stage, concurrency, status, valid: false,
      ttfbMs: delta(performance.now(), begin),
      clientQueueMs: delta(span.sentAt, span.createdAt),
      sentToHeadersMs: delta(span.headersAt, span.sentAt),
      connectMs: concurrency === 1 ? delta(span.connectEndAt, span.connectBeginAt) : null,
      error: "request-or-authorization-or-content-invalid",
      colo: "unknown",
    };
  } finally {
    if (concurrency === 1 && serialConnection?.span === span) serialConnection = null;
  }
}
async function wave(cohort, stage, concurrency, count) {
  const rows = [];
  let next = 0;
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (next < count) {
      next++;
      rows.push(await one(cohort, stage, concurrency));
    }
  }));
  return rows;
}
function summarize(rows, stage, concurrency) {
  const subset = rows.filter((v) => v.stage === stage && v.concurrency === concurrency);
  const valid = subset.filter((v) => v.valid);
  const times = valid.map((x) => x.ttfbMs);
  const numeric = (k) => valid.map((x) => x[k]).filter(Number.isFinite);
  const describe = (values) => values.length ? {
    p50: percentile(values, .5), p95: percentile(values, .95),
    p99: percentile(values, .99), max: Math.max(...values),
  } : null;
  return {
    stage, concurrency, requested: subset.length, valid: valid.length,
    latencyMs: describe(times),
    cfWorkerMs: describe(numeric("cfWorkerMs")),
    workerMetricCoverage: numeric("cfWorkerMs").length,
    sqlMs: describe(numeric("sqlMs")),
    rowsRead: describe(numeric("rowsRead")),
    queueMs: describe(numeric("clientQueueMs")),
    colos: [...new Set(valid.map((x) => x.colo))].sort(),
    pass: subset.length > 0 && valid.length === subset.length,
  };
}

export async function runAttributionLadder(cohorts, { coolOffMs = 65000 } = {}) {
  assert.equal(process.env.COVE_PAIR_RELEASE_FREEZE, "1");
  assert.equal(cohorts.baseline?.sha, cohorts.current?.sha,
    "Diagnostic comparison must run identical binary on both arms");
  for (const c of Object.values(cohorts)) {
    assert.match(c.key || "", /^[a-f0-9]{64}$/);
    assert.match(c.name, /^cove-lazyfacet-(control|candidate)-staging$/);
  }
  await new Promise((resolve) => setTimeout(resolve, coolOffMs));
  const results = { baseline: [], current: [] };
  // Alternating paired order, not asynchronous concurrent experiments.
  for (const [index, stage] of stages.entries()) {
    for (const { concurrency, requests: count } of requests) {
      const order = index % 2 ? ["current", "baseline"] : ["baseline", "current"];
      for (const role of order)
        results[role].push(...await wave(cohorts[role], stage, concurrency, count));
    }
  }
  for (const [index, spec] of extra.entries()) {
    const order = index % 2 ? ["current", "baseline"] : ["baseline", "current"];
    for (const role of order)
      results[role].push(...await wave(cohorts[role], spec.stage, spec.concurrency, spec.requests));
  }
  const summary = {};
  for (const role of ["baseline", "current"]) {
    summary[role] = [
      ...stages.flatMap(stage => requests.map(w => summarize(results[role], stage, w.concurrency))),
      ...extra.map(w => summarize(results[role], w.stage, w.concurrency)),
    ];
  }
  const overlap = summary.baseline.map((row, i) => ({
    stage: row.stage,
    concurrency: row.concurrency,
    sharedColos: row.colos.filter((x) => summary.current[i].colos.includes(x)),
  }));
  return {
    version: 1,
    kind: "same-commit-reproducibility-not-a-code-AB-test",
    syntheticOnly: true,
    releaseEligible: false,
    clientRegion: process.env.COVE_PERF_CLIENT_REGION || "unverified-gh-runner",
    clientRegionVerified: false,
    timingWarning:
      "JS Worker clocks omit CPU. cfWorker missing is unknown, not zero. D1 sqlMs omits service queue/transport. Sample-set percentiles and stage deltas are not additive or per-request causal attribution.",
    runnerConnections:
      "same Node runner uses pooled fetches; when and only when a sole serial request observes Undici beforeConnect/connected, connectMs measures combined DNS+TCP+TLS. No separate DNS/TLS breakdown; parallel connect metrics are null.",
    byRole: results,
    summaries: summary,
    overlap,
    matchedColos: overlap.every((r) => r.sharedColos.length > 0),
    allValid: [...results.baseline, ...results.current].every((x) => x.valid),
  };
}
