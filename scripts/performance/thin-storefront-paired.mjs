// Isolated architectural A/B. Failures are evidence, never successful samples.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { performance } from "node:perf_hooks";
import { Agent, fetch as httpFetch } from "undici";
import { chromium, devices } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { parseThinConfig, parseBenchmarkConfig } from "./thin-config.mjs";
import { thinRunWorkerNames, scopedStageConfigs } from "./thin-stage-run-scope.mjs";
import { PERFORMANCE_D1, isolatedD1Config, verifySyntheticD1 } from "./isolated-d1-gate.mjs";
const account = "d26430caa63ec55f6612e32f36aca5e9";
const token = process.env.CLOUDFLARE_API_TOKEN;
assert.ok(token);
const output = path.resolve("artifacts/thin-storefront");
fs.mkdirSync(output, { recursive: true });
const evidence = {
  sha: process.env.GITHUB_SHA,
  configuration: {
    placement: "ingress-edge",
    runtime: "2026-10-19/nodejs_compat",
    fixture: "50000 wholly synthetic; identical candidate D1 for both renderers",
    productionD1: false,
    transport: "shared benchmark ingress hostname, service bindings and connection pool",
  },
  cold: [],
  bursts: [],
  capacity: [],
  bootstrap: [],
  browser: [],
  errors: [],
  releaseApproved: false,
};
const save = () =>
  fs.writeFileSync(path.join(output, "results.json"), JSON.stringify(evidence, null, 2));
const workers = thinRunWorkerNames(process.env.GITHUB_RUN_ID);
evidence.configuration.scopedStageRunId = process.env.GITHUB_RUN_ID;
const origin = () => `https://${workers.ingress}.cove-jibrilmohamud.workers.dev`;
const keys = { baseline: randomBytes(32).toString("hex"), core: randomBytes(32).toString("hex") };
keys.thin = keys.core;
function command(args, input) {
  const r = spawnSync(
    "npm",
    ["exec", "--yes", "--package=wrangler@4.151.0", "--", "wrangler", ...args],
    {
      input,
      encoding: "utf8",
      timeout: 180000,
      maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, CLOUDFLARE_SEND_METRICS: "false" },
    },
  );
  if (r.status !== 0 || r.error)
    throw Error(
      "Wrangler " +
        args.slice(0, 2).join(" ") +
        " failed: " +
        String(r.error?.message || r.stderr)
          .replace(/Bearer\s+\S+/g, "Bearer [redacted]")
          .slice(-1500),
    );
}
async function api(method, p, body) {
  const r = await fetch(`https://api.cloudflare.com/client/v4${p}`, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(60000),
  });
  const j = await r.json();
  if (!r.ok || !j.success) throw Error(`Cloudflare ${method} ${p}: ${r.status}`);
  return j.result;
}
const template = fs.readFileSync("wrangler.frontend.staging.toml", "utf8");
for (const role of ["baseline", "core"]) {
  // Both renderers read the SAME artificial D1 sequentially, removing
  // independent D1 placement/service variability from the comparison.
  const dbrole = "current";
  let config = isolatedD1Config(
    template,
    dbrole,
    `cove-lazyfacet-${role === "baseline" ? "control" : "candidate"}-staging`,
    role === "baseline" ? "732030" : "732032",
  );
  config = config
    .replace(/^name = .+$/m, `name = "${workers[role]}"`)
    .replace('main = ".output/server/index.mjs"', 'main = ".output/thin/core.mjs"')
    .replace('compatibility_date = "2026-10-17"', 'compatibility_date = "2026-10-19"');
  // No R2 binding is required for generated fixtures; no production media access.
  config = config.replace(/\[\[r2_buckets\]\][\s\S]*?(?=\[vars\])/, "");
  config += `\nCOVE_PERF_DATABASE_ID = "${PERFORMANCE_D1[dbrole].id}"\nCOVE_SSR_DIAGNOSTICS = "1"\n`;
  assert.ok(!config.includes("4bd657ac-8789-403e-a28c-93aba8d0a989"));
  config += "\n[observability]\nenabled = true\nhead_sampling_rate = 1\n";
  fs.writeFileSync(`wrangler.thin-${role}.toml`, config);
}
const thinConfig = parseThinConfig(fs.readFileSync("wrangler.storefront-thin.jsonc", "utf8"));
assert.equal(thinConfig.d1_databases.length, 1);
assert.equal(thinConfig.d1_databases[0].database_id, PERFORMANCE_D1.current.id);
// The checked-in config deliberately keeps the original fixed CORE name.
// Only the transient run-scoped copy may reference this job's private CORE.
assert.equal(thinConfig.services[0].service, "cove-thin-core-staging");
assert.equal(thinConfig.vars.COVE_SSR_STAGING, "1");
assert.equal(thinConfig.vars.COVE_PERF_DATABASE_ID, PERFORMANCE_D1.current.id);
assert.ok(!thinConfig.routes);
assert.ok(!thinConfig.r2_buckets);
assert.ok(!thinConfig.placement);
const ingressConfig = parseBenchmarkConfig(
  fs.readFileSync("wrangler.storefront-benchmark.jsonc", "utf8"),
);
const scoped = scopedStageConfigs(thinConfig, ingressConfig, workers, PERFORMANCE_D1.current.id);
assert.equal(scoped.thin.services[0].service, workers.core);
assert.equal(scoped.ingress.services.find((x) => x.binding === "THIN")?.service, workers.thin);
assert.equal(
  scoped.ingress.services.find((x) => x.binding === "BASELINE")?.service,
  workers.baseline,
);
fs.writeFileSync("wrangler.thin-run.jsonc", JSON.stringify(scoped.thin, null, 2));
fs.writeFileSync("wrangler.thin-ingress-run.jsonc", JSON.stringify(scoped.ingress, null, 2));
async function readiness() {
  const query = async (id, sql) => {
    assert.ok(Object.values(PERFORMANCE_D1).some((x) => x.id === id));
    const r = await api("POST", `/accounts/${account}/d1/database/${id}/query`, { sql });
    return r[0];
  };
  const a = await verifySyntheticD1(PERFORMANCE_D1.baseline.id, query);
  const b = await verifySyntheticD1(PERFORMANCE_D1.current.id, query);
  assert.deepEqual(a, b);
  evidence.fixtures = { baseline: a, thin: b };
  save();
}
parseBenchmarkConfig(fs.readFileSync("wrangler.storefront-benchmark.jsonc", "utf8"));
const lastDeployments = {};
async function deploy(role) {
  const config = role === "thin" ? "wrangler.thin-run.jsonc" : `wrangler.thin-${role}.toml`;
  command(["deploy", "--config", config]);
  // An identical upload alone may reuse a loaded environment. Rotate the
  // binding on EVERY round to force a distinct Worker environment. Thin and
  // its delegated core must receive the same fresh key.
  keys[role] = role === "thin" ? keys.core : randomBytes(32).toString("hex");
  if (role === "core") keys.thin = keys.core;
  const rotatedAt = Date.now();
  command(["secret", "put", "COVE_SSR_STAGING_GATE_KEY", "--config", config], keys[role]);
  // Control-plane reads do not touch or prewarm the Worker URL.
  for (let attempt = 0; attempt < 16; attempt++) {
    const r = await api("GET", `/accounts/${account}/workers/scripts/${workers[role]}/deployments`);
    const d = r.deployments[0];
    if (
      d.id !== lastDeployments[role] &&
      Date.parse(d.created_on) >= rotatedAt &&
      d.versions.some((v) => v.percentage === 100)
    ) {
      lastDeployments[role] = d.id;
      await new Promise((done) => setTimeout(done, 2000));
      return {
        id: d.id,
        created_on: d.created_on,
        versions: d.versions,
        secretRotationEpochMs: rotatedAt,
      };
    }
    await new Promise((done) => setTimeout(done, 1800));
  }
  throw new Error("Fresh fully active deployment was not confirmed");
}
function pct(values, p) {
  const a = [...values].sort((a, b) => a - b);
  return a.length ? a[Math.ceil(p * a.length) - 1] : null;
}
function summary(rows) {
  const valid = rows.filter((x) => x.valid);
  const byColo = Object.fromEntries(
    [...new Set(valid.map((row) => row.colo || "unknown"))].map((colo) => {
      const subset = valid.filter((row) => (row.colo || "unknown") === colo);
      return [
        colo,
        {
          count: subset.length,
          p50: pct(
            subset.map((row) => row.ttfb),
            0.5,
          ),
          p95: pct(
            subset.map((row) => row.ttfb),
            0.95,
          ),
          max: Math.max(...subset.map((row) => row.ttfb)),
        },
      ];
    }),
  );
  const spans = {};
  for (const name of [
    "cove_catalog",
    "cove_catalog_sql",
    "cove_context",
    "cove_context_sql",
    "cove_context_joined",
    "cove_context_flight_eligible",
    "cove_page",
    "cove_bootstrap",
  ]) {
    const values = valid.map((row) => row.timings?.[name]).filter(Number.isFinite);
    if (values.length)
      spans[name] = { count: values.length, p95: pct(values, 0.95), max: Math.max(...values) };
  }
  const instrumented = valid.filter((row) =>
    Number.isFinite(row.timings?.cove_context_flight_eligible),
  );
  const eligible = instrumented.filter(
    (row) => row.timings.cove_context_flight_eligible === 1,
  ).length;
  const joined = instrumented.filter((row) => row.timings.cove_context_joined === 1).length;
  return {
    byColo,
    spans,
    coalescing: {
      instrumented: instrumented.length,
      eligible,
      joined,
      joinPercent: eligible > 0 ? Math.round((1000 * joined) / eligible) / 10 : null,
    },
    requested: rows.length,
    valid: valid.length,
    errors: rows.length - valid.length,
    p50: pct(
      valid.map((x) => x.ttfb),
      0.5,
    ),
    p75: pct(
      valid.map((x) => x.ttfb),
      0.75,
    ),
    p95: pct(
      valid.map((x) => x.ttfb),
      0.95,
    ),
    p99: pct(
      valid.map((x) => x.ttfb),
      0.99,
    ),
    max: valid.length ? Math.max(...valid.map((x) => x.ttfb)) : null,
    colos: [...new Set(rows.map((x) => x.colo).filter(Boolean))],
  };
}
let client = 0;
async function sample(role, { fresh = false, route = "/", benchmarkHeaders = {} } = {}) {
  const dispatcher = fresh ? new Agent({ connections: 1, pipelining: 1 }) : agents[role];
  const started = performance.now();
  try {
    const r = await httpFetch(origin(role) + route, {
      dispatcher,
      headers: {
        authorization: `Bearer ${keys[role]}`,
        "x-cove-perf-client": String(client++ % 1024),
        "x-cove-perf-renderer": role,
        ...benchmarkHeaders,
      },
      signal: AbortSignal.timeout(8000),
    });
    const ttfb = performance.now() - started;
    const body = await r.text();
    const links = [...body.matchAll(/<a(?=[^>]*class="[^"]*book-title)[^>]*href="([^"]+)"/g)].map(
      (x) => x[1],
    );
    const home = route === "/";
    let diagnosticValid = true;
    if (route === "/__cove_perf/bootstrap") {
      try {
        const data = JSON.parse(body);
        diagnosticValid = data.stage === "bootstrap" && data.ok === true && data.books === 24;
      } catch {
        diagnosticValid = false;
      }
    }
    if (route === "/__cove_perf/transport")
      diagnosticValid = body === "ok" && r.headers.get("x-cove-perf-control") === "thin-no-d1";
    const timings = {};
    for (const m of (r.headers.get("server-timing") || "").matchAll(
      /(cove_[a-z_]+);dur=([0-9]+(?:\.[0-9]+)?)/g,
    ))
      timings[m[1]] = Number(m[2]);
    const valid =
      r.status === 200 &&
      diagnosticValid &&
      (!home ||
        (links.length === 24 &&
          r.headers.get("content-type")?.includes("text/html") &&
          /no-store/.test(r.headers.get("cache-control") || "")));
    return {
      ttfb,
      total: performance.now() - started,
      status: r.status,
      valid,
      bytes: Buffer.byteLength(body),
      cards: links.length,
      links,
      products: [...body.matchAll(/data-product="([^"]+)"/g)].map((x) => x[1]),
      rightsCountry: /data-rights-country="([A-Z]{2})"/.exec(body)?.[1],
      colo: r.headers.get("cf-ray")?.split("-").at(-1),
      serverTiming: r.headers.get("server-timing"),
      timings,
      rayId: r.headers.get("cf-ray"),
      observedAt: new Date().toISOString(),
      ...(valid ? {} : { failureBody: body.slice(0, 300) }),
    };
  } catch (e) {
    return {
      valid: false,
      status: 0,
      error: String(e).slice(0, 250),
      total: performance.now() - started,
    };
  } finally {
    if (fresh) await dispatcher.close();
  }
}
const sharedAgent = new Agent({ connections: 128, pipelining: 1 });
const agents = { baseline: sharedAgent, thin: sharedAgent };
async function browserCheck(role) {
  const browser = await chromium.launch();
  const results = [];
  const record = { role, lcp: results, pass: false, sampleCount: 0 };
  evidence.browser.push(record);
  save();
  try {
    for (let i = 0; i < 5; i++) {
      const context = await browser.newContext({
        ...devices["Pixel 5"],
        extraHTTPHeaders: {
          authorization: `Bearer ${keys[role]}`,
          "x-cove-perf-client": String(3000 + i),
          "x-cove-perf-renderer": role,
        },
      });
      const page = await context.newPage();
      const cdp = await context.newCDPSession(page);
      await cdp.send("Network.enable");
      await cdp.send("Network.emulateNetworkConditions", {
        offline: false,
        latency: 150,
        downloadThroughput: (1.6 * 1024 * 1024) / 8,
        uploadThroughput: (750 * 1024) / 8,
      });
      await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
      await page.addInitScript(() => {
        window.__lcp = 0;
        new PerformanceObserver((l) => {
          for (const e of l.getEntries()) window.__lcp = e.startTime;
        }).observe({ type: "largest-contentful-paint", buffered: true });
      });
      const response = await page.goto(origin(role), { waitUntil: "networkidle", timeout: 45000 });
      assert.equal(response.status(), 200);
      assert.equal(await page.locator(".book-card").count(), 24);
      const lcp = await page.evaluate(() => window.__lcp);
      assert.ok(lcp > 0);
      results.push(lcp);
      record.sampleCount = results.length;
      record.p75 = pct(results, 0.75);
      save();
      if (i === 4) {
        const axe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
        assert.deepEqual(
          axe.violations.map((x) => x.id),
          [],
        );
        await page.screenshot({ path: path.join(output, `${role}-mobile.png`), fullPage: true });
        try {
          const catalogResponse = page.waitForResponse(
            (r) => {
              const url = new URL(r.url());
              return (
                url.pathname === "/api/fore/catalog" &&
                (url.searchParams.get("search") || url.searchParams.get("q")) === "Synthetic"
              );
            },
            { timeout: 30000 },
          );
          void catalogResponse.catch(() => {});
          const input =
            role === "thin"
              ? page.getByRole("searchbox")
              : page.getByRole("textbox", {
                  name: "Search books by title, author, series, ISBN, publisher, or catalog ID",
                });
          await input.fill("Synthetic");
          if (role === "thin") await input.press("Enter");
          const response = await catalogResponse;
          assert.equal(response.status(), 200, "Delegated catalog request must succeed");
          const payload = await response.json();
          assert.ok(
            payload.results?.length > 0 &&
              payload.results.every((book) => book.title.includes("Synthetic")),
          );
          await page.waitForFunction(
            () =>
              Array.from(document.querySelectorAll(".book-card")).some((n) =>
                n.textContent.includes("Synthetic"),
              ),
            undefined,
            { timeout: 30000 },
          );
          assert.equal(new URL(page.url()).pathname, "/search");
          record.searchPassed = true;
        } catch (error) {
          await page.screenshot({
            path: path.join(output, `${role}-search-failed.png`),
            fullPage: true,
          });
          fs.writeFileSync(
            path.join(output, `${role}-search-failed.txt`),
            (await page.locator("body").innerText()).slice(0, 12000),
          );
          record.searchPassed = false;
          record.searchError = String(error);
          save();
          throw error;
        }
      }
      await context.close();
    }
    record.pass = results.length === 5 && record.searchPassed && pct(results, 0.75) <= 2000;
    save();
    return record;
  } finally {
    await browser.close();
  }
}
async function capacity(
  role,
  rate,
  { route = "/", duration = 20_000, benchmarkHeaders = {} } = {},
) {
  const offered = Math.round((rate * duration) / 1000),
    interval = 1000 / rate,
    start = performance.now(),
    rows = [],
    pending = new Set(),
    arrivalDelayMs = [];
  let dropped = 0,
    late = 0,
    peakPending = 0,
    stop = false,
    scheduled = 0;
  for (let n = 0; n < offered; n++) {
    const due = start + n * interval,
      delay = due - performance.now();
    if (delay > 0) await new Promise((r) => setTimeout(r, delay));
    if (stop) break;
    scheduled++;
    const behind = Math.max(0, performance.now() - due);
    arrivalDelayMs.push(behind);
    if (behind > 100) late++;
    peakPending = Math.max(peakPending, pending.size);
    if (pending.size >= 128) {
      dropped++;
      continue;
    }
    const task = sample(role, { route, benchmarkHeaders })
      .then((r) => {
        rows.push({ ...r, scheduledIndex: n });
        if (!r.valid) stop = true;
      })
      .finally(() => pending.delete(task));
    pending.add(task);
  }
  await Promise.all(pending);
  const elapsed = performance.now() - start,
    s = summary(rows);
  // Group by scheduled arrival index, not completion time; otherwise a
  // growing D1 queue moves slow responses into later windows and hides
  // when load first exceeded service capacity.
  const windows = [];
  if (duration >= 60_000) {
    const count = Math.ceil(duration / 10_000);
    for (let windowIndex = 0; windowIndex < count; windowIndex++) {
      const first = Math.ceil((windowIndex * 10_000) / interval);
      const last = Math.min(offered, Math.ceil(((windowIndex + 1) * 10_000) / interval));
      const subset = rows.filter(
        (row) => row.scheduledIndex >= first && row.scheduledIndex < last,
      );
      const period = summary(subset);
      windows.push({
        second: windowIndex * 10,
        offered: last - first,
        delivered: subset.length,
        valid: period.valid,
        p95Ms: period.p95,
        p99Ms: period.p99,
        maxMs: period.max,
        catalogP95Ms: period.spans.cove_catalog?.p95 ?? null,
        contextP95Ms: period.spans.cove_context?.p95 ?? null,
        catalogSqlP95Ms: period.spans.cove_catalog_sql?.p95 ?? null,
        colos: period.colos,
        pass:
          subset.length === last - first &&
          period.valid === last - first &&
          period.p95 <= 600 &&
          period.p99 <= 750 &&
          period.max < 800,
      });
    }
  }
  return {
    role,
    offeredRps: rate,
    route,
    durationMs: elapsed,
    offered,
    peakPending,
    arrivalDelayP95Ms: pct(arrivalDelayMs, 0.95),
    arrivalDelayMaxMs: arrivalDelayMs.length ? Math.max(...arrivalDelayMs) : 0,
    completedRps: rows.length / (elapsed / 1000),
    scheduled,
    unscheduled: offered - scheduled,
    dropped,
    late,
    summary: s,
    windows,
    pass:
      !stop &&
      !dropped &&
      !late &&
      !s.errors &&
      scheduled === offered &&
      s.valid === offered &&
      s.p95 <= 600 &&
      s.p99 <= 750 &&
      s.max < 800 &&
      windows.every((window) => window.pass),
    rows,
  };
}
async function verifyRemoteRevocation(before) {
  const database = PERFORMANCE_D1.current.id;
  assert.match(before.products?.[0] || "", /^perf-synth-[0-9]{6}$/);
  assert.match(before.rightsCountry || "", /^[A-Z]{2}$/);
  const product = before.products[0];
  const query = async (sql, params) => {
    const rows = await api("POST", `/accounts/${account}/d1/database/${database}/query`, {
      sql,
      params,
    });
    assert.equal(rows[0].success, true);
    return rows[0].results;
  };
  const grants = await query(
    "SELECT id FROM rights_grants WHERE edition_id=(SELECT edition_id FROM products WHERE id=?) AND territory_code=? AND decision='allow' AND status='active' AND sales_channel='retail'",
    [product, before.rightsCountry],
  );
  assert.ok(
    grants.length > 0,
    "The displayed synthetic product must have a currently active retail grant",
  );
  try {
    for (const grant of grants)
      await query("UPDATE rights_grants SET status='revoked' WHERE id=?", [grant.id]);
    const after = await sample("thin");
    assert.ok(after.valid, "Revocation must preserve a valid replacement shelf");
    assert.ok(!after.products.includes(product), "Revoked offer remained in rendered HTML");
    evidence.remoteRevocation = {
      pass: true,
      product,
      country: before.rightsCountry,
      revokedGrantCount: grants.length,
    };
    save();
  } finally {
    for (const grant of grants)
      await query("UPDATE rights_grants SET status='active' WHERE id=?", [grant.id]);
  }
  const restored = await sample("thin");
  assert.ok(
    restored.valid && restored.products.includes(product),
    "Restored synthetic fixture must reappear",
  );
  const unauth = await fetch(origin("thin"), { headers: { "x-cove-perf-renderer": "thin" } });
  assert.equal(unauth.status, 401);
}
async function platformSnapshot(role) {
  const query = `query { viewer { accounts(filter:{accountTag:"${account}"}) { workersInvocationsAdaptive(limit:100,filter:{scriptName:"${workers[role]}", datetime_geq:"${evidence.startedAt}",datetime_leq:"${evidence.finishedAt}"}) { dimensions { scriptName status } sum { requests errors } quantiles { cpuTimeP50 cpuTimeP99 wallTimeP50 wallTimeP99 } } } } }`;
  try {
    const r = await fetch("https://api.cloudflare.com/client/v4/graphql", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ query }),
      signal: AbortSignal.timeout(30000),
    });
    const j = await r.json();
    const rows = j.data?.viewer?.accounts?.[0]?.workersInvocationsAdaptive;
    return r.ok && !j.errors && rows?.length
      ? {
          raw: rows,
          boundary:
            "Sampled script-wide platform CPU/wall quantiles, including assets and delegated work; not per-response causal spans.",
        }
      : { unavailable: true };
  } catch {
    return { unavailable: true };
  }
}

async function failureSnapshot() {
  try {
    const result = await api("POST", `/accounts/${account}/workers/observability/telemetry/query`, {
      queryId: "cove-thin-benchmark-failures",
      dry: true,
      view: "events",
      limit: 100,
      timeframe: { from: Date.parse(evidence.startedAt), to: Date.parse(evidence.finishedAt) },
      parameters: { needle: { value: "thin_storefront_failed" }, limit: 100 },
    });
    return {
      // Logs may arrive late. An empty result never substitutes for the
      // status/error count in the client observations.
      boundary: "Available Worker failure logs; not an absence-of-errors assertion.",
      events: (result.events?.events || [])
        .filter((event) => event.$workers?.scriptName === workers.thin)
        .map((event) => ({
          at: event.timestamp,
          phase: event.source?.phase,
          kind: event.source?.kind,
          status: event.source?.status,
          rayId: event.$metadata?.rayId,
        })),
    };
  } catch {
    return { unavailable: true };
  }
}

evidence.startedAt = new Date().toISOString();
let failed = false;
try {
  await readiness();
  await deploy("core");
  await deploy("baseline");
  await deploy("thin");
  command(["deploy", "--config", "wrangler.thin-ingress-run.jsonc"]);
  // Wrangler upload completion does not guarantee that a newly created
  // workers.dev ingress/service graph is visible immediately. Confirm its
  // current 100% control-plane deployment without making an HTTP request to
  // the Worker (which would warm the very cold path being benchmarked).
  let ingressReady = false;
  for (let attempt = 0; attempt < 20; attempt++) {
    const deployments = await api(
      "GET",
      `/accounts/${account}/workers/scripts/${workers.ingress}/deployments`,
    );
    const current = deployments.deployments?.[0];
    if (current?.versions?.some((version) => version.percentage === 100)) {
      ingressReady = true;
      evidence.configuration.ingressDeploymentId = current.id;
      save();
      break;
    }
    await new Promise((done) => setTimeout(done, 1500));
  }
  assert.ok(ingressReady, "New run-scoped staging ingress did not become active");
  for (let round = 1; round <= 3; round++) {
    await deploy("core");
    for (const role of round % 2 ? ["baseline", "thin"] : ["thin", "baseline"]) {
      const deployment = await deploy(role);
      const rows = [];
      // First response is explicitly recorded; first 20 requests are separate from warm waves.
      for (let i = 0; i < 20; i++) rows.push(await sample(role, { fresh: true }));
      const s = summary(rows);
      const pass = s.valid === 20 && s.max <= 650;
      evidence.cold.push({ round, role, deployment, summary: s, pass, rows });
      save();
      console.log("cold", round, role, JSON.stringify(s));
      if (!pass && role === "thin") failed = true;
    }
  }
  for (let wave = 1; wave <= 2; wave++)
    for (const concurrency of [1, 4, 8, 16, 32])
      for (const role of wave % 2 ? ["baseline", "thin"] : ["thin", "baseline"]) {
        const rows = await Promise.all(Array.from({ length: concurrency }, () => sample(role)));
        const s = summary(rows);
        const pass = s.valid === concurrency && s.max <= (concurrency === 32 ? 750 : 650);
        evidence.bursts.push({ wave, role, concurrency, summary: s, pass, rows });
        save();
        console.log("burst", wave, role, concurrency, JSON.stringify(s));
        if (!pass && role === "thin") failed = true;
      }
  for (const role of ["baseline", "thin"]) {
    const rows = await Promise.all(
      Array.from({ length: 32 }, () => sample(role, { route: "/__cove_perf/bootstrap" })),
    );
    const s = summary(rows);
    const pass = s.valid === 32 && s.max <= 750;
    evidence.bootstrap.push({ role, concurrency: 32, summary: s, pass, rows });
    save();
    if (!pass && role === "thin") failed = true;
  }
  const a = await sample("baseline"),
    b = await sample("thin");
  evidence.paritySamples = { baseline: a, thin: b };
  save();
  assert.ok(a.valid && b.valid, "Both parity responses must be valid; raw responses retained");
  assert.deepEqual(a.links, b.links, "Exact 24 ordered canonical edition URLs must match");
  evidence.contentParity = true;
  await verifyRemoteRevocation(b);
  const colos = evidence.bursts.map((x) => x.summary.colos);
  evidence.matchedColo = colos.every((x) => x.length === 1 && x[0] === colos[0][0]);
  if (!evidence.matchedColo) failed = true;
  for (const role of ["baseline", "thin"])
    try {
      await browserCheck(role);
      save();
    } catch (e) {
      evidence.errors.push({ phase: "browser", role, error: String(e) });
      failed = true;
      save();
    }
  // Retire each renderer independently at its own latency/client ceiling.
  // Any HTTP/transport error stops the entire shared-D1 campaign immediately.
  const active = new Set(["baseline", "thin"]);
  evidence.capacityStoppedByRole = {};
  for (const rate of [10, 25, 50, 75, 90, 100, 125]) {
    let unsafe = false;
    // The 100-RPS no-D1 control uses exactly the same hostname, ingress,
    // thin service binding, bearer gate, Undici agent and offered schedule.
    // It must not be confused with a valid authorized storefront response.
    if (rate === 100) {
      const control = await capacity("thin", 100, {
        route: "/__cove_perf/transport",
        duration: 20_000,
      });
      evidence.transportControls ??= [];
      evidence.transportControls.push({ position: "before-100", ...control });
      save();
      console.log(
        "control",
        "before-100",
        JSON.stringify({
          ...control.summary,
          dropped: control.dropped,
          late: control.late,
          peakPending: control.peakPending,
          byColo: control.summary.byColo,
        }),
      );
      if (!control.pass)
        evidence.errors.push({
          phase: "transport-control",
          message: "Data-free 100-RPS control failed; storefront attribution inconclusive",
        });
    }
    for (const role of [...active]) {
      const result = await capacity(role, rate);
      evidence.capacity.push(result);
      save();
      console.log(
        "capacity",
        role,
        rate,
        JSON.stringify({
          ...result.summary,
          scheduled: result.scheduled,
          unscheduled: result.unscheduled,
          dropped: result.dropped,
          late: result.late,
          peakPending: result.peakPending,
          arrivalDelayP95Ms: result.arrivalDelayP95Ms,
        }),
      );
      if (!result.pass) {
        active.delete(role);
        evidence.capacityStoppedByRole[role] = rate;
      }
      // A broken full-SSR comparator is valuable failure evidence, but
      // must NEVER abort the thin candidate's own capacity campaign.
      // The previous harness silently skipped thin at 10 RPS after a
      // single unrelated baseline error. Thin HTTP/transport errors still
      // stop all further synthetic load immediately.
      if (result.summary.errors && role === "thin") {
        unsafe = true;
        break;
      }
    }
    if (rate === 100 && evidence.transportControls?.length) {
      const control = await capacity("thin", 100, {
        route: "/__cove_perf/transport",
        duration: 20_000,
      });
      evidence.transportControls.push({ position: "after-100", ...control });
      save();
      console.log(
        "control",
        "after-100",
        JSON.stringify({
          ...control.summary,
          dropped: control.dropped,
          late: control.late,
          peakPending: control.peakPending,
          byColo: control.summary.byColo,
        }),
      );
      if (!control.pass)
        evidence.errors.push({
          phase: "transport-control",
          message: "Post-100 data-free control failed; storefront attribution inconclusive",
        });
    }
    // The rights-checked candidate can be retired at 90 RPS. Still execute
    // the protected 100-RPS no-D1 controls to distinguish transport capacity
    // from the exhausted shared-D1 path; never run more catalog load after an
    // unsafe HTTP failure.
    if (unsafe || (!active.size && rate >= 100)) break;
  }
  // Hold the same deployed Worker, synthetic D1, ingress, rights view,
  // agent, and schedule fixed. Only metadata singleflight changes.
  // OFF/ON/OFF reveals whether a regional shift or warmup masquerades as
  // a coalescing gain. Never score OFF runs as authorized storefront success
  // for the optimized serving configuration.
  evidence.singleflightControlled = [];
  for (const mode of ["off-before", "on", "off-after"]) {
    const result = await capacity("thin", 100, {
      benchmarkHeaders: mode.startsWith("off") ? { "x-cove-perf-no-metadata-flight": "1" } : {},
    });
    evidence.singleflightControlled.push({ mode, ...result });
    save();
    console.log(
      "singleflight-controlled",
      mode,
      JSON.stringify({
        ...result.summary,
        offered: result.offered,
        valid: result.summary.valid,
        dropped: result.dropped,
        late: result.late,
        peakPending: result.peakPending,
      }),
    );
  }
  const sameColo = evidence.singleflightControlled.every(
    (run) =>
      run.summary.colos.length === 1 &&
      run.summary.colos[0] === evidence.singleflightControlled[0].summary.colos[0],
  );
  const middle = evidence.singleflightControlled[1];
  const controls = [evidence.singleflightControlled[0], evidence.singleflightControlled[2]];
  evidence.singleflightCausal = {
    sameColo,
    offP95Ms: controls.map((run) => run.summary.p95),
    onP95Ms: middle.summary.p95,
    offMaxMs: controls.map((run) => run.summary.max),
    onMaxMs: middle.summary.max,
    onPassed: middle.pass,
    onJoinTelemetry: middle.summary.coalescing,
    offJoinTelemetry: controls.map((run) => run.summary.coalescing),
    // Every response must be instrumented and ON must demonstrably join at
    // least one actual metadata batch; otherwise no attribution is allowed.
    measurementComplete:
      middle.summary.coalescing.instrumented === middle.offered &&
      middle.summary.coalescing.eligible === middle.offered &&
      middle.summary.coalescing.joined > 0 &&
      controls.every(
        (run) =>
          run.summary.coalescing.instrumented === run.offered &&
          run.summary.coalescing.eligible === 0 &&
          run.summary.coalescing.joined === 0,
      ),
    // Improvement is a measured outcome, not an assumption just because
    // the flag was enabled. Comparison cannot be certified across colos.
    improvementSupported:
      sameColo &&
      middle.pass &&
      middle.summary.coalescing.instrumented === middle.offered &&
      middle.summary.coalescing.eligible === middle.offered &&
      middle.summary.coalescing.joined > 0 &&
      controls.every(
        (run) =>
          run.summary.coalescing.instrumented === run.offered &&
          run.summary.coalescing.eligible === 0 &&
          run.summary.coalescing.joined === 0,
      ) &&
      controls.every(
        (run) =>
          run.summary.valid === run.offered &&
          run.dropped === 0 &&
          run.summary.p95 > middle.summary.p95 * 1.1,
      ),
  };
  save();
  // A 20-second 100-RPS burst does not establish sustainable capacity. A
  // full two-minute offered-load period with independent 10-second cohorts
  // detects late-stage D1 queue buildup while leaving the serving path alone.
  evidence.sustained100 = await capacity("thin", 100, { duration: 120_000 });
  save();
  console.log(
    "sustained-100-rps",
    JSON.stringify({
      offered: evidence.sustained100.offered,
      valid: evidence.sustained100.summary.valid,
      dropped: evidence.sustained100.dropped,
      unscheduled: evidence.sustained100.unscheduled,
      pass: evidence.sustained100.pass,
      p95Ms: evidence.sustained100.summary.p95,
      maxMs: evidence.sustained100.summary.max,
      windows: evidence.sustained100.windows,
    }),
  );
  const mobile = evidence.browser.find((x) => x.role === "thin"),
    controlMobile = evidence.browser.find((x) => x.role === "baseline");
  evidence.mobileGate =
    !!mobile &&
    !!controlMobile &&
    mobile.sampleCount === 5 &&
    controlMobile.sampleCount === 5 &&
    mobile.pass &&
    controlMobile.searchPassed &&
    mobile.p75 <= 2000 &&
    mobile.p75 <= controlMobile.p75;
  const tails = (role) =>
    evidence.bursts
      .filter((x) => x.role === role && x.concurrency === 32)
      .map((x) => x.summary.p95);
  evidence.tailReductionMs = tails("baseline").map((x, i) => x - tails("thin")[i]);
  evidence.tailReductionGate =
    evidence.tailReductionMs.length === 2 && evidence.tailReductionMs.every((x) => x >= 200);
  evidence.architecturalGate =
    evidence.mobileGate &&
    evidence.tailReductionGate &&
    evidence.errors.length === 0 &&
    evidence.cold.filter((x) => x.role === "thin").every((x) => x.pass) &&
    evidence.bursts.filter((x) => x.role === "thin").every((x) => x.pass) &&
    evidence.bootstrap.filter((x) => x.role === "thin").every((x) => x.pass) &&
    evidence.capacity.some((x) => x.role === "thin" && x.pass) &&
    !evidence.capacity.some((x) => x.role === "thin" && x.summary.errors) &&
    // The historical architecture gate is preserved; capacity >=100 RPS
    // is a distinct hard SLO and cannot be inferred from 50-RPS success.
    evidence.capacity.some((x) => x.role === "thin" && x.offeredRps === 100 && x.pass) &&
    (evidence.transportControls || []).filter((x) => x.position.includes("100")).length === 2 &&
    evidence.transportControls.every((control) => control.pass) &&
    evidence.contentParity &&
    evidence.remoteRevocation?.pass &&
    evidence.matchedColo;
  // Success at 100 RPS is a necessary capacity result, not proof that
  // the new singleflight actually caused the improvement. Reject this
  // experimental optimization unless the counterfactual is measurable:
  // same colo, all offered responses valid, nonzero joined metadata reads
  // only in ON, and p95 at least 10% better than BOTH OFF bookends.
  evidence.optimizationGate =
    evidence.architecturalGate &&
    evidence.sustained100?.pass === true &&
    evidence.singleflightCausal.measurementComplete &&
    evidence.singleflightCausal.improvementSupported;
  if (!evidence.optimizationGate) failed = true;
  evidence.finishedAt = new Date().toISOString();
  evidence.workerPlatform = {};
  for (const role of ["baseline", "thin", "core"])
    evidence.workerPlatform[role] = await platformSnapshot(role);
  evidence.workerFailures = await failureSnapshot();
  // Prototype has different visual/interaction design. Passing these measurements
  // NEVER certifies existing-customer-journey equivalence or production readiness.
  evidence.releaseApproved = false;
  save();
} catch (e) {
  failed = true;
  evidence.errors.push({ phase: "campaign", error: String(e).slice(0, 2000) });
  save();
} finally {
  await sharedAgent.close();
}
if (failed) process.exitCode = 1;
