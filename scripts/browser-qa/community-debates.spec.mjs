import { test, expect } from "@playwright/test";

// Regression: real Supabase identities include a colon. Previously the route
// guard rejected these valid IDs, returning to the overview on every click.
test.use({ serviceWorkers: "block" });

test("Arena owner deep link opens the original discussion and real reply composer", async ({
  page,
}) => {
  await page.goto(
    "/community?arenaPost=post_f7ef8023-5b9f-4d19-b86a-9d4de9ef80e6&arenaOwner=sb%3A9f4af27d-00f1-40e7-b591-b7b4cdba4269",
  );
  await expect(page.getByRole("heading", { name: "Community conversation" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Write a reply" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Reply", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: /Back to the Reading Room/ })).toBeVisible();
});

test("View debates navigates to full-page search and discovery filters", async ({ page }) => {
  await page.goto("/community");
  await expect(page.getByRole("link", { name: /View debates/ })).toBeVisible();
  await page.getByRole("link", { name: /View debates/ }).click();
  await expect(page).toHaveURL(/\/community\?tab=debates/);
  await expect(page.locator(".cove-arena-head h1")).toContainText("Real conversations.");
  const search = page.getByRole("searchbox", { name: /Search recent public debates and comments/ });
  await expect(search).toBeVisible();
  await search.fill("favorite book");
  await expect(search).toHaveValue("favorite book");
  // On iPhone Safari the software keyboard can consume the first outside tap
  // merely to dismiss editing. Finish search editing before asserting a
  // separate discovery-filter tap; do not suppress any failed filter action.
  await search.evaluate((input) => input.blur());
  await expect(page.locator('html[data-cove-client-ready="true"]')).toHaveCount(1);
  const touchProject = ["iphone-safari", "ipad-safari", "android-chrome"].includes(
    test.info().project.name,
  );
  const top = page.getByRole("button", { name: "Top", exact: true });
  const following = page.getByRole("button", { name: "Following", exact: true });
  await expect(top).toBeEnabled();
  // Device QA should exercise the actual touch event sequence, rather than a
  // synthetic mouse click while Safari has just dismissed a search keyboard.
  // Keep the same required React state assertions: no swallowed interactions.
  if (touchProject) await top.tap();
  else await top.click();
  await expect(top).toHaveAttribute("aria-pressed", "true");
  if (touchProject) await following.tap();
  else await following.click();
  await expect(following).toHaveAttribute("aria-pressed", "true");
});
