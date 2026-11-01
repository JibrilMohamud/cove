import { test, expect } from "@playwright/test";

test.use({ serviceWorkers: "block" });

test("new reader has zero-valued stats but no empty book or shelf panels", async ({ page }) => {
  await page.route("**/api/fore/social/profile/**", (route) =>
    route.fulfill({
      json: {
        profile: { id: "qa-new-reader", name: "Fresh Reader", username: "fresh-reader", bio: "" },
        counts: { followers: 0, following: 0, finished: 0 },
        relationship: { following: false, muted: false },
        topBooks: [],
        lists: [],
        journeys: [],
        currentlyReading: null,
      },
    }),
  );
  await page.goto("/community?profile=fresh-reader");
  await expect(page.getByRole("heading", { name: "Fresh Reader" })).toBeVisible();
  await expect(page.locator(".cove-reader-stats strong")).toHaveCount(5);
  await expect(page.locator(".cove-reader-stats strong")).toHaveText(["0", "0", "0", "0", "0"]);
  await expect(page.locator(".cove-reader-three")).toHaveCount(0);
  await expect(page.locator(".cove-reader-shelves")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "A story still being written." })).toBeVisible();
  await expect(page.locator(".cove-reader-discussion")).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
    true,
  );
});

test("populated reader shows covers, ratings, reviews and a book-native profile navigation", async ({
  page,
}) => {
  await page.route("**/api/fore/social/profile/**", (route) =>
    route.fulfill({
      json: {
        profile: {
          id: "qa-busy-reader",
          name: "Lively Reader",
          username: "lively-reader",
          bio: "A home for the stories I love.",
        },
        counts: { followers: 12, following: 3, finished: 2 },
        relationship: { following: false, muted: false },
        topBooks: [
          {
            position: 1,
            book: {
              productId: "1342",
              sourceExternalId: "1342",
              title: "Pride and Prejudice",
              authors: "Jane Austen",
            },
          },
        ],
        lists: [
          {
            id: "shelf_public",
            title: "Books that stayed with me",
            description: "Favorites",
            item_count: 1,
          },
        ],
        journeys: [
          {
            id: "journey_public",
            title_snapshot: "Pride and Prejudice",
            finished_at: "2026-06-01T10:00:00Z",
            visibility: "public",
          },
        ],
        currentlyReading: null,
      },
    }),
  );
  await page.route("**/api/fore/social/journeys/journey_public", (route) =>
    route.fulfill({
      json: {
        id: "journey_public",
        book: { productId: "1342" },
        cover_url: "/covers/1342.jpg",
        author_snapshot: "Jane Austen",
        review_excerpt: "A wonderfully sharp comedy of manners.",
        rating_steps: 9,
        finished_at: "2026-06-01T10:00:00Z",
      },
    }),
  );
  await page.goto("/community?profile=lively-reader");
  await expect(page.getByRole("heading", { name: "Lively Reader" })).toBeVisible();
  await expect(page.locator(".cove-reader-three .cove-reader-cover")).toHaveCount(1);
  await expect(page.locator(".cove-reader-shelves")).toHaveCount(1);
  await expect(page.getByText("A wonderfully sharp comedy of manners.")).toBeVisible();
  await expect(page.getByRole("link", { name: "Want to Read" })).toBeVisible();
  await page.getByRole("link", { name: "Reviews", exact: true }).click();
  await expect(page).toHaveURL(/profileTab=Reviews/);
  await expect(page.getByText("A wonderfully sharp comedy of manners.")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
    true,
  );
});
