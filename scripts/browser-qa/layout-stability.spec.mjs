import { test, expect } from "@playwright/test";

// Previously the footer started inside the viewport while a short guest
// shell loaded, then jumped past the fold after book details hydrated.
test("short guest and book shells keep the footer below the initial viewport", async ({ page }) => {
  for (const pathname of ["/library", "/book/1342"]) {
    await page.goto(pathname, { waitUntil: "domcontentloaded" });

    const layout = async () =>
      page.locator("main#fore-main").evaluate((main) => {
        const footer = document.querySelector(".cove-site-footer");
        const header = document.querySelector(".topbar");
        if (!footer || !header) throw new Error("Site shell or legal footer missing.");
        return {
          footerTop: footer.getBoundingClientRect().top,
          viewportHeight: window.innerHeight,
          headerHeight: header.getBoundingClientRect().height,
          reservedMainHeight: Number.parseFloat(getComputedStyle(main).minHeight),
        };
      });

    const first = await layout();
    expect(first.reservedMainHeight).toBeGreaterThanOrEqual(
      first.viewportHeight - first.headerHeight - 2,
    );
    expect(first.footerTop).toBeGreaterThanOrEqual(first.viewportHeight - 2);

    await expect(page.locator('html[data-cove-client-ready="true"]')).toHaveCount(1);
    const hydrated = await layout();
    expect(hydrated.footerTop).toBeGreaterThanOrEqual(hydrated.viewportHeight - 2);
  }
});
