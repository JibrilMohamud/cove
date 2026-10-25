import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { chromium, devices } from "@playwright/test";
import {
  percentile,
  productionOrigin,
  safeProbeTelemetry,
} from "../check-production-storefront-performance.mjs";

// Runs AFTER every cold HTTP trial. Browser asset requests must never warm
// the Worker before its first counted SSR request.
const origin = productionOrigin(process.env.COVE_SSR_STAGING_ORIGIN);
const token = process.env.COVE_SSR_STAGING_GATE_KEY;
assert.match(token || "", /^[a-f0-9]{64}$/);
const rows = [];
const browser = await chromium.launch();
try {
  for (const profile of ["desktop", "mobile-4g"]) {
    for (let sample = 1; sample <= 4; sample++) {
      const context = await browser.newContext({
        ...(profile === "desktop"
          ? { viewport: { width: 1440, height: 1000 } }
          : devices["Pixel 5"]),
        serviceWorkers: "block",
      });
      const page = await context.newPage();
      const cdp = await context.newCDPSession(page);
      let interceptionErrors = 0;
      // CDP applies header overrides to this request only, NOT redirects.
      // Every hop pauses again; the bearer key never reaches external covers.
      // Playwright route.continue header overrides persist across redirects.
      cdp.on("Fetch.requestPaused", (event) => {
        const headers = Object.entries(event.request.headers)
          .filter(([name]) => name.toLowerCase() !== "authorization")
          .map(([name, value]) => ({ name, value: String(value) }));
        if (new URL(event.request.url).origin === origin)
          headers.push({ name: "Authorization", value: "Bearer " + token });
        void cdp
          .send("Fetch.continueRequest", { requestId: event.requestId, headers })
          .catch(() => interceptionErrors++);
      });
      await cdp.send("Fetch.enable", { patterns: [{ urlPattern: "*", requestStage: "Request" }] });
      await cdp.send("Network.enable");
      await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
      if (profile === "mobile-4g") {
        await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
        await cdp.send("Network.enable");
        await cdp.send("Network.emulateNetworkConditions", {
          offline: false,
          latency: 150,
          downloadThroughput: 200000,
          uploadThroughput: 93750,
        });
      }
      await page.addInitScript(() => {
        // Aggregate-only Core Web Vitals attribution. Do not log text, URL,
        // image title, cover identifier, IP, or user-controlled attributes.
        window.__covePaint = { lcp: null, target: "unknown", loadDelay: null, renderDelay: null };
        new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            const el = entry.element;
            const tag = el?.tagName?.toLowerCase();
            window.__covePaint = {
              lcp: entry.startTime,
              target: tag === "img" ? "image" : tag === "h1" ? "heading" :
                tag === "h2" ? "subheading" : tag === "p" ? "paragraph" : "other",
              loadDelay: entry.loadTime > 0 ? Math.round(entry.loadTime - performance.getEntriesByType("navigation")[0].responseStart) : null,
              renderDelay: entry.loadTime > 0 ? Math.round(entry.renderTime - entry.loadTime) : null,
            };
          }
        }).observe({ type: "largest-contentful-paint", buffered: true });
      });
      let failure = null;
      let status = null;
      let responseTelemetry = {};
      let failurePhase = "navigation";
      let pageErrors = 0;
      let consoleErrors = 0;
      let failedScriptRequests = 0;
      let failedStylesheetRequests = 0;
      const scripts = {
        ok: 0,
        redirects: 0,
        unauthorized: 0,
        missing: 0,
        other4xx: 0,
        server5xx: 0,
      };
      // Counters only: no URL, host, request body, header or error message is
      // retained. This distinguishes missing bundles from React not hydrating.
      page.on("pageerror", () => pageErrors++);
      page.on("console", (msg) => {
        if (msg.type() === "error") consoleErrors++;
      });
      page.on("requestfailed", (request) => {
        if (request.resourceType() === "script") failedScriptRequests++;
        if (request.resourceType() === "stylesheet") failedStylesheetRequests++;
      });
      page.on("response", (response) => {
        if (response.request().resourceType() !== "script") return;
        const status = response.status();
        if (status >= 200 && status < 300) scripts.ok++;
        else if (status >= 300 && status < 400) scripts.redirects++;
        else if (status === 401 || status === 403) scripts.unauthorized++;
        else if (status === 404) scripts.missing++;
        else if (status >= 400 && status < 500) scripts.other4xx++;
        else if (status >= 500) scripts.server5xx++;
      });
      try {
        const response = await page.goto(origin, { waitUntil: "load", timeout: 45000 });
        status = response.status();
        assert.equal(status, 200);
        failurePhase = "catalog";
        // Playwright's flattened response header object is not guaranteed to
        // round-trip through the WHATWG Headers constructor (which can reject
        // otherwise accepted wire values). Telemetry must NEVER abort browser
        // hydration checks; parse only the two numeric allowlisted fields.
        try {
          const headerValues = response.headers();
          responseTelemetry = safeProbeTelemetry(
            { get: (name) => headerValues[name.toLowerCase()] ?? null },
            0,
            0,
          );
          delete responseTelemetry.ttfbMs;
          delete responseTelemetry.totalMs;
        } catch {
          responseTelemetry = {};
        }
        await page.locator(".book-card").first().waitFor({ timeout: 15000 });
        failurePhase = "hydration";
        await page.locator('html[data-cove-client-ready="true"]').waitFor({ timeout: 15000 });
        failurePhase = "paint";
        // Allow late images/layout to replace the initial text LCP. Do not
        // interact with the page, which would stop LCP observation early.
        await page.waitForTimeout(2500);
      } catch {
        // Do not serialize browser errors: they can include request headers.
        failure = "Navigation, authorized catalog or hydration failed";
      }
      const metrics = await page
        .evaluate(() => {
          const nav = performance.getEntriesByType("navigation")[0];
          return {
            ttfbMs: nav?.responseStart ?? null,
            lcpMs: window.__covePaint?.lcp ?? null,
            lcpTarget: window.__covePaint?.target ?? "unknown",
            lcpLoadDelayMs: window.__covePaint?.loadDelay ?? null,
            lcpRenderDelayMs: window.__covePaint?.renderDelay ?? null,
            // Only aggregate initiator/timing buckets; never asset URLs.
            resourceByType: performance.getEntriesByType("resource")
              .reduce((acc, resource) => {
                const category = resource.initiatorType === "img" ? "image" :
                  resource.initiatorType === "script" ? "script" :
                  resource.initiatorType === "link" ? "link" : "other";
                const bucket = acc[category] || { count: 0, lastResponseEndMs: 0 };
                bucket.count++;
                bucket.lastResponseEndMs = Math.max(bucket.lastResponseEndMs, Math.round(resource.responseEnd));
                acc[category] = bucket;
                return acc;
              }, {}),
            cards: document.querySelectorAll(".book-card").length,
            hydrated: document.documentElement.dataset.coveClientReady === "true",
            scriptTags: document.querySelectorAll("script[src]").length,
            moduleScriptTags: document.querySelectorAll('script[type="module"]').length,
            sameOriginScripts: [...document.querySelectorAll("script[src]")].filter((script) => {
              try {
                return new URL(script.src).origin === location.origin;
              } catch {
                return false;
              }
            }).length,
            connectMs: nav ? nav.connectEnd - nav.connectStart : null,
            dnsMs: nav ? nav.domainLookupEnd - nav.domainLookupStart : null,
            tlsMs: nav?.secureConnectionStart ? nav.connectEnd - nav.secureConnectionStart : null,
            protocol: ["h2", "h3", "http/1.1"].includes(nav?.nextHopProtocol)
              ? nav.nextHopProtocol
              : "unknown",
          };
        })
        .catch(() => ({ ttfbMs: null, lcpMs: null, cards: 0 }));
      rows.push({
        profile,
        sample,
        status,
        failure,
        failurePhase: failure ? failurePhase : null,
        pageErrors,
        consoleErrors,
        failedScriptRequests,
        failedStylesheetRequests,
        scripts,
        interceptionErrors,
        ...responseTelemetry,
        ...metrics,
      });
      await context.close();
    }
  }
} finally {
  await browser.close();
}
const profiles = ["desktop", "mobile-4g"].map((profile) => {
  const samples = rows.filter((row) => row.profile === profile);
  const valid = samples.every(
    (r) =>
      !r.failure &&
      !r.pageErrors &&
      !r.interceptionErrors &&
      r.cards > 0 &&
      Number.isFinite(r.lcpMs) &&
      Number.isFinite(r.ttfbMs) &&
      r.ttfbMs < 800,
  );
  const lcpP75Ms = percentile(samples.map((r) => r.lcpMs).filter(Number.isFinite), 0.75);
  return { profile, lcpP75Ms, pass: valid && lcpP75Ms < 2500 };
});
const report = {
  boundary:
    "Synthetic Chromium, four fresh browser contexts per profile, after cold HTTP tests. Not cold-server or field p75 proof. Mobile: 4x CPU, 150ms latency, 1.6Mbps. Browser cache disabled and service workers blocked for both profiles.",
  targets: { everyTtfbBelowMs: 800, labLcpP75BelowMs: 2500 },
  profiles,
  rows,
};
await fs.mkdir("artifacts", { recursive: true });
await fs.writeFile(
  "artifacts/cloudflare-browser-performance.json",
  JSON.stringify(report, null, 2),
);
console.log(JSON.stringify(report));
if (profiles.some((p) => !p.pass)) process.exitCode = 1;
