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
  phaseDiagnosis: [],
  mixed: [],
  browser: [],
  errors: [],
  releaseApproved: false,
};
const save = () =>
  fs.writeFileSync(path.join(output, "results.json"), JSON.stringify(evidence, null, 2));
const workers = {
  baseline: "cove-thin-control-staging",
  core: "cove-thin-core-staging",
  thin: "cove-thin-pilot-staging",
  ingress: "cove-thin-ingress-staging",
};
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
  if (role === "core")
    config += 'COVE_PERF_EDGE_PUBLIC_READS = "1"\n';
  assert.ok(!config.includes("4bd657ac-8789-403e-a28c-93aba8d0a989"));
  config += "\n[observability]\nenabled = true\nhead_sampling_rate = 1\n";
  fs.writeFileSync(`wrangler.thin-${role}.toml`, config);
}
const thinConfig = parseThinConfig(fs.readFileSync("wrangler.storefront-thin.jsonc", "utf8"));
assert.equal(thinConfig.d1_databases.length, 1);
assert.equal(thinConfig.d1_databases[0].database_id, PERFORMANCE_D1.current.id);
assert.equal(thinConfig.services[0].service, workers.core);
assert.equal(thinConfig.vars.COVE_SSR_STAGING, "1");
assert.equal(thinConfig.vars.COVE_PERF_DATABASE_ID, PERFORMANCE_D1.current.id);
assert.ok(!thinConfig.routes);
assert.ok(!thinConfig.r2_buckets);
assert.ok(!thinConfig.placement);
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
  const config = role === "thin" ? "wrangler.storefront-thin.jsonc" : `wrangler.thin-${role}.toml`;
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
  return {
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
async function sample(role, { fresh = false, route = "/" } = {}) {
  const dispatcher = fresh ? new Agent({ connections: 1, pipelining: 1 }) : agents[role];
  const started = performance.now();
  try {
    const r = await httpFetch(origin(role) + route, {
      dispatcher,
      headers: {
        authorization: `Bearer ${keys[role]}`,
        "x-cove-perf-client": String(client++ % 1024),
        "x-cove-perf-renderer": role,
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
    if (route.startsWith("/__cove_perf/")) {
      try {
        const data = JSON.parse(body);
        const expected = route.split("/").at(-1);
        diagnosticValid =
          data.stage === expected &&
          data.ok === true &&
          (expected === "bootstrap" || expected === "rights" ? data.books === 24 : true) &&
          (expected?.startsWith("context") ? data.markets > 0 : true);
      } catch {
        diagnosticValid = false;
      }
    }
    let apiValid = true;
    if (route.startsWith("/api/fore/")) {
      try {
        const payload = JSON.parse(body);
        const pathname = new URL(route, "https://synthetic.invalid").pathname;
        if (pathname === "/api/fore/catalog")
          apiValid = Array.isArray(payload.results) && payload.results.length > 0;
        else if (pathname === "/api/fore/recommendations/home")
          apiValid = Array.isArray(payload.rails);
        else if (pathname === "/api/fore/merchandising")
          apiValid = !!payload.slots && typeof payload.slots === "object";
        else apiValid = false;
      } catch {
        apiValid = false;
      }
    }
    const valid =
      r.status === 200 &&
      diagnosticValid &&
      apiValid &&
      (!home ||
        (links.length === 24 &&
          r.headers.get("content-type")?.includes("text/html") &&
          /no-store/.test(r.headers.get("cache-control") || "")));
    return {
      route,
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
      syntheticErrorCategory: r.headers.get("x-cove-synthetic-error-category"),
      rayId: r.headers.get("cf-ray"),
      observedAt: new Date().toISOString(),
      ...(valid ? {} : { failureBody: body.slice(0, 300) }),
    };
  } catch (e) {
    return {
      route,
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
async function capacity(role, rate, { route = "/", duration = 20_000 } = {}) {
  const interval = 1000 / rate,
    start = performance.now(),
    rows = [],
    pending = new Set();
  let dropped = 0,
    late = 0,
    stop = false,
    scheduled = 0;
  for (let n = 0; n < (rate * duration) / 1000; n++) {
    const due = start + n * interval,
      delay = due - performance.now();
    if (delay > 0) await new Promise((r) => setTimeout(r, delay));
    if (stop) break;
    scheduled++;
    if (performance.now() - due > 100) late++;
    if (pending.size >= 128) {
      dropped++;
      continue;
    }
    const task = sample(role, { route })
      .then((r) => {
        rows.push(r);
        if (!r.valid) stop = true;
      })
      .finally(() => pending.delete(task));
    pending.add(task);
  }
  await Promise.all(pending);
  const elapsed = performance.now() - start,
    s = summary(rows);
  return {
    role,
    route,
    offeredRps: rate,
    durationMs: elapsed,
    completedRps: rows.length / (elapsed / 1000),
    scheduled,
    unscheduled: (rate * duration) / 1000 - scheduled,
    dropped,
    late,
    summary: s,
    pass: !stop && !dropped && !late && !s.errors && s.p95 <= 600 && s.p99 <= 750 && s.max < 800,
    rows,
  };
}
async function mixedCapacity(rate) {
  const duration = 20_000;
  const visitor = "00000000-0000-4000-8000-000000000001";
  const routes = [
    ...Array(11).fill("/"),
    ...Array(4).fill("/api/fore/catalog?search=Synthetic&sort=popular&page=1&currency=USD"),
    ...Array(3).fill("/api/fore/recommendations/home?visitor=" + visitor + "&limit=12"),
    ...Array(2).fill("/api/fore/merchandising?visitor=" + visitor),
  ];
  const began = performance.now();
  const tasks = new Set();
  const rows = [];
  let scheduled = 0;
  let dropped = 0;
  let late = 0;
  let invalid = false;
  const requested = (rate * duration) / 1000;
  for (let i = 0; i < requested; i++) {
    const due = began + (1000 * i) / rate;
    const delay = due - performance.now();
    if (delay > 0) await new Promise((done) => setTimeout(done, delay));
    if (invalid) break;
    scheduled++;
    if (performance.now() - due > 100) late++;
    if (tasks.size >= 128) {
      dropped++;
      continue;
    }
    const route = routes[i % routes.length];
    const task = sample("thin", { route })
      .then((result) => {
        rows.push(result);
        if (!result.valid) invalid = true;
      })
      .finally(() => tasks.delete(task));
    tasks.add(task);
  }
  await Promise.all(tasks);
  const elapsed = performance.now() - began;
  const result = summary(rows);
  return {
    offeredRps: rate,
    durationMs: elapsed,
    requested,
    scheduled,
    unscheduled: requested - scheduled,
    dropped,
    late,
    summary: result,
    routes: Object.fromEntries(
      routes
        .filter((route, i) => routes.indexOf(route) === i)
        .map((route) => {
          const samples = rows.filter((row) => row.route === route);
          return [route, summary(samples)];
        }),
    ),
    pass:
      !invalid &&
      scheduled === requested &&
      !dropped &&
      !late &&
      result.valid === requested &&
      result.p95 <= 600 &&
      result.p99 <= 750 &&
      result.max < 800,
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
  command(["deploy", "--config", "wrangler.storefront-benchmark.jsonc"]);
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
  for (const rate of [10, 25, 50, 100, 250, 500]) {
    let unsafe = false;
    for (const role of [...active]) {
      const result = await capacity(role, rate);
      evidence.capacity.push(result);
      save();
      console.log("capacity", role, rate, JSON.stringify(result.summary));
      if (!result.pass) {
        active.delete(role);
        evidence.capacityStoppedByRole[role] = rate;
      }
      if (result.summary.errors) {
        unsafe = true;
        break;
      }
    }
    if (unsafe || !active.size) break;
  }
  // Short, isolated diagnostic phases reveal whether transport, read-only
  // presentation, or the mandatory primary-rights D1 call stalls first.
  // Probes carry no offers, hit only the synthetic D1, and never replace the
  // 20-second complete-HTML evidence. A failure stops that diagnostic phase.
  for (const stage of ["edge", "context-uncached", "context-cached", "rights"]) {
    for (const rate of [25, 100]) {
      await new Promise((done) => setTimeout(done, 2_000));
      const result = await capacity("thin", rate, {
        route: "/__cove_perf/" + stage,
        duration: 8_000,
      });
      evidence.phaseDiagnosis.push({ stage, ...result });
      save();
      console.log("phase-diagnosis", stage, rate, JSON.stringify(result.summary));
      if (!result.pass) break;
    }
  }
  // Customer-like reads run concurrently against the SAME synthetic D1:
  // homepage, filtered catalog, personalized recommendations and campaigns.
  // These GET journeys cannot certify cart, checkout, reading or account POST.
  for (const rate of [50, 100]) {
    await new Promise((done) => setTimeout(done, 3_000));
    const result = await mixedCapacity(rate);
    evidence.mixed.push(result);
    save();
    console.log("synthetic-mixed", rate, JSON.stringify(result.summary));
    if (!result.pass) break;
  }
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
  const productionLike50 = evidence.capacity.find(
    (x) => x.role === "thin" && x.route === "/" && x.offeredRps === 50,
  );
  const productionLike100 = evidence.capacity.find(
    (x) => x.role === "thin" && x.route === "/" && x.offeredRps === 100,
  );
  evidence.mixedLoadGate = evidence.mixed.some(
    (x) => x.offeredRps === 100 && x.pass && x.unscheduled === 0,
  );
  evidence.sustained100RpsGate =
    !!productionLike50?.pass &&
    !!productionLike100?.pass &&
    productionLike100.unscheduled === 0 &&
    productionLike100.dropped === 0 &&
    productionLike100.late === 0 &&
    productionLike100.summary.valid === 2000;
  // Never equate a passing low-concurrency architectural experiment with
  // a commercial capacity gate after the 100-RPS stage has failed.
  evidence.architecturalGate =
    evidence.mobileGate &&
    evidence.tailReductionGate &&
    evidence.errors.length === 0 &&
    evidence.cold.filter((x) => x.role === "thin").every((x) => x.pass) &&
    evidence.bursts.filter((x) => x.role === "thin").every((x) => x.pass) &&
    evidence.bootstrap.filter((x) => x.role === "thin").every((x) => x.pass) &&
    evidence.capacity.some((x) => x.role === "thin" && x.pass) &&
    !evidence.capacity.some((x) => x.role === "thin" && x.summary.errors) &&
    evidence.contentParity &&
    evidence.remoteRevocation?.pass &&
    evidence.matchedColo;
  if (!evidence.architecturalGate || !evidence.sustained100RpsGate || !evidence.mixedLoadGate)
    failed = true;
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
