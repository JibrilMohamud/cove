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
import { parseThinConfig } from "./thin-config.mjs";
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
  },
  cold: [],
  bursts: [],
  capacity: [],
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
};
const origin = (role) => `https://${workers[role]}.cove-jibrilmohamud.workers.dev`;
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
  config += `\nCOVE_PERF_DATABASE_ID = "${PERFORMANCE_D1[dbrole].id}"\n`;
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
      },
      signal: AbortSignal.timeout(8000),
    });
    const ttfb = performance.now() - started;
    const body = await r.text();
    const links = [...body.matchAll(/<a(?=[^>]*class="[^"]*book-title)[^>]*href="([^"]+)"/g)].map(
      (x) => x[1],
    );
    const home = route === "/";
    const valid =
      r.status === 200 &&
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
const agents = Object.fromEntries(
  ["baseline", "thin"].map((x) => [x, new Agent({ connections: 128, pipelining: 1 })]),
);
async function browserCheck(role) {
  const browser = await chromium.launch();
  const results = [];
  try {
    for (let i = 0; i < 5; i++) {
      const context = await browser.newContext({
        ...devices["Pixel 5"],
        extraHTTPHeaders: {
          authorization: `Bearer ${keys[role]}`,
          "x-cove-perf-client": String(3000 + i),
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
      if (i === 0) {
        const axe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
        assert.deepEqual(
          axe.violations.map((x) => x.id),
          [],
        );
        await page.screenshot({ path: path.join(output, `${role}-mobile.png`), fullPage: true });
        await page.locator("input[type=search]").first().fill("Synthetic");
        await page.locator("input[type=search]").first().press("Enter");
        await page.waitForURL(
          (url) => url.pathname === "/" && url.searchParams.get("search") === "Synthetic",
          { timeout: 30000 },
        );
        assert.ok((await page.locator("body").innerText()).includes("Synthetic"));
      }
      await context.close();
    }
    return { role, lcp: results, p75: pct(results, 0.75), pass: pct(results, 0.75) <= 2000 };
  } finally {
    await browser.close();
  }
}
async function capacity(role, rate) {
  const duration = 20_000,
    interval = 1000 / rate,
    start = performance.now(),
    rows = [],
    pending = new Set();
  let dropped = 0,
    late = 0;
  for (let n = 0; n < (rate * duration) / 1000; n++) {
    const due = start + n * interval,
      delay = due - performance.now();
    if (delay > 0) await new Promise((r) => setTimeout(r, delay));
    if (performance.now() - due > 100) late++;
    if (pending.size >= 128) {
      dropped++;
      continue;
    }
    const task = sample(role)
      .then((r) => rows.push(r))
      .finally(() => pending.delete(task));
    pending.add(task);
  }
  await Promise.all(pending);
  const elapsed = performance.now() - start,
    s = summary(rows);
  return {
    role,
    offeredRps: rate,
    durationMs: elapsed,
    completedRps: rows.length / (elapsed / 1000),
    dropped,
    late,
    summary: s,
    pass: !dropped && !late && !s.errors && s.p95 <= 600 && s.p99 <= 750 && s.max < 800,
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
  const unauth = await fetch(origin("thin"));
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

evidence.startedAt = new Date().toISOString();
let failed = false;
try {
  await readiness();
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
      if (!pass) failed = true;
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
        if (!pass) failed = true;
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
      evidence.browser.push(await browserCheck(role));
      save();
    } catch (e) {
      evidence.errors.push({ phase: "browser", role, error: String(e) });
      failed = true;
      save();
    }
  // Measure capacity only on synthetic D1. Circuit stops at the first failed stage.
  for (const rate of [10, 25, 50, 100, 250, 500]) {
    let stop = false;
    for (const role of ["baseline", "thin"]) {
      const result = await capacity(role, rate);
      evidence.capacity.push(result);
      save();
      console.log("capacity", role, rate, JSON.stringify(result.summary));
      if (!result.pass) stop = true;
    }
    if (stop) {
      evidence.capacityStoppedAt = rate;
      break;
    }
  }
  const mobile = evidence.browser.find((x) => x.role === "thin"),
    controlMobile = evidence.browser.find((x) => x.role === "baseline");
  evidence.mobileGate =
    !!mobile && !!controlMobile && mobile.p75 <= 2000 && mobile.p75 <= controlMobile.p75;
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
    evidence.contentParity &&
    evidence.matchedColo;
  if (!evidence.architecturalGate) failed = true;
  evidence.finishedAt = new Date().toISOString();
  evidence.workerPlatform = {};
  for (const role of ["baseline", "thin", "core"])
    evidence.workerPlatform[role] = await platformSnapshot(role);
  // Prototype has different visual/interaction design. Passing these measurements
  // NEVER certifies existing-customer-journey equivalence or production readiness.
  evidence.releaseApproved = false;
  save();
} catch (e) {
  failed = true;
  evidence.errors.push({ phase: "campaign", error: String(e).slice(0, 2000) });
  save();
} finally {
  for (const a of Object.values(agents)) await a.close();
}
if (failed) process.exitCode = 1;
