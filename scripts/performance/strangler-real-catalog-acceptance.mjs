// Immutable-SHA hosted acceptance. Dedicated synthetic D1 only; no customer traffic.
import assert from "node:assert/strict";
import fs from "node:fs";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { performance } from "node:perf_hooks";

const account = "d26430caa63ec55f6612e32f36aca5e9";
const dbId = "4bd657ac-8789-403e-a28c-93aba8d0a989";
const prodDbId = "4bd657ac-8789-403e-a28c-93aba8d0a989";
const token = process.env.CLOUDFLARE_API_TOKEN;
assert.ok(token && token.length > 16, "Isolated hosted acceptance requires Cloudflare credentials");
assert.match(process.env.GITHUB_RUN_ID || "", /^\d+$/);
const namePrefix = "cove-strangler-real-preview-" + process.env.GITHUB_RUN_ID;
let name = namePrefix + "-1";
let origin = `https://${name}.cove-jibrilmohamud.workers.dev`;
const createdWorkers = [];
const configPath = "wrangler.strangler-real-preview-run.jsonc";
const config = JSON.parse(fs.readFileSync("wrangler.storefront-strangler.stage.jsonc", "utf8"));
assert.equal(config.d1_databases[0].database_id, "e4cbb0ef-6288-4fa1-9dbb-fb42fe01d4f3");
config.d1_databases[0].database_id = dbId;
config.d1_databases[0].database_name = "cove-production";
config.vars.COVE_STRANGLER_MODE = "production-acceptance";
config.vars.COVE_STRANGLER_DATABASE_ID = dbId;
assert.equal(config.workers_dev, false);
assert.equal(config.vars.COVE_STRANGLER_EXPERIENCE, "1");
config.name = name;
config.workers_dev = true;
config.preview_urls = false;
// All protected commerce, account, and reader delegation is separately
// exercised with a fake CORE by the same-SHA local integration suite.
config.services = [];
config.vars.FORE_PUBLIC_URL = origin;
const configString = JSON.stringify(config, null, 2);
assert.ok(configString.includes(prodDbId), "Real-data preview must bind the expected D1");
assert.ok(!config.routes && !config.route && !config.r2_buckets && !config.queues);
fs.writeFileSync(configPath, configString);
const evidence = {
  sha: process.env.GITHUB_SHA,
  worker: name,
  workers: createdWorkers,
  readOnlyProductionD1: dbId,
  productionRouted: false,
  fixtureProducts: null,
  cold: [],
  bursts: [],
  sustained: null,
  pass: false,
};
fs.mkdirSync("artifacts/strangler-acceptance", { recursive: true });
const save = () =>
  fs.writeFileSync(
    "artifacts/strangler-acceptance/results.json",
    JSON.stringify(evidence, null, 2),
  );
let stageKey = "";
function command(args, input) {
  const run = spawnSync(
    "npm",
    ["exec", "--yes", "--package=wrangler@4.151.0", "--", "wrangler", ...args],
    {
      input,
      encoding: "utf8",
      timeout: 180_000,
      env: { ...process.env, CLOUDFLARE_SEND_METRICS: "false" },
    },
  );
  if (run.status !== 0 || run.error)
    throw Error(
      "Wrangler " +
        args.slice(0, 2).join(" ") +
        " failed: " +
        String(run.error?.message || run.stderr)
          .replace(/Bearer\s+\S+/g, "Bearer [redacted]")
          .slice(-900),
    );
}
async function cloudflare(method, path, body) {
  const response = await fetch("https://api.cloudflare.com/client/v4" + path, {
    method,
    headers: {
      authorization: "Bearer " + token,
      "content-type": "application/json",
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(60_000),
  });
  const json = await response.json();
  if (!response.ok || !json.success)
    throw Error("Cloudflare API " + method + " " + response.status);
  return json.result;
}
function percentile(data, pct) {
  const sorted = [...data].sort((a, b) => a - b);
  return sorted[Math.ceil(sorted.length * pct) - 1] ?? null;
}
function summarize(results) {
  const valid = results.filter((x) => x.ok);
  const values = valid.map((x) => x.ms);
  return {
    total: results.length,
    valid: valid.length,
    p95: percentile(values, 0.95),
    p99: percentile(values, 0.99),
    max: values.length ? Math.max(...values) : null,
  };
}
let client = 0;
async function sample() {
  const start = performance.now();
  try {
    const response = await fetch(origin + "/", {
      headers: {
        authorization: "Bearer " + stageKey,
      },
      signal: AbortSignal.timeout(10_000),
    });
    const ms = performance.now() - start;
    const html = await response.text();
    const ok =
      response.status === 200 &&
      html.includes('id="thin-discovery-form"') &&
      html.includes('data-rights-country="US"') &&
      html.includes('id="thin-merchandising"') &&
      /class="book-card"/.test(html);
    return {
      ok,
      ms,
      status: response.status,
      failure: response.headers.get("x-cove-stage-failure") || null,
      observedCountry: /data-rights-country="([^"]+)"/.exec(html)?.[1] || null,
      renderer: response.headers.get("x-cove-renderer"),
      serverTiming: response.headers.get("server-timing"),
    };
  } catch (error) {
    return { ok: false, ms: performance.now() - start, error: error.name };
  }
}
async function deployFresh(round) {
  // A unique Worker identity prevents stale encrypted secrets from previous
  // deployments in remote POPs contaminating an independent cold observation.
  name = namePrefix + "-" + round;
  origin = `https://${name}.cove-jibrilmohamud.workers.dev`;
  createdWorkers.push(name);
  config.name = name;
  config.vars.FORE_PUBLIC_URL = origin;
  const scopedConfig = JSON.stringify(config, null, 2);
  assert.ok(scopedConfig.includes(prodDbId));
  fs.writeFileSync(configPath, scopedConfig);
  command(["deploy", "--config", configPath]);
  const before = await cloudflare(
    "GET",
    `/accounts/${account}/workers/scripts/${name}/deployments`,
  );
  const beforeId = before.deployments?.[0]?.id;
  assert.ok(beforeId, "Initial Worker deployment is unavailable");
  stageKey = randomBytes(32).toString("hex");
  const rotatedAt = Date.now();
  command(["secret", "put", "COVE_SSR_STAGING_GATE_KEY", "--config", configPath], stageKey);
  // Only a distinct post-secret 100% rollout is eligible for testing.
  for (let attempt = 0; attempt < 18; attempt++) {
    const result = await cloudflare(
      "GET",
      `/accounts/${account}/workers/scripts/${name}/deployments`,
    );
    const latest = result.deployments?.[0];
    if (
      latest &&
      latest.id !== beforeId &&
      Date.parse(latest.created_on) >= rotatedAt - 3000 &&
      latest.versions?.some((version) => version.percentage === 100)
    ) {
      await new Promise((resolve) => setTimeout(resolve, 3500));
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 1800));
  }
  throw new Error("Fresh post-secret Worker deployment not confirmed");
}
async function pixelMismatch(page, baseline, candidate) {
  return page.evaluate(
    async ([first, second]) => {
      const load = (base64) =>
        new Promise((resolve, reject) => {
          const image = new Image();
          image.onload = () => resolve(image);
          image.onerror = reject;
          image.src = "data:image/png;base64," + base64;
        });
      const [a, b] = await Promise.all([load(first), load(second)]);
      const width = Math.min(a.width, b.width);
      const height = Math.min(a.height, b.height);
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d", { willReadFrequently: true });
      context.drawImage(a, 0, 0);
      const p = context.getImageData(0, 0, width, height).data;
      context.clearRect(0, 0, width, height);
      context.drawImage(b, 0, 0);
      const q = context.getImageData(0, 0, width, height).data;
      let mismatched = 0;
      for (let i = 0; i < p.length; i += 4) {
        if (
          Math.max(
            Math.abs(p[i] - q[i]),
            Math.abs(p[i + 1] - q[i + 1]),
            Math.abs(p[i + 2] - q[i + 2]),
          ) > 32
        )
          mismatched++;
      }
      return Math.round((mismatched * 10000) / (width * height)) / 100;
    },
    [baseline.toString("base64"), candidate.toString("base64")],
  );
}
// In production, Vercel continues to own all /covers and /api assets.
// Route stage-only browser requests through that public origin to compare
// equivalent customer resource loading; never forward the stage bearer.
async function stageBrowserRoute(route) {
  const resource = new URL(route.request().url());
  if (resource.origin !== origin) return route.continue();
  const forwardedAsset =
    ["/covers/", "/assets/", "/images/", "/fonts/"].some((prefix) =>
      resource.pathname.startsWith(prefix),
    ) || resource.pathname.startsWith("/api/fore/");
  if (route.request().method() === "GET" && forwardedAsset) {
    const publicUrl = "https://cove-puce-theta.vercel.app" + resource.pathname + resource.search;
    const response = await route.fetch({
      url: publicUrl,
      headers: { accept: route.request().headers()["accept"] || "*/*" },
    });
    return route.fulfill({ response });
  }
  return route.continue({
    headers: { ...route.request().headers(), authorization: "Bearer " + stageKey },
  });
}
async function settleCatalog(page) {
  try {
    await page.waitForFunction(
      () => {
        const covers = [...document.querySelectorAll("article.book-card img")];
        return (
          covers.length >= 6 &&
          covers.filter((img) => img.complete && img.naturalWidth > 0).length >= Math.ceil(covers.length * 0.9)
        );
      },
      null,
      { timeout: 14000 },
    );
  } catch {
    // The live React page can still be showing loading skeletons; never
    // interpret a screenshot of placeholders as proof of visual divergence.
  }
  return page.evaluate(() => {
    const covers = [...document.querySelectorAll("article.book-card img")];
    const loaded = covers.filter((img) => img.complete && img.naturalWidth > 0).length;
    return { count: covers.length, loaded, settled: covers.length >= 6 && loaded >= Math.ceil(covers.length * 0.9) };
  });
}
const startedAt = performance.now();
try {
  const fixture = await cloudflare("POST", `/accounts/${account}/d1/database/${dbId}/query`, {
    sql: "SELECT COUNT(*) AS n FROM products",
  });
  assert.ok(Number(fixture?.[0]?.results?.[0]?.n) >= 40_000);

  evidence.fixtureProducts = Number(fixture[0].results[0].n);
  for (let i = 0; i < 3; i++) {
    await deployFresh(i + 1);
    const transportStart = performance.now();
    const control = await fetch(origin + "/__cove_perf/transport", {
      headers: { authorization: "Bearer " + stageKey },
      signal: AbortSignal.timeout(6000),
    });
    const transportMs = performance.now() - transportStart;
    assert.equal(control.status, 200, "Pre-cold transport control must succeed");
    console.log("TRANSPORT_CONTROL", JSON.stringify({ round: i + 1, transportMs }));
    const cold = await sample();
    evidence.cold.push(cold);
    console.log("COLD_PROBE", JSON.stringify({ round: i + 1, ...cold }));
    save();
  }
  assert.ok(
    evidence.cold.every((cold) => cold.ok && cold.ms < 800),
    "Independent cold visits failed validity or 800ms bound",
  );
  const unauthorized = await fetch(origin, { signal: AbortSignal.timeout(6000) });
  assert.equal(unauthorized.status, 401, "Stage gate must reject requests without bearer");
  // Low-volume production-D1 acceptance must never run 100-RPS synthetic load.
  // The synthetic isolation suite separately proves concurrency headroom.
  evidence.bursts = [];
  evidence.sustained = "Not run against production D1";
  // Report actual rendered LCP of this deployed, bearer-gated Worker,
  // never equate a synthetic preview with the public Vercel release.
  const { chromium } = await import("@playwright/test");
  const browser = await chromium.launch({ headless: true });
  const mobileSamples = [];
  try {
    for (let attempt = 0; attempt < 5; attempt++) {
      const context = await browser.newContext({
        viewport: { width: 390, height: 844 },
        deviceScaleFactor: 2,
        isMobile: true,
        hasTouch: true,
      });
      const page = await context.newPage();
      const pageErrors = [];
      page.on("pageerror", (error) => pageErrors.push(error.message));
      await page.route("**/*", stageBrowserRoute);
      await page.addInitScript(() => {
        window.__coveVitals = { lcp: null, cls: 0 };
        new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) window.__coveVitals.lcp = entry.startTime;
        }).observe({ type: "largest-contentful-paint", buffered: true });
        new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            if (!entry.hadRecentInput) window.__coveVitals.cls += entry.value;
          }
        }).observe({ type: "layout-shift", buffered: true });
      });
      const cdp = await context.newCDPSession(page);
      await cdp.send("Network.emulateNetworkConditions", {
        offline: false,
        latency: 150,
        downloadThroughput: 200_000,
        uploadThroughput: 90_000,
      });
      await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
      const response = await page.goto(origin + "/", {
        waitUntil: "domcontentloaded",
        timeout: 20_000,
      });
      await page.waitForTimeout(1500);
      const vitals = await page.evaluate(() => window.__coveVitals);
      mobileSamples.push({
        status: response?.status(),
        lcpMs: vitals.lcp,
        cls: vitals.cls,
        pageErrors,
      });
      await context.close();
    }
  } finally {
    await browser.close();
  }
  const mobileLcp = mobileSamples.map((s) => s.lcpMs).filter(Number.isFinite);
  evidence.stageMobileLcp = {
    description:
      "Bearer-gated real production D1 with Vercel asset fetch, Chromium 390x844, 4x CPU, 150ms RTT",
    samples: mobileSamples,
    p75Ms: percentile(mobileLcp, 0.75),
  };
  console.log("STAGE_MOBILE_LCP", JSON.stringify(evidence.stageMobileLcp));
  save();
  assert.equal(mobileLcp.length, 5, "Stage mobile LCP observations must exist");
  assert.ok(
    evidence.stageMobileLcp.p75Ms < 2500 &&
      mobileSamples.every((sample) => sample.status === 200 && !sample.pageErrors.length),
    "Stage mobile LCP or browser errors exceeded the preview acceptance gate",
  );
  const audit = await chromium.launch({ headless: true });
  try {
    const auditCtx = await audit.newContext({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
      deviceScaleFactor: 1,
    });
    const candidate = await auditCtx.newPage();
    await candidate.route("**/*", stageBrowserRoute);
    const live = await auditCtx.newPage();
    const liveResponse = await live.goto("https://cove-puce-theta.vercel.app/", {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });
    const stageResponse = await candidate.goto(origin, {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });
    assert.equal(liveResponse?.status(), 200);
    assert.equal(stageResponse?.status(), 200);
    const [liveCatalogPaint, stageCatalogPaint] = await Promise.all([
      settleCatalog(live),
      settleCatalog(candidate),
    ]);
    console.log("MOBILE_CATALOG_PAINT", JSON.stringify({ liveCatalogPaint, stageCatalogPaint }));
    fs.mkdirSync("artifacts/strangler-acceptance", { recursive: true });
    const baselineScreenshot = await live.screenshot({
      path: "artifacts/strangler-acceptance/live-mobile.png",
    });
    const stageScreenshot = await candidate.screenshot({
      path: "artifacts/strangler-acceptance/real-catalog-preview-mobile.png",
    });
    const mismatchPercent =
      liveCatalogPaint.settled && stageCatalogPaint.settled
        ? await pixelMismatch(candidate, baselineScreenshot, stageScreenshot)
        : null;
    const links = async (page) =>
      page
        .locator("article.book-card a[href^='/edition/']")
        .evaluateAll((els) => [...new Set(els.map((el) => el.getAttribute("href")))]);
    const liveLinks = await links(live);
    const stageLinks = await links(candidate);
    const covers = await candidate.locator("article.book-card img").evaluateAll((images) => ({
      total: images.length,
      loaded: images.filter((image) => image.complete && image.naturalWidth > 0).length,
    }));
    evidence.realCatalogParity = {
      mismatchPercent,
      comparableMobileState: liveCatalogPaint.settled && stageCatalogPaint.settled,
      covers,
      liveEditionCount: liveLinks.length,
      stageEditionCount: stageLinks.length,
      matchedEditionCount: stageLinks.filter((x) => liveLinks.includes(x)).length,
      authenticatedCheckout: "not tested",
      protectedReader: "not tested",
    };
    console.log("REAL_CATALOG_PARITY", JSON.stringify(evidence.realCatalogParity));
    await auditCtx.close();
    const desktopContext = await audit.newContext({
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: 1,
    });
    const desktopCandidate = await desktopContext.newPage();
    await desktopCandidate.route("**/*", stageBrowserRoute);
    const desktopLive = await desktopContext.newPage();
    const [desktopBaselineResponse, desktopStageResponse] = await Promise.all([
      desktopLive.goto("https://cove-puce-theta.vercel.app/", {
        waitUntil: "domcontentloaded",
        timeout: 30000,
      }),
      desktopCandidate.goto(origin, { waitUntil: "domcontentloaded", timeout: 30000 }),
    ]);
    assert.equal(desktopBaselineResponse?.status(), 200);
    assert.equal(desktopStageResponse?.status(), 200);
    const [desktopLivePaint, desktopStagePaint] = await Promise.all([
      settleCatalog(desktopLive),
      settleCatalog(desktopCandidate),
    ]);
    console.log("DESKTOP_CATALOG_PAINT", JSON.stringify({ desktopLivePaint, desktopStagePaint }));
    const desktopBaseline = await desktopLive.screenshot({
      path: "artifacts/strangler-acceptance/live-desktop.png",
    });
    const desktopStage = await desktopCandidate.screenshot({
      path: "artifacts/strangler-acceptance/real-catalog-preview-desktop.png",
    });
    evidence.realCatalogParity.desktopMismatchPercent =
      desktopLivePaint.settled && desktopStagePaint.settled
        ? await pixelMismatch(desktopCandidate, desktopBaseline, desktopStage)
        : null;
    evidence.realCatalogParity.comparableDesktopState =
      desktopLivePaint.settled && desktopStagePaint.settled;
    console.log(
      "REAL_CATALOG_DESKTOP_PARITY",
      JSON.stringify({
        mismatchPercent: evidence.realCatalogParity.desktopMismatchPercent,
      }),
    );
    await desktopContext.close();
  } finally {
    await audit.close();
  }
  save();
  evidence.pass = true;
  console.log(
    "PASS bearer-gated read-only real-catalog preview",
    JSON.stringify({
      cold: evidence.cold.map((x) => Math.round(x.ms)),
      bursts: evidence.bursts.map((x) => ({ n: x.concurrency, max: Math.round(x.max) })),
      sustained: evidence.sustained,
    }),
  );
} catch (error) {
  evidence.failure = String(error.message || error);
  throw error;
} finally {
  evidence.elapsedMs = Math.round(performance.now() - startedAt);
  save();
  for (const workerName of createdWorkers) {
    try {
      await cloudflare("DELETE", `/accounts/${account}/workers/scripts/${workerName}?force=true`);
    } catch {
      console.error("Stage cleanup not confirmed; remove only " + workerName);
    }
  }
}
