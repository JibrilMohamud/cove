import { test, expect } from "@playwright/test";

test("filtered catalog navigation reuses cache and suppresses obsolete updater warnings", async ({
  browser,
}, testInfo) => {
  const { viewport, userAgent, deviceScaleFactor, isMobile, hasTouch } = testInfo.project.use;
  const isolated = process.env.COVE_QA_CHROMIUM_EXECUTABLE
    ? await browser.browserType().launch({ ...testInfo.project.use.launchOptions, headless: true })
    : browser;
  const context = await isolated.newContext({
    baseURL: "http://127.0.0.1:4173",
    viewport,
    userAgent,
    deviceScaleFactor,
    isMobile,
    hasTouch,
  });
  const page = await context.newPage();
  try {
    const errors = [],
      calls = { catalog: 0, context: 0, taxonomy: 0 };
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("request", (request) => {
      const path = new URL(request.url()).pathname;
      if (path === "/api/fore/catalog") calls.catalog++;
      if (path === "/api/fore/storefront/context") calls.context++;
      if (path === "/api/fore/taxonomy") calls.taxonomy++;
    });
    // Also exercise mixed deployment versions: ignore an old updater warning
    // only when usable books accompany it.
    await page.route("**/api/fore/catalog?**", async (route) => {
      const response = await route.fetch();
      const data = await response.json();
      await route.fulfill({
        response,
        json: {
          ...data,
          warning:
            "The catalog updater is retrying in the background; cached books remain available.",
          ingestion: { ...data.ingestion, status: "failed" },
        },
      });
    });
    await page.goto("/?sort=popular");
    await expect(page.locator('html[data-cove-client-ready="true"]')).toHaveCount(1);
    await expect(page.locator(".book-grid:not(.merch-grid) .book-card").first()).toBeVisible();
    await expect(
      page.getByText(
        "The catalog updater is retrying in the background; cached books remain available.",
        { exact: true },
      ),
    ).toHaveCount(0);
    await expect.poll(() => calls.context).toBeGreaterThan(0);
    await expect.poll(() => calls.taxonomy).toBeGreaterThan(0);
    const before = { ...calls };
    const sessionMarker = await page.evaluate(
      () => (window.__coveQaNavigation = crypto.randomUUID()),
    );
    await page.locator(".book-grid:not(.merch-grid) .book-card .cover-link").first().click();
    await expect(page).toHaveURL(/\/(edition|books|book)\//);
    await expect(page.getByRole("link", { name: "Back to bookstore" })).toBeVisible();
    await page.getByRole("link", { name: "Back to bookstore" }).click();
    await expect(page).toHaveURL(/\/$/);
    await expect(page.locator(".book-grid:not(.merch-grid) .book-card").first()).toBeVisible();
    expect(calls).toEqual(before);
    expect(await page.evaluate(() => window.__coveQaNavigation)).toBe(sessionMarker);
    expect(errors).toEqual([]);
    // Capture the visible storefront. A full catalog at mobile device scale can
    // exceed WebKit's 32767-pixel image limit even when every assertion passes.
    await page.screenshot({ path: testInfo.outputPath("warm-catalog.png") });
  } finally {
    await context.close();
    if (isolated !== browser) await isolated.close();
  }
});

test("initial bookstore serves books without JavaScript and refreshes full catalog safely", async ({
  browser,
  request,
}, testInfo) => {
  const response = await request.get("/");
  expect(response.ok()).toBe(true);
  const html = await response.text();
  expect(html).toContain('class="book-card"');
  expect(response.headers()["cache-control"]).toContain("no-store");
  expect(response.headers()["server-timing"]).toContain("cove_ssr_bootstrap;dur=");
  const noScript = await browser.newContext({
    javaScriptEnabled: false,
    baseURL: "http://127.0.0.1:4173",
  });
  try {
    const page = await noScript.newPage();
    await page.goto("/");
    await expect(page.locator(".book-grid:not(.merch-grid) .book-card").first()).toBeVisible();
    await expect(
      page.locator(".book-grid:not(.merch-grid) img[loading=eager]").first(),
    ).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("bookstore-without-javascript.png") });
  } finally {
    await noScript.close();
  }
  const context = await browser.newContext({
    baseURL: "http://127.0.0.1:4173",
    serviceWorkers: "block",
  });
  try {
    const page = await context.newPage();
    const calls = [];
    page.on("request", (request) => {
      if (
        /\/api\/fore\/(catalog|taxonomy|storefront\/(context|page))\b/.test(
          new URL(request.url()).pathname,
        )
      )
        calls.push(request.url());
    });
    // The shelf must survive failed follow-up requests. Exact catalog totals
    // and taxonomy deliberately load after hydration; context/page must not.
    await page.route("**/api/fore/catalog?**", (route) => route.abort());
    await page.route("**/api/fore/taxonomy", (route) => route.abort());
    await page.goto("/");
    await expect(page.locator('html[data-cove-client-ready="true"]')).toHaveCount(1);
    await expect(page.locator(".book-grid:not(.merch-grid) .book-card").first()).toBeVisible();
    await expect
      .poll(
        () =>
          calls.filter((requestUrl) => new URL(requestUrl).pathname === "/api/fore/catalog").length,
      )
      .toBeGreaterThanOrEqual(1);
    const paths = calls.map((requestUrl) => new URL(requestUrl).pathname);
    const catalogFetches = paths.filter((path) => path === "/api/fore/catalog").length;
    // Safari may repeat an explicitly aborted transport request while the
    // React query is mounting. Bound that recovery without requiring a
    // browser-specific network retry policy.
    expect(catalogFetches).toBeGreaterThanOrEqual(1);
    expect(catalogFetches).toBeLessThanOrEqual(2);
    const onlyDeferredRequests = paths.every((path) =>
      ["/api/fore/catalog", "/api/fore/taxonomy"].includes(path),
    );
    expect(onlyDeferredRequests).toBe(true);
    // The fresh server-rendered shelf remains readable even when the full
    // count/facet refresh cannot reach the backend.
    await expect(page.locator(".book-grid:not(.merch-grid) .book-card").first()).toBeVisible();
  } finally {
    await context.close();
  }
});

test("cold first Bookstore page shows verified books before slow facet search, even on full-search failure", async ({
  page,
  request,
}) => {
  test.setTimeout(45_000);
  expect((await request.post("/__qa/seed?progress=1")).ok()).toBe(true);
  let firstPageBootstrap = 0;
  let fullCatalogRequests = 0;
  let catalogAborted = false;
  await page.route("**/api/fore/storefront/bootstrap", (route) => {
    firstPageBootstrap++;
    return route.continue();
  });
  await page.route("**/api/fore/catalog?**", async (route) => {
    fullCatalogRequests++;
    // Simulate the observed cold 20-second COUNT/facet stall.
    await new Promise((resolve) => setTimeout(resolve, 6_000));
    await route.abort("failed");
    catalogAborted = true;
  });
  // Explicit sort keeps the default first page but disables SSR bootstrap.
  // This exercises the fast client-only recovery after an SSR deadline.
  await page.goto("/?sort=popular");
  const book = page.locator(".book-grid:not(.merch-grid) .book-card").first();
  await expect(book).toBeVisible({ timeout: 12_000 });
  expect(firstPageBootstrap).toBeGreaterThanOrEqual(1);
  await expect.poll(() => fullCatalogRequests, { timeout: 10_000 }).toBeGreaterThanOrEqual(1);
  await expect.poll(() => catalogAborted, { timeout: 15_000 }).toBe(true);
  // Never erase primary-authorized preview books because optional counts failed.
  await expect(book).toBeVisible();
  await expect(page.getByText("Books available to read")).toBeVisible();
});

test("anonymous homepage does not wait for a stalled first-page bootstrap", async ({
  page,
  request,
}) => {
  test.setTimeout(30_000);
  expect((await request.post("/__qa/seed?progress=1")).ok()).toBe(true);
  let bootstrapRequests = 0;
  let catalogRequests = 0;
  await page.route("**/api/fore/storefront/bootstrap", async (route) => {
    bootstrapRequests++;
    await new Promise((resolve) => setTimeout(resolve, 6_000));
    await route.abort("failed");
  });
  await page.route("**/api/fore/catalog?**", (route) => {
    catalogRequests++;
    return route.continue();
  });
  // Explicit query parameters prevent the server from supplying an SSR shelf.
  // The independently rights-checked catalog must not be held behind an
  // indefinitely pending first-paint bootstrap.
  await page.goto("/?sort=popular");
  await expect.poll(() => bootstrapRequests, { timeout: 4_000 }).toBeGreaterThanOrEqual(1);
  await expect.poll(() => catalogRequests, { timeout: 4_000 }).toBeGreaterThanOrEqual(1);
  await expect(page.locator(".book-grid:not(.merch-grid) .book-card").first()).toBeVisible({
    timeout: 5_000,
  });
});

test("tracking links retain verified SSR books while real catalog filters do not", async ({
  request,
}) => {
  expect((await request.post("/__qa/seed?progress=1")).ok()).toBe(true);
  const tracked = await request.get("/?utm_source=reading_club&gclid=tracking_test");
  expect(tracked.ok()).toBe(true);
  expect(await tracked.text()).toContain('class="book-card"');

  const shared = await request.get("/?__vercel_share=example-only");
  expect(shared.ok()).toBe(true);
  expect(await shared.text()).toContain('class="book-card"');

  const filtered = await request.get("/?search=nonexistent");
  expect(filtered.ok()).toBe(true);
  expect(await filtered.text()).not.toContain('class="book-card"');
});
