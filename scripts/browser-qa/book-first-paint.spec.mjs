import { test, expect } from "@playwright/test";

// Public book metadata is already fetched for SEO. It should produce
// meaningful, screen-reader-visible HTML before the second, account-scoped
// client query loads current rights/commerce detail.
test("book detail paints publicly authorized title in initial server HTML", async ({
  page,
}) => {
  const response = await page.goto("/book/1342", { waitUntil: "domcontentloaded" });
  expect(response?.status()).toBe(200);
  const html = await response.text();
  expect(html).toContain('class="book-ssr-preview-title"');
  const title = page.locator(".book-ssr-preview-title");
  // The UI may transition quickly to the fully loaded detail. In either
  // state the actual book heading must remain accessible and visible.
  if (await title.count()) {
    await expect(title).toBeVisible();
    await expect(title).not.toHaveText("");
  } else {
    await expect(page.locator(".detail-main h1")).toBeVisible();
  }
});
