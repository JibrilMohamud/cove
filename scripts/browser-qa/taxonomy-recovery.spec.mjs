import { test, expect } from "@playwright/test";

test("pending category counts stop polling and recover through an explicit retry", async ({
  page,
}) => {
  await page.clock.install();
  let calls = 0;
  let recovered = false;
  let payload;
  await page.route("**/api/fore/taxonomy*", async (route) => {
    calls++;
    if (!payload) payload = await (await route.fetch()).json();
    await route.fulfill({ json: { ...payload, countsPending: !recovered } });
  });
  await page.goto("/");
  await expect(page.locator('html[data-cove-client-ready="true"]')).toHaveCount(1);
  await expect.poll(() => calls).toBe(1);
  await page.locator(".taxonomy-browser summary").click();
  await expect(page.getByRole("button", { name: "Refresh counts" })).toBeVisible();
  await expect(page.locator(".book-card").first()).toBeVisible();
  for (let i = 0; i < 7; i++) {
    await page.clock.fastForward(61_000);
    // Flush the intercepted response and React Query's timer update.
    await expect(page.getByRole("button", { name: "Refresh counts" })).toBeEnabled();
  }
  expect(calls).toBe(6);
  await page.clock.fastForward(600_000);
  expect(calls).toBe(6);
  recovered = true;
  await page.getByRole("button", { name: "Refresh counts" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: "Refresh counts" })).toHaveCount(0);
  expect(calls).toBe(7);
  await page.clock.fastForward(600_000);
  expect(calls).toBe(7);
  await expect(page.locator(".book-card").first()).toBeVisible();
});
