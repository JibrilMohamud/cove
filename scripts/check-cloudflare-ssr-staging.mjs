import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { channel } from "node:diagnostics_channel";
import {
  requestedLanguages,
  probeSequence,
  validateHtml,
  percentile,
  safeProbeTelemetry,
  safeCloudflareRay,
  productionOrigin,
} from "./check-production-storefront-performance.mjs";

const origin = productionOrigin(
  process.env.COVE_SSR_STAGING_ORIGIN ||
    "https://cove-storefront-ssr-staging.cove-jibrilmohamud.workers.dev",
);
const token = process.env.COVE_SSR_STAGING_GATE_KEY;
assert.match(token || "", /^[a-f0-9]{64}$/, "Ephemeral staging key required.");

// Undici request lifecycle is strictly diagnostic: these events never affect
// correctness, retries, the request order, or the hard <800 ms TTFB gate.
// Capture numeric phases only. Never retain request objects, IPs or headers.
let activeProbe = null;
const requestSpans = new WeakMap();
channel("undici:request:create").subscribe(({ request }) => {
  if (
    !activeProbe ||
    request?.origin !== origin ||
    request?.path !== "/" ||
    request?.method !== "GET"
  ) {
    return;
  }
  const span = activeProbe;
  span.createdAt = performance.now();
  requestSpans.set(request, span);
});
channel("undici:client:sendHeaders").subscribe(({ request }) => {
  const span = requestSpans.get(request);
  if (span) span.sentAt = performance.now();
});
channel("undici:request:headers").subscribe(({ request }) => {
  const span = requestSpans.get(request);
  if (span) span.headersAt = performance.now();
});
// Connect diagnostics are scoped to the one active first-paint GET. They keep
// only durations, never socket details, remote addresses or request headers.
const probeHostname = new URL(origin).hostname;
channel("undici:client:beforeConnect").subscribe(({ connectParams }) => {
  if (activeProbe && connectParams?.hostname === probeHostname)
    activeProbe.connectStartedAt = performance.now();
});
channel("undici:client:connected").subscribe(({ connectParams }) => {
  if (activeProbe && connectParams?.hostname === probeHostname)
    activeProbe.connectDoneAt = performance.now();
});

function integerDelta(after, before) {
  return Number.isFinite(after) && Number.isFinite(before)
    ? Math.max(0, Math.round(after - before))
    : null;
}

function numericWorkerTiming(headers) {
  const parts = (headers.get("server-timing") || "").split(",");
  const matched = parts
    .map((item) => item.trim().match(/^cove_total;dur=(\d+(?:\.\d+)?)$/))
    .find(Boolean);
  return matched ? Number(matched[1]) : null;
}

function safeCloudflareColo(headers) {
  return safeCloudflareRay(headers)?.split("-")[1] || "unknown";
}

function headers(extra = {}) {
  return { Authorization: "Bearer " + token, ...extra };
}

async function waitForUnauthenticatedDenial(pathname) {
  // A newly written Worker secret is deployed to the global edge asynchronously.
  // A missing-secret 503 is fail-closed, but not ready for benchmark sampling.
  // Never mistake a cached 200 or an unprotected asset for readiness.
  let lastStatus = 0;
  let lastType = "";
  let lastBody = "";
  for (let attempt = 0; attempt < 15; attempt += 1) {
    const response = await fetch(origin + pathname, {
      redirect: "manual",
      signal: AbortSignal.timeout(12_000),
    });
    lastStatus = response.status;
    lastType = response.headers.get("content-type") || "";
    if (lastStatus === 401) return;
    if (lastStatus !== 503) break;
    // This endpoint is unauthenticated: body is either our fail-closed
    // message or Cloudflare's generic Worker error page.
    lastBody = (await response.text()).slice(0, 120).replace(/\s+/g, " ");
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(
    `Stage protection not ready: path=${pathname}, status=${lastStatus}, type=${lastType}, body=${JSON.stringify(lastBody)}`,
  );
}

async function assertProtected() {
  await waitForUnauthenticatedDenial("/");
  await waitForUnauthenticatedDenial("/assets/not-real.js");
  // The unauthenticated 401 proves the gate is closed but says nothing
  // about which generation of an ephemeral secret an edge instance holds.
  // A freshly rotated token must be accepted BEFORE benchmarking begins.
  // 405 is the only successful read-only proof. Neither 401 nor 503 passes.
  let mutationStatus = 0;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const deniedMutation = await fetch(origin + "/", {
      method: "POST",
      headers: headers(),
      redirect: "manual",
      signal: AbortSignal.timeout(12_000),
    });
    mutationStatus = deniedMutation.status;
    if (mutationStatus === 405) break;
    if (mutationStatus !== 401 && mutationStatus !== 503) break;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  assert.equal(
    mutationStatus,
    405,
    "Staging must accept the newly rotated secret and reject writes",
  );
}

async function assertLocalDatabaseReady() {
  const res = await fetch(origin + "/api/fore/health/ready", {
    headers: headers(),
    redirect: "manual",
    signal: AbortSignal.timeout(12_000),
  });
  let state = {};
  try {
    const value = await res.json();
    state = value && typeof value === "object" ? value : {};
  } catch {
    // A non-JSON result is not a successful D1 readiness response.
  }
  const ready = state;
  if (res.status !== 200 || ready.database !== true || ready.ok !== true) {
    throw new Error(
      `Native SSR D1 health check failed: http=${res.status}, database=${ready.database === true}, activeMarkets=${Number(ready.activeMarkets || 0)}, ready=${ready.ok === true}`,
    );
  }
}

async function assertRightsIsolation() {
  const endpoint = origin + "/api/fore/storefront/bootstrap";
  const common = { redirect: "manual", signal: AbortSignal.timeout(12_000) };
  const first = await fetch(endpoint, { ...common, headers: headers() });
  if (first.status !== 200) {
    const text = await first.text();
    const category = text.includes("Unable to verify storefront territory")
      ? "untrusted-country"
      : text.includes("No active Cove storefront market")
        ? "market-configuration"
        : text.includes("unhandled")
          ? "unhandled-server-error"
          : "other-fail-closed";
    const phases = safeProbeTelemetry(first.headers, 0, 0).timing;
    throw new Error(
      `Direct D1 staging bootstrap failed: http=${first.status}, kind=${category}, phases=${phases}`,
    );
  }
  const expected = await first.json();
  assert.match(expected.context.rightsCountry, /^[A-Z]{2}$/);
  // A GitHub runner can enter Cloudflare through a non-US colo (e.g. YUL).
  // Current merchandise has no independently authorized Canadian editions.
  // Do not call that lawful empty shelf either a speed pass or an SSR bug,
  // and NEVER force a US country with client-controlled headers.
  assert.ok(
    expected.catalog.results.length >= 1,
    `LICENSED_STOREFRONT_GEO_UNAVAILABLE: actual Cloudflare country=${expected.context.rightsCountry}; zero permitted first-paint books. This run cannot certify a populated licensed homepage; rerun from authorized physical egress. Do not spoof country or relax the 800ms gate.`,
  );
  const forged = await fetch(endpoint, {
    ...common,
    headers: headers({
      "x-cove-client-country": "ZZ",
      "cf-ipcountry": "ZZ",
      "x-vercel-ip-country": "ZZ",
    }),
  });
  assert.equal(forged.status, 200);
  const untrusted = await forged.json();
  assert.equal(
    untrusted.context.rightsCountry,
    expected.context.rightsCountry,
    "Spoofable HTTP country headers cannot change licensed inventory",
  );
  assert.deepEqual(
    untrusted.catalog.results.map((book) => book.productId),
    expected.catalog.results.map((book) => book.productId),
    "Country spoofing cannot alter book eligibility",
  );
}

async function probe(language, sample, sequence) {
  const started = performance.now();
  const span = {};
  activeProbe = span;
  let response, ttfbMs;
  try {
    response = await fetch(origin + "/", {
      headers: headers({ Accept: "text/html", "Accept-Language": language }),
      redirect: "manual",
      signal: AbortSignal.timeout(15_000),
    });
    ttfbMs = Math.round(performance.now() - started);
  } finally {
    activeProbe = null;
  }
  const html = await response.text();
  const totalMs = Math.round(performance.now() - started);
  const cards = validateHtml(response.status, response.headers.get("content-type") || "", html);
  if (!/no-store/.test(response.headers.get("cache-control") || ""))
    throw new Error("Stage homepage must never be cached.");
  if (!/cove_ssr_local_rights;dur=0/.test(response.headers.get("server-timing") || ""))
    throw new Error("No evidence of in-Worker D1 rights authority.");
  // Stage anonymous SSR is an exact expected use of the lightweight Worker
  // reader. Fail rather than unknowingly measuring a heavyweight API fallback.
  if (!/cove_backend_lean;dur=0(?:\.0)?(?:,|$)/.test(response.headers.get("server-timing") || ""))
    throw new Error("Native first-paint did not use the rights-authoritative lean guest path.");
  const workerMs = numericWorkerTiming(response.headers);
  return {
    language,
    sample,
    sequence,
    cards,
    ...safeProbeTelemetry(response.headers, ttfbMs, totalMs),
    workerMs,
    unattributedMs: workerMs === null ? null : Math.max(0, Math.round(ttfbMs - workerMs)),
    cfColo: safeCloudflareColo(response.headers),
    cfRay: safeCloudflareRay(response.headers),
    clientQueueMs: integerDelta(span.sentAt, span.createdAt),
    clientConnectMs: integerDelta(span.connectDoneAt, span.connectStartedAt),
    clientToHeadersMs: integerDelta(span.headersAt, span.sentAt),
  };
}

const results = [];
const failures = [];
// First real SSR request precedes the D1 health and API rights probes.
// Those preflights previously warmed the entire application and masked a
// genuine fresh-deployment SSR cold path. Every one of the 20 requests counts.
const sequence = probeSequence();
const measure = async ({ language, sample, sequence: order }) => {
  try {
    results.push(await probe(language, sample, order));
  } catch (error) {
    failures.push({ sequence: order, language, sample, error: String(error).slice(0, 300) });
  }
};
// The very first request to the freshly deployed Worker version MUST execute
// actual SSR, before even unauthenticated 401 checks can warm its JS isolate.
// A not-yet-propagated secret (401/503) fails the cold gate; never discount it.
await measure(sequence[0]);
await assertProtected();
await assertLocalDatabaseReady();
await assertRightsIsolation();
for (const entry of sequence.slice(1)) await measure(entry);
const allPass =
  failures.length === 0 &&
  results.length === requestedLanguages.length * 4 &&
  results.every((r) => r.ttfbMs < 800 && r.cards >= 1);
const summary = {
  status: allPass ? "pass" : "fail",
  targetMs: 800,
  successes: results.length,
  errors: failures.length,
  slowSamples: results.filter((r) => r.ttfbMs >= 800).length,
  p75: percentile(
    results.map((r) => r.ttfbMs),
    0.75,
  ),
  p95: percentile(
    results.map((r) => r.ttfbMs),
    0.95,
  ),
  results,
  failures,
};
fs.mkdirSync("artifacts", { recursive: true });
fs.writeFileSync(
  "artifacts/cloudflare-ssr-staging-performance.json",
  JSON.stringify(summary, null, 2) + "\n",
);
const table = [
  "## Authenticated Cloudflare-native SSR staging canary",
  "",
  "All requests use a temporary secret; no private visitor or credential fields are retained.",
  "This is synthetic runner TTFB, not a field performance guarantee.",
  "Workers.dev staging is not the production hostname.",
  "",
  "The first counted SSR homepage request is the first HTTP request in the newly deployed Worker gate.",
  "Residual = client TTFB - timed Worker duration; not necessarily a cold-start diagnosis.",
  "Undici connect covers any new DNS/TCP/TLS setup and may be n/a for reused sockets.",
  "Undici client-to-headers includes network and remote processing; phases are diagnostic only.",
  "",
  "| Sequence | Locale | Sample | TTFB | Worker | Residual | Client queue | New connect | Sent-to-headers | CF colo | CF Ray | SSR cards |",
  "| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- | ---: |",
  ...results.map(
    (r) =>
      `| ${r.sequence} | ${r.language} | ${r.sample} | ${r.ttfbMs} ms | ${r.workerMs ?? "n/a"} ms | ${r.unattributedMs ?? "n/a"} ms | ${r.clientQueueMs ?? "n/a"} ms | ${r.clientConnectMs ?? "n/a"} ms | ${r.clientToHeadersMs ?? "n/a"} ms | ${r.cfColo} | ${r.cfRay ?? "n/a"} | ${r.cards} |`,
  ),
  "",
  `Result **${summary.status}** — p75 ${summary.p75 ?? "n/a"} ms, p95 ${summary.p95 ?? "n/a"} ms; ${summary.slowSamples} >=800 ms; ${summary.errors} failures.`,
  ...failures.map((r) => `- request ${r.sequence}: ${r.error}`),
].join("\n");
console.log(table);
if (process.env.GITHUB_STEP_SUMMARY)
  fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, table + "\n");
if (!allPass) process.exitCode = 1;
