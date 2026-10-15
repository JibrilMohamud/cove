import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import fs from "node:fs";

// HTTP response fixtures must remain visible to routing after a document navigation.
// The separate sharing suite exercises the real service worker and offline store.
test.use({ serviceWorkers: "block" });

const locales = ["en-US", "es-ES", "fr-FR", "de-DE", "ar-SA"];
for (const locale of locales) {
  test(`community and collection accessible labels follow ${locale}`, async ({ page }) => {
    const messages = JSON.parse(
      fs.readFileSync(`src/features/fore/locales/${locale}.json`, "utf8"),
    );
    // The locale provider receives its normal server contract; catalog/account
    // requests still hit the isolated real backend. No production account data.
    await page.route("**/api/fore/storefront/context", async (route) => {
      const response = await route.fetch();
      const data = await response.json();
      await route.fulfill({
        response,
        json: {
          ...data,
          locale,
          language: locale.slice(0, 2),
          direction: locale === "ar-SA" ? "rtl" : "ltr",
        },
      });
    });
    const failures = [];
    page.on("pageerror", (e) => failures.push(e.message));
    await page.goto("/community");
    await expect(page.locator('html[data-cove-client-ready="true"]')).toHaveCount(1);
    await expect(page.locator("html")).toHaveAttribute("lang", locale);
    await expect(page.locator("html")).toHaveAttribute("dir", locale === "ar-SA" ? "rtl" : "ltr");
    await expect(
      page.getByRole("heading", { name: messages["Read together without leaving the book."] }),
    ).toBeVisible();
    const sections = page.getByRole("navigation", { name: messages["Community sections"] });
    await expect(sections.getByRole("link", { name: messages["My sharing"] })).toBeVisible();
    await sections.getByRole("link", { name: messages["My sharing"] }).focus();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/community\?tab=sharing/);
    await expect(page.locator('html[data-cove-client-ready="true"]')).toHaveCount(1);
    await expect(
      page.getByText(messages["Sign in to see your private sharing."], { exact: true }),
    ).toBeVisible();
    const results = await new AxeBuilder({ page })
      .include(".community-page")
      .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
      .analyze();
    expect(
      results.violations.map((r) => ({ id: r.id, targets: r.nodes.map((n) => n.target) })),
    ).toEqual([]);
    await page.goto("/library");
    await expect(page.locator('html[data-cove-client-ready="true"]')).toHaveCount(1);
    await expect(page.locator("html")).toHaveAttribute("lang", locale);

    await expect(
      page.getByText(
        messages[
          "Sign in to build your library and keep your favorite passages, notes, and new words together."
        ],
        { exact: true },
      ),
    ).toBeVisible();
    expect(failures).toEqual([]);
  });
}
