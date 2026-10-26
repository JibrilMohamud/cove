import { test, expect } from "@playwright/test";

test.use({ serviceWorkers: "block" });

test("Cove Sounds atmosphere is instantly available and loads discovery on intent", async ({
  page,
  request,
}) => {
  const errors = [];
  const reads = { recordings: 0, catalog: 0, shelves: 0 };
  const funnelEvents = [];
  const musicPaths = new Set([
    "/api/fore/sounds/stations/gothic-hour/recordings",
    "/api/fore/soundtracks/recordings",
  ]);
  const catalogPaths = new Set([
    "/api/fore/sounds/stations/gothic-hour/books",
    "/api/fore/catalog",
  ]);
  await page.route("**/api/fore/sounds/events", async (route) => {
    const payload = route.request().postDataJSON();
    funnelEvents.push(payload);
    expect(Object.keys(payload).sort()).toEqual(["event", "station"]);
    expect(payload.station).toBe("gothic-hour");
    expect(["station_view", "music_open", "shelf_open"]).toContain(payload.event);
    await route.fulfill({ status: 202, json: { accepted: true } });
  });
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (req) => {
    const path = new URL(req.url()).pathname;
    // Count the independent snapshot or guarded 404 fallback after intent.
    if (musicPaths.has(path)) reads.recordings++;
    if (catalogPaths.has(path)) reads.catalog++;
    if (path.includes("/api/fore/social/sounds/stations/")) reads.shelves++;
  });
  const html = await request.get("/sounds/gothic-hour");
  expect(html.ok()).toBeTruthy();
  expect(await html.text()).toContain("The Gothic Hour");

  await page.goto("/sounds/gothic-hour");
  await expect(page.locator('html[data-cove-client-ready="true"]')).toHaveCount(1);
  await expect(page.getByRole("heading", { name: "The Gothic Hour" })).toBeVisible();
  await expect.poll(() => funnelEvents.some((item) => item.event === "station_view")).toBe(true);
  await expect(page.getByRole("link", { name: "Share on X" })).toHaveAttribute(
    "href",
    /cove-jibrilmohamuds-projects.vercel.app/,
  );
  await expect(page.getByRole("link", { name: /Frankenstein/ })).toBeVisible();
  await page.waitForTimeout(400);
  expect(reads).toEqual({ recordings: 0, catalog: 0, shelves: 0 });

  await page.getByRole("button", { name: "Explore rights-reviewed music" }).click();
  await expect.poll(() => reads.recordings).toBeGreaterThan(0);
  expect(reads.recordings).toBeLessThanOrEqual(2);
  await expect.poll(() => funnelEvents.some((item) => item.event === "music_open")).toBe(true);
  expect(reads.catalog).toBe(0);
  expect(reads.shelves).toBe(0);

  await page.getByRole("button", { name: "Check book editions available in my region" }).click();
  await expect.poll(() => reads.catalog).toBeGreaterThan(0);
  expect(reads.shelves).toBe(0);

  const shelvesRequest = page.waitForRequest(
    (req) => new URL(req.url()).pathname === "/api/fore/social/sounds/stations/gothic-hour/shelves",
  );
  await page.getByRole("button", { name: "Explore reader-created shelves" }).click();
  const requestFromPage = await shelvesRequest;
  expect(new URL(requestFromPage.url()).search).toBe("");
  await expect.poll(() => reads.shelves).toBe(1);
  const shelves = await request.get("/api/fore/social/sounds/stations/gothic-hour/shelves");
  expect(shelves.ok()).toBeTruthy();
  const body = await shelves.json();
  expect(body.station).toBe("gothic-hour");
  expect(Array.isArray(body.shelves)).toBe(true);
  expect(body.shelves.length).toBeLessThanOrEqual(8);
  expect(body.nextCursor === null || typeof body.nextCursor === "string").toBe(true);
  const invalid = await request.get(
    "/api/fore/social/sounds/stations/gothic-hour/shelves?after=DROP%20TABLE",
  );
  expect(invalid.status()).toBe(400);
  expect(errors).toEqual([]);
});
