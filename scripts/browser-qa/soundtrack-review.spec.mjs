import { test, expect } from "@playwright/test";

// This suite mocks the rights API. A registered worker can otherwise bypass
// Playwright routes on the second navigation, especially in WebKit. The offline
// sharing suites cover the real worker separately.
test.use({ serviceWorkers: "block" });

test("soundtrack credits, opt-in playback, and versioned staff review submissions", async ({
  page,
}) => {
  const record = {
    id: "cm_101",
    title: "Example reviewed piano recording",
    status: "pending_review",
    source_page_url: "https://commons.wikimedia.org/wiki/File:Example.ogg",
    source_sha1: "a".repeat(40),
    composer: "Example composer",
    performer: "Example pianist",
    period: "romantic",
    license_statement: "CC BY 4.0",
    license_url: "https://creativecommons.org/licenses/by/4.0/",
    dossier_json: "{}",
    quality_status: "pending",
    quality_report_json: "{}",
    review_version: 0,
    instruments_json: '["piano"]',
    moods_json: '["reflective"]',
    has_vocals: 0,
    energy: 0.25,
    last_import_error: "",
  };
  await page.route("**/api/fore/soundtracks/recordings", (route) =>
    route.fulfill({
      json: {
        count: 1,
        recordings: [
          {
            id: record.id,
            title: record.title,
            composer: record.composer,
            performer: record.performer,
            period: record.period,
            instruments: ["piano"],
            moods: ["reflective"],
            energy: 0.25,
            hasVocals: false,
            attribution: "Example pianist — Example reviewed piano recording. CC BY 4.0.",
            sourcePage: record.source_page_url,
            license: record.license_statement,
            licenseUrl: record.license_url,
            modifications: "Original source file; no modifications by Cove.",
            audioUrl: "/api/fore/soundtracks/recordings/cm_101/audio",
          },
        ],
      },
    }),
  );
  await page.goto("/soundtracks");
  await expect(page.getByRole("heading", { name: record.title })).toBeVisible();
  const player = page.locator("audio");
  await expect(player).toHaveAttribute("preload", "none");
  expect(await player.evaluate((audio) => audio.paused)).toBe(true);
  expect(await player.getAttribute("autoplay")).toBeNull();
  await page.getByText("Recording rights and attribution", { exact: true }).click();
  await expect(
    page.getByText("Original source file; no modifications by Cove.", { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: "CC BY 4.0", exact: true })).toHaveAttribute(
    "href",
    record.license_url,
  );
  await expect(page.getByRole("link", { name: "Download original recording" })).toHaveAttribute(
    "download",
    "",
  );
  await page.getByRole("searchbox", { name: "Search the music library" }).fill("nonexistent");
  await expect(page.getByRole("heading", { name: record.title })).toHaveCount(0);

  let submitted;
  await page.route("**/api/fore/admin/soundtracks?**", (route) =>
    route.fulfill({
      json: {
        records: [record],
        counts: [{ status: "pending_review", quality_status: "pending", count: 1 }],
        nextCursor: null,
      },
    }),
  );
  await page.route("**/api/fore/admin/soundtracks/recordings/cm_101", async (route) => {
    if (route.request().method() === "POST") {
      submitted = route.request().postDataJSON();
      return route.fulfill({
        status: 409,
        json: { error: "The review changed. Refresh before submitting this decision." },
      });
    }
    return route.fulfill({ json: { record, history: [] } });
  });
  await page.goto("/staff/soundtracks");
  await page.getByRole("button", { name: record.title, exact: true }).click();
  await expect(page.getByRole("group", { name: "composition", exact: true })).toBeVisible();
  await expect(page.getByRole("group", { name: "master", exact: true })).toBeVisible();
  await page
    .getByLabel("Decision rationale", { exact: true })
    .fill("Evidence is unresolved: request a second review of the actual recording master.");
  await page.getByRole("button", { name: "Reject", exact: true }).click();
  await expect.poll(() => submitted?.action).toBe("reject");
  expect(submitted.version).toBe(0);
  await expect(
    page.getByText("The review changed. Refresh before submitting this decision.", { exact: true }),
  ).toBeVisible();
});
