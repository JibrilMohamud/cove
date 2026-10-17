import fs from "node:fs/promises";
import path from "node:path";
import { chromium, devices } from "@playwright/test";
import { productionOrigin, percentile } from "../check-production-storefront-performance.mjs";

const origin = productionOrigin(
  process.env.COVE_PUBLIC_URL || "https://cove-puce-theta.vercel.app",
);
const output = "artifacts/fullsite-performance";
await fs.mkdir(output, { recursive: true });
const browser = await chromium.launch();
const results = [];
const routes = [
  "/",
  "/search?q=mystery",
  "/book/1342",
  "/library",
  "/community",
  "/audiobooks",
  "/read/1342",
];
try {
  for (const profile of ["desktop", "mobile-4g"]) {
    for (const route of routes) {
      const context = await browser.newContext({
        ...(profile === "mobile-4g"
          ? devices["Pixel 5"]
          : { viewport: { width: 1440, height: 1000 } }),
        serviceWorkers: "allow",
      });
      const page = await context.newPage();
      const cdp = await context.newCDPSession(page);
      await cdp.send("Performance.enable");
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
        const state = (window.__coveLab = {
          lcp: null,
          cls: 0,
          session: 0,
          firstShift: 0,
          lastShift: 0,
          tasks: [],
          events: [],
          shifts: [],
          observed: [],
        });
        for (const type of ["largest-contentful-paint", "layout-shift", "longtask", "event"]) {
          try {
            new PerformanceObserver((list) => {
              for (const entry of list.getEntries()) {
                if (type === "largest-contentful-paint") {
                  state.lcp = entry.startTime;
                  state.lcpElement = entry.element
                    ? {
                        tag: entry.element.tagName,
                        className: String(entry.element.className).slice(0, 100),
                      }
                    : null;
                }
                if (type === "longtask") state.tasks.push(entry.duration);
                if (type === "event" && entry.interactionId) state.events.push(entry.duration);
                if (type === "layout-shift" && !entry.hadRecentInput) {
                  state.shifts.push({
                    value: entry.value,
                    time: entry.startTime,
                    sources: (entry.sources || []).map((source) => ({
                      tag: source.node?.tagName,
                      className: String(source.node?.className || "").slice(0, 100),
                      previous: source.previousRect.toJSON(),
                      current: source.currentRect.toJSON(),
                    })),
                  });
                  if (
                    state.firstShift === 0 ||
                    entry.startTime - state.lastShift > 1000 ||
                    entry.startTime - state.firstShift > 5000
                  ) {
                    state.session = 0;
                    state.firstShift = entry.startTime;
                  }
                  state.session += entry.value;
                  state.lastShift = entry.startTime;
                  state.cls = Math.max(state.cls, state.session);
                }
              }
            }).observe({
              type,
              buffered: true,
              ...(type === "event" ? { durationThreshold: 16 } : {}),
            });
            state.observed.push(type);
          } catch {
            /* Unsupported observer types are reported as absent, not zero field INP. */
          }
        }
      });
      let requests = [],
        errors = [];
      context.on("request", (request) => {
        const url = new URL(request.url());
        if (["http:", "https:"].includes(url.protocol))
          requests.push({ path: url.pathname, host: url.hostname });
      });
      page.on("pageerror", (error) => errors.push(error.name));
      for (const phase of ["fresh-context", "repeat"]) {
        requests = [];
        errors = [];
        const started = Date.now();
        const captureCpu = route === "/" && phase === "fresh-context";
        if (captureCpu) {
          await cdp.send("Profiler.enable");
          await cdp.send("Profiler.start");
        }
        let status = null,
          failure = null,
          interactionNextPaintMs = null;
        try {
          const response =
            phase === "repeat"
              ? await page.reload({ waitUntil: "domcontentloaded", timeout: 45000 })
              : await page.goto(origin + route, { waitUntil: "domcontentloaded", timeout: 45000 });
          status = response?.status();
          if (status !== 200) throw Error("HTTP " + status);
          await page.locator('html[data-cove-client-ready="true"]').waitFor({ timeout: 20000 });
          if (route === "/" || route.startsWith("/search"))
            await page.locator(".book-card").first().waitFor({ timeout: 20000 });
          if (route.startsWith("/read/"))
            await page
              .locator("iframe")
              .first()
              .contentFrame()
              .locator("body")
              .waitFor({ timeout: 45000 });
          if (
            await page
              .getByRole("heading", { name: "This page didn't load", exact: true })
              .isVisible()
          )
            throw Error("Application error boundary");
          await page.waitForTimeout(2000);
          if (route === "/") {
            const button =
              profile === "mobile-4g"
                ? page.getByRole("button", { name: "Open navigation", exact: true })
                : page.getByRole("button", { name: "Log in", exact: true });
            await button.waitFor({ state: "visible" });
            const interactionStarted = Date.now();
            await button.click();
            await page.evaluate(
              () =>
                new Promise((resolve) =>
                  requestAnimationFrame(() => requestAnimationFrame(resolve)),
                ),
            );
            interactionNextPaintMs = Date.now() - interactionStarted;
            await page.keyboard.press("Escape");
          }
        } catch (error) {
          failure = String(error.message).split("\n")[0].slice(0, 180);
        }
        const metrics = await page
          .evaluate(() => {
            const state = window.__coveLab;
            const navigation = performance.getEntriesByType("navigation")[0];
            const resources = performance.getEntriesByType("resource");
            return {
              ttfbMs: navigation?.responseStart ?? null,
              fcpMs: performance.getEntriesByName("first-contentful-paint")[0]?.startTime ?? null,
              lcpMs: state?.lcp ?? null,
              lcpElement: state?.lcpElement ?? null,
              cls: state?.observed.includes("layout-shift") ? state.cls : null,
              shifts: state?.shifts ?? [],
              apiTimings: resources
                .filter((r) => new URL(r.name).pathname.startsWith("/api/"))
                .map((r) => ({
                  path: new URL(r.name).pathname,
                  startMs: r.startTime,
                  durationMs: r.duration,
                  responseStartMs: r.responseStart,
                })),
              longTaskCount: state?.observed.includes("longtask") ? state.tasks.length : null,
              longTaskTotalMs: state?.observed.includes("longtask")
                ? state.tasks.reduce((a, b) => a + b, 0)
                : null,
              eventTimingMaxMs: state?.events.length ? Math.max(...state.events) : null,
              observedResourceBytes: resources.reduce(
                (a, r) => a + r.transferSize,
                navigation?.transferSize || 0,
              ),
              observedJsBytes: resources
                .filter((r) => /\.m?js(?:\?|$)/.test(r.name))
                .reduce((a, r) => a + r.encodedBodySize, 0),
              readerReadyMs:
                performance.getEntriesByName("cove-reader-ready")[0]?.startTime ?? null,
              visibleBookCards: document.querySelectorAll(".book-card").length,
            };
          })
          .catch(() => ({}));
        const afterCpu = Object.fromEntries(
          (await cdp.send("Performance.getMetrics")).metrics.map((m) => [m.name, m.value]),
        );
        if (captureCpu) {
          const { profile: cpuProfile } = await cdp.send("Profiler.stop");
          await fs.writeFile(
            path.join(output, `${profile}-homepage.cpuprofile`),
            JSON.stringify(cpuProfile),
          );
        }
        const row = {
          profile,
          route,
          phase,
          status,
          failure,
          ...metrics,
          interactionNextPaintMs,
          mainThread: Object.fromEntries(
            ["ScriptDuration", "LayoutDuration", "RecalcStyleDuration", "TaskDuration"].map(
              (key) => [key + "Ms", Math.round(1000 * afterCpu[key])],
            ),
          ),
          observedMs: Date.now() - started,
          pageErrors: errors,
          requests: requests.length,
          apiRequests: requests.filter((r) => r.path.startsWith("/api/")).length,
          offlineAssetRequests: requests.filter((r) => r.path.startsWith("/offline-assets/"))
            .length,
          requestPaths: [...new Set(requests.map((r) => r.path))].sort(),
        };
        results.push(row);
        console.log("COVE_LAB_SAMPLE " + JSON.stringify(row));
        if (failure)
          await page
            .screenshot({ path: path.join(output, `${profile}-${results.length}.png`) })
            .catch(() => {});
      }
      await context.close();
    }
  }
} finally {
  await browser.close();
}
const report = {
  instrumentationVersion: 2,
  at: new Date().toISOString(),
  origin,
  boundary:
    "Synthetic Chromium observations, not real-user p75 or field INP. Fresh contexts have empty browser storage, not guaranteed cold server caches. Mobile uses 4x CPU slowdown and 150ms/1.6Mbps network emulation; worker traffic may not inherit page-CDP throttling. Resource timing excludes opaque cross-origin and worker bytes. Interaction next-paint includes automation overhead. Private routes here measure guest shells only.",
  targets: { fieldLcpP75Ms: 2500, fieldInpP75Ms: 200, fieldClsP75: 0.1 },
  profiles: ["desktop", "mobile-4g"].map((profile) => {
    const rows = results.filter((r) => r.profile === profile);
    return {
      profile,
      labLcpP75Ms: percentile(rows.map((r) => r.lcpMs).filter(Number.isFinite), 0.75),
      failures: rows.filter((r) => r.failure).length,
    };
  }),
  results,
};
await fs.writeFile(path.join(output, "browser-baseline.json"), JSON.stringify(report, null, 2));
console.log(
  "COVE_LAB_SUMMARY " +
    JSON.stringify({
      profiles: report.profiles,
      failures: results.filter((r) => r.failure).length,
    }),
);
if (results.some((r) => r.failure || r.pageErrors.length)) process.exitCode = 1;
