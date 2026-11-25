import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

test("literary discovery submits session intent, reports evidence gaps and has labelled keyboard controls", async ({
  page,
}) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await expect(page.locator('html[data-cove-client-ready="true"]')).toHaveCount(1);
  const section = page.getByRole("region", { name: "What would you love to read next?" });
  await expect(section).toBeVisible();
  await section.getByLabel("For this search").fill("unseen-evidence-tag, under 2 hours");
  await section.getByLabel("More of (comma-separated)").fill("friendship");
  await section.getByLabel("Avoid known themes or styles").fill("war");
  await section.getByLabel("Maximum reading time in minutes").fill("120");
  await expect(section.getByLabel("For this search")).toHaveValue(
    "unseen-evidence-tag, under 2 hours",
  );
  await expect(section.getByLabel("More of (comma-separated)")).toHaveValue("friendship");
  await expect(section.getByLabel("Avoid known themes or styles")).toHaveValue("war");
  await expect(section.getByLabel("Maximum reading time in minutes")).toHaveValue("120");
  const submit = section.getByRole("button", { name: "Discover books", exact: true });
  await expect(submit).toBeEnabled();
  // Exercise the actual keyboard submission instead of a pointer coordinate
  // that can move when deferred storefront rails settle above the panel.
  await submit.focus();
  await expect(submit).toBeFocused();
  const [request] = await Promise.all([
    page.waitForRequest(
      (r) => r.url().includes("/recommendations/discover") && r.method() === "POST",
      { timeout: 15_000 },
    ),
    submit.press("Enter"),
  ]);
  expect(request.postDataJSON()).toMatchObject({
    query: "unseen-evidence-tag, under 2 hours",
    controls: { likes: ["friendship"], dislikes: ["war"], maxMinutes: 120 },
  });
  await expect(section.getByRole("status")).toContainText("No eligible books");
  const accessibility = await new AxeBuilder({ page })
    .include('[aria-labelledby="literary-discovery-title"]')
    .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
    .analyze();
  expect(accessibility.violations).toEqual([]);
  await section.getByRole("button", { name: "Clear preferences", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(section.getByLabel("For this search")).toHaveValue("");
  await expect(section.getByLabel("More of (comma-separated)")).toHaveValue("");
  expect(errors).toEqual([]);
});
