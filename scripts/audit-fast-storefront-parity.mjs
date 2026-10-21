// Live-vs-candidate certification evidence. Do not treat synthetic guest tests
// as proof of authenticated production purchase or protected reading.
import fs from "node:fs";
import http from "node:http";
import { chromium } from "@playwright/test";

const root = "artifacts/fast-storefront-parity";
fs.mkdirSync(root, { recursive: true });
const fixture = fs.readFileSync("artifacts/strangler-fixture.html", "utf8");
const liveOrigin = "https://cove-puce-theta.vercel.app";
const server = http.createServer((req, res) => {
  const path = new URL(req.url || "/", "http://localhost").pathname;
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(path === "/" ? fixture : "<h1>Mock CORE delegation—not a real session</h1>");
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const stageOrigin = "http://127.0.0.1:" + server.address().port;
const browser = await chromium.launch({ headless: true });
const required = [
  ["theme", "html[data-theme]"],
  ["main-navigation", "nav[aria-label='Primary navigation']", "nav[aria-label='Main']"],
  ["mobile-menu", "button[aria-label='Open navigation']", "details.mobile-menu summary"],
  ["language", "select[aria-label='Storefront language']"],
  ["search", "input[aria-label^='Search books']", "#thin-search"],
  ["suggestion-ready-search", "input[autocomplete='off'][aria-label^='Search books']"],
  ["catalog", "article.book-card"],
  ["save-to-library", "button[aria-label^='Add '][aria-label$=' to library']"],
  ["advanced-facets", ".facet-toggle"],
  ["legal-links", "a[href='/privacy']"],
];
const results = {
  sha: process.env.GITHUB_SHA,
  environments: { live: liveOrigin, candidate: "local synthetic fixture" },
  profiles: [],
  guestRoutes: [],
  customerCheckoutCertified: false,
  customerReaderCertified: false,
  releaseMobileLcpCertified: false,
  certified: false,
};
try {
  for (const profile of [
    { id: "mobile", width: 390, height: 844, isMobile: true },
    { id: "desktop", width: 1440, height: 900, isMobile: false },
  ]) {
    const context = await browser.newContext({
      viewport: { width: profile.width, height: profile.height },
      isMobile: profile.isMobile,
      hasTouch: profile.isMobile,
      deviceScaleFactor: 1,
    });
    const live = await context.newPage();
    const stage = await context.newPage();
    const liveResponse = await live.goto(liveOrigin + "/", {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });
    await stage.goto(stageOrigin + "/", { waitUntil: "domcontentloaded", timeout: 30000 });
    await live.waitForTimeout(1200);
    await stage.waitForTimeout(300);
    const checks = [];
    for (const [name, selector, alternative] of required) {
      const baseline = await live.locator(selector).count();
      const candidate = await stage.locator(alternative || selector).count();
      checks.push({
        name,
        baseline,
        candidate,
        matched:
          baseline === 0 || candidate >= Math.min(baseline, name === "advanced-facets" ? 5 : 1),
      });
    }
    await live.screenshot({ path: root + "/" + profile.id + "-live.png", fullPage: false });
    await stage.screenshot({ path: root + "/" + profile.id + "-candidate.png", fullPage: false });
    const result = {
      profile: profile.id,
      status: liveResponse?.status(),
      viewport: [profile.width, profile.height],
      checks,
      parity: checks.every((x) => x.matched),
    };
    results.profiles.push(result);
    console.log("PARITY_PROFILE", JSON.stringify(result));
    await context.close();
  }
  const page = await browser.newPage();
  for (const path of [
    "/library",
    "/cart",
    "/orders",
    "/edition/edn_09230721dbb141128fe1a02dd04be2b4",
  ]) {
    const response = await page.goto(liveOrigin + path, {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });
    results.guestRoutes.push({ path, status: response?.status(), loaded: response?.ok() === true });
  }
  await page.close();
  results.gaps = results.profiles.flatMap((p) =>
    p.checks.filter((x) => !x.matched).map((x) => p.profile + ":" + x.name),
  );
  results.certified =
    results.gaps.length === 0 &&
    results.customerCheckoutCertified &&
    results.customerReaderCertified &&
    results.releaseMobileLcpCertified;
  console.log(
    "CERTIFICATION_RESULT",
    JSON.stringify({
      gaps: results.gaps,
      certified: results.certified,
      guestRoutes: results.guestRoutes,
    }),
  );
} finally {
  fs.writeFileSync(root + "/results.json", JSON.stringify(results, null, 2));
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
if (process.env.COVE_REQUIRE_CERTIFIED_PARITY === "1" && !results.certified) {
  throw Error(
    "Customer cutover blocked: complete visual, functional, customer journey and real release LCP certification missing",
  );
}
