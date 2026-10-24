import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import fs from "node:fs";

// HTTP response fixtures must remain visible to routing after a document navigation.
// The separate sharing suite exercises the real service worker and offline store.
test.use({ serviceWorkers: "block" });

const locales = ["en-US", "es-ES", "fr-FR", "de-DE", "ar-SA"];
for (const locale of locales) {
  test(`community and collection accessible labels follow ${locale}`, async ({ page, context }) => {
    const messages = JSON.parse(
      fs.readFileSync(`src/features/fore/locales/${locale}.json`, "utf8"),
    );
    // The locale provider receives its normal server contract; catalog/account
    // requests still hit the isolated real backend. No production account data.
    await context.route("**/api/fore/storefront/context", async (route) => {
      const response = await route.fetch();
      const data = await response.json();
      await route.fulfill({
        response,
        json: {
          ...data,
          locale,
          uiMessages: messages,
          language: locale.slice(0, 2),
          direction: locale === "ar-SA" ? "rtl" : "ltr",
        },
      });
    });
    // WebKit intermittently rejects loopback requests while changing localized
    // views ("due to access control checks"), although the same-origin QA server
    // answers successfully. Proxy only these read-only QA requests through
    // Playwright's transport, preserving actual backend status, JSON and headers.
    // Sharing/browser suites still exercise unproxied app networking.
    const proxiedFailures = [];
    await context.route(/\/api\/fore\/(?:account|social\/discover)(?:\?|$)/, async (route) => {
      // Use the BrowserContext's independent request transport. WebKit can
      // cancel route.fetch() when a navigation disposes the requesting frame.
      // The context transport still sends shared cookies and exposes actual
      // response status, so backend failures are not mocked or hidden.
      const response = await context.request.fetch(route.request());
      if (response.status() >= 500) proxiedFailures.push(response.status());
      await route.fulfill({ response });
    });
    const failures = [];
    page.on("pageerror", (e) => failures.push(e.message));
    await page.goto("/community");
    await expect(page.locator('html[data-cove-client-ready="true"]')).toHaveCount(1);
    // Finish the initial read-only API requests before changing routes: iPad
    // WebKit otherwise rejects an outgoing fetch during document teardown.
    await page.waitForLoadState("networkidle");
    await expect(page.locator("html")).toHaveAttribute("lang", locale);
    await expect(page.locator("html")).toHaveAttribute("dir", locale === "ar-SA" ? "rtl" : "ltr");
    await expect(page.locator("aside.sidebar nav.main-nav")).toHaveAttribute(
      "aria-label",
      messages["Primary"],
    );
    await expect(page.locator(".cove-site-footer")).toHaveAttribute(
      "aria-label",
      messages["Cove legal and account links"],
    );
    await expect(page.locator(".cove-site-footer nav")).toHaveAttribute(
      "aria-label",
      messages["Footer"],
    );
    await expect(page.locator('.cove-site-footer a[href="/help"]')).toHaveText(
      messages["Help & support"],
    );
    await expect(page.locator('.cove-site-footer a[href="/privacy#contact-us"]')).toHaveText(
      messages["Contact & privacy requests"],
    );
    await expect(
      page.getByRole("heading", { name: messages["Read together without leaving the book."] }),
    ).toBeVisible();
    const sections = page.getByRole("navigation", { name: messages["Community sections"] });
    await expect(sections.getByRole("link", { name: messages["My sharing"] })).toBeVisible();
    await sections.getByRole("link", { name: messages["My sharing"] }).focus();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/community\?tab=sharing/);
    await expect(page.locator('html[data-cove-client-ready="true"]')).toHaveCount(1);
    await page.waitForLoadState("networkidle");
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
    // Navigating away from Community mid-request can surface a synthetic
    // "access control checks" exception in mobile WebKit as the document is
    // discarded. Keep the real network/error assertions, but exercise Library
    // in its own document so navigation cannot abort Community requests.
    const libraryPage = await context.newPage();
    libraryPage.on("pageerror", (e) => failures.push(e.message));
    await libraryPage.goto("/library");
    await expect(libraryPage.locator('html[data-cove-client-ready="true"]')).toHaveCount(1);
    await expect(libraryPage.locator("html")).toHaveAttribute("lang", locale);
    await expect(
      libraryPage.getByText(
        messages[
          "Sign in to build your library and keep your favorite passages, notes, and new words together."
        ],
        { exact: true },
      ),
    ).toBeVisible();
    expect(failures).toEqual([]);
    expect(proxiedFailures).toEqual([]);
    await libraryPage.close();
  });
}
