import { test, expect } from "@playwright/test";

test.use({ serviceWorkers: "block" });

test("reader music is opt-in, attributed, and chapter-aware", async ({ page, request }) => {
  const seeded = await request.post("/__qa/seed?progress=1");
  expect(seeded.ok()).toBeTruthy();
  const requested = [];
  await page.route("**/api/fore/books/*/literary-profile/playlist?**", (route) => {
    const url = new URL(route.request().url());
    requested.push(Object.fromEntries(url.searchParams));
    return route.fulfill({
      json: {
        productId: "prd_gutenberg_1342",
        provisional: false,
        scope: { requested: "chapter", effective: "chapter", duration: "chapter" },
        playlist: {
          completion: "estimated_session_covered",
          tracks: [
            {
              id: "cm_101",
              reasons: ["measured intensity fits reading target"],
              recording: {
                id: "cm_101",
                title: "A mock rights-cleared reading piece",
                composer: "Fixture composer",
                performer: "Fixture performer",
                attribution: "Fixture performer, fixture source; CC BY 4.0",
                license: "CC BY 4.0",
                licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
                sourcePage: "https://commons.wikimedia.org/wiki/File:Fixture.ogg",
                audioUrl: "/api/fore/soundtracks/recordings/cm_101/audio",
                durationSeconds: 120,
                fingerprint: "pinned-master",
              },
            },
          ],
        },
      },
    });
  });
  await page.goto("/read/1342");
  // The server-rendered reader chrome exists before React attaches click handlers.
  // Do not click until client hydration completes on mobile WebKit/Firefox.
  await expect(page.locator('html[data-cove-client-ready="true"]')).toHaveCount(1);
  const launcher = page.locator('button[aria-label="Reading soundtrack"]');
  await expect(launcher).toBeAttached({ timeout: 45000 });
  // The reader intentionally auto-hides chrome while reading; it must be
  // hydrated before a programmatic click can exercise the user handler.
  await launcher.evaluate((button) => button.click());
  const pane = page.getByRole("region", { name: "Reading soundtrack" });
  await expect(pane).toBeVisible();
  await expect(pane.getByText("A mock rights-cleared reading piece")).toBeVisible();
  const player = pane.locator("audio");
  await expect(player).toHaveAttribute("preload", "none");
  expect(await player.evaluate((node) => node.paused)).toBe(true);
  expect(await player.getAttribute("autoplay")).toBeNull();
  await pane.getByText("Recording attribution and license", { exact: true }).click();
  await expect(pane.getByRole("link", { name: "CC BY 4.0" })).toHaveAttribute(
    "href",
    "https://creativecommons.org/licenses/by/4.0/",
  );
  await pane.getByLabel("Listening style").selectOption("focus");
  await expect.poll(() => requested.some((q) => q.mode === "focus")).toBeTruthy();
  await pane.getByRole("button", { name: "Minimize soundtrack" }).click();
  await expect(pane).toBeHidden();
  expect(await page.locator(".reader-soundtrack audio").count()).toBe(1);
});
