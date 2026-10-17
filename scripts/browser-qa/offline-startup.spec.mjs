import { test, expect } from "@playwright/test";
test("saved EPUB survives closing the app and cold offline navigation without private HTML caches", async ({
  browser,
  request,
}, testInfo) => {
  test.setTimeout(120000);
  const seed = await request.post("/__qa/seed?progress=1");
  expect(seed.ok()).toBe(true);
  const context = await browser.newContext({
    ...testInfo.project.use,
    baseURL: "http://127.0.0.1:4173",
    serviceWorkers: "allow",
  });
  let page = await context.newPage();
  context.on("page", (opened) => {
    opened.on("pageerror", (error) => console.error("Offline page error:", error.message));
    opened.on("console", (message) => {
      if (message.type() === "error") console.error("Offline console:", message.text());
    });
  });
  try {
    await page.goto("/read/1342");
    await expect(page.locator('html[data-cove-client-ready="true"]')).toHaveCount(1);
    await expect(page.locator("iframe").first()).toBeAttached({ timeout: 45000 });
    await page.evaluate(async () => {
      const epub = await import("/src/features/fore/epub.ts");
      await epub.saveEpubOffline(await epub.loadBookMetadata("1342"));
    });
    const documents = await page.evaluate(async () => {
      const urls = [];
      for (const key of await caches.keys())
        for (const request of await (await caches.open(key)).keys())
          if (
            !new URL(request.url).pathname.startsWith("/offline-assets/") &&
            !new URL(request.url).pathname.startsWith("/assets/")
          )
            urls.push(new URL(request.url).pathname);
      return urls;
    });
    expect(documents).toEqual(["/offline.html"]);
    await page.close();
    expect((await request.post("/__qa/network?offline=1")).ok()).toBe(true);
    await context.setOffline(true);
    page = await context.newPage();
    await page.goto("/read/1342");
    await expect(page.locator("#cove-offline-root")).toHaveCount(1);
    const frame = page.locator("iframe").first();
    await expect(frame).toBeAttached({ timeout: 45000 });
    await expect.poll(async () => frame.contentFrame().locator("body").innerText()).toContain("QA");
    await page.screenshot({ path: testInfo.outputPath("cold-offline-reader.png") });
    await page.close();
    page = await context.newPage();
    await page.goto("/");
    await expect(page.locator("#cove-offline-root")).toHaveCount(1);
    await expect(page.getByRole("heading", { name: /Take the stories with you/ })).toBeVisible();
    expect((await request.post("/__qa/network?offline=0")).ok()).toBe(true);
    await context.setOffline(false);
    await page.goto("/");
    await expect(page.locator('html[data-cove-client-ready="true"]')).toHaveCount(1);
    await expect(page.locator(".book-grid:not(.merch-grid) .book-card").first()).toBeVisible();
  } finally {
    await request.post("/__qa/network?offline=0");
    await context.close();
  }
});

test("public first chapter does not wait for stalled account or optional audio", async ({
  page,
  request,
}) => {
  await request.post("/__qa/seed?progress=1");
  await page.route("**/api/fore/account", () => new Promise(() => {}));
  await page.route("**/api/fore/audiobooks?bookId=**", () => new Promise(() => {}));
  await page.goto("/read/1342");
  await expect(page.locator("iframe").first()).toBeAttached({ timeout: 15000 });
  await expect
    .poll(() => page.locator("iframe").first().contentFrame().locator("body").innerText())
    .toContain("Browser QA passage");
});
