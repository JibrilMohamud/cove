import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

const quote = "Browser QA passage for sharing.";
const note = "A note for the selected member only.";
const discussion = "A group discussion visible to joined members.";
const baseURL = "http://127.0.0.1:4173";

async function setup(browser, request, testInfo, progress = 1) {
  const seeded = await request.post(`/__qa/seed?progress=${progress}`);
  expect(seeded.ok(), await seeded.text()).toBeTruthy();
  const fixture = await seeded.json();
  const contexts = [],
    isolatedBrowsers = [],
    errors = [];
  async function pageFor(who) {
    const { viewport, userAgent, deviceScaleFactor, isMobile, hasTouch } = testInfo.project.use;
    const isolated = process.env.COVE_QA_CHROMIUM_EXECUTABLE
      ? await browser
          .browserType()
          .launch({ ...testInfo.project.use.launchOptions, headless: true })
      : browser;
    if (isolated !== browser) isolatedBrowsers.push(isolated);
    const context = await isolated.newContext({
      baseURL,
      viewport,
      userAgent,
      deviceScaleFactor,
      isMobile,
      hasTouch,
      extraHTTPHeaders: who ? { "x-cove-qa-user": fixture.people[who].id } : {},
    });
    contexts.push(context);
    const page = await context.newPage();
    page.on("pageerror", (error) => errors.push(error.message));
    return page;
  }
  return {
    ...fixture,
    pageFor,
    async close() {
      await Promise.all(contexts.map((context) => context.close()));
      await Promise.all(isolatedBrowsers.map((browser) => browser.close()));
      expect(errors, "Uncaught application errors").toEqual([]);
    },
  };
}
async function inventory(page, sent = false) {
  await page.goto(`/community?tab=${sent ? "sharing" : "received"}`);
  await expect(page.locator(".sharing-inventory h2")).toHaveText(
    sent ? "My sharing" : "Shared with me",
  );
  await expect(page.getByText("Loading shares…")).toHaveCount(0);
}
function highlight(page) {
  return page
    .locator("article.margin-conversation-card")
    .filter({ has: page.getByRole("button", { name: "Unshare", exact: true }) });
}
async function noOverflow(page) {
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
    "Page fits device width",
  ).toBeTruthy();
}

test("guest navigation stays private and fits the device", async ({ page }, testInfo) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const documentResponse = await page.goto("/community?tab=received");
  expect(documentResponse?.headers()["content-security-policy"]).not.toContain(
    "upgrade-insecure-requests",
  );
  await expect(page.getByText("Sign in to see your private sharing.")).toBeVisible();
  for (const name of ["Activity", "Discover", "Shared with me", "My sharing", "My profile"])
    await expect(
      page.locator(".community-tabs").getByRole("link", { name, exact: true }),
    ).toBeVisible();
  // The SSR links are visible before Vite finishes hydrating in the QA server.
  // Wait for the actual client before navigating to avoid canceled dev imports.
  await expect(page.locator('html[data-cove-client-ready="true"]')).toHaveCount(1);
  await noOverflow(page);
  const sharingTab = page
    .locator(".community-tabs")
    .getByRole("link", { name: "My sharing", exact: true });
  const tabHref = await sharingTab.getAttribute("href");
  expect(tabHref).toContain("tab=sharing");
  await sharingTab.click();
  await expect(page).toHaveURL(/\/community\?tab=sharing$/);
  await expect(page.getByRole("heading", { name: "Manage your sharing" })).toBeVisible();
  await expect(page.getByText(note)).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("guest-community.png"), fullPage: true });
  const results = await new AxeBuilder({ page })
    .include(".community-page")
    .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
    .analyze();
  expect(results.violations.filter((v) => ["serious", "critical"].includes(v.impact))).toEqual([]);
  expect(errors).toEqual([]);
});

test("note consent updates the recipient's actual inbox", async ({
  browser,
  request,
}, testInfo) => {
  const fixture = await setup(browser, request, testInfo);
  try {
    const alice = await fixture.pageFor("alice"),
      bob = await fixture.pageFor("bob"),
      outsider = await fixture.pageFor("charlie");
    await inventory(alice, true);
    await inventory(bob);
    await expect(bob.getByText(note, { exact: true })).toBeVisible();
    await inventory(outsider);
    await expect(outsider.getByText(quote, { exact: true })).toHaveCount(0);
    const card = highlight(alice);
    await card.getByRole("button", { name: "Edit audience & note" }).click();
    await card.getByLabel("Include my note").uncheck();
    await card.getByRole("button", { name: "Save permissions" }).click();
    await expect(card.getByRole("button", { name: "Save permissions" })).toHaveCount(0);
    await inventory(bob);
    await expect(bob.getByText(quote, { exact: true }).first()).toBeVisible();
    await expect(bob.getByText(note, { exact: true })).toHaveCount(0);
    await noOverflow(alice);
    const results = await new AxeBuilder({ page: alice })
      .include(".sharing-inventory")
      .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
      .analyze();
    expect(results.violations.filter((v) => ["serious", "critical"].includes(v.impact))).toEqual(
      [],
    );
    await alice.screenshot({ path: testInfo.outputPath("sharing-dashboard.png"), fullPage: true });
  } finally {
    await fixture.close();
  }
});

test("member picker changes the audience and unshare revokes it", async ({
  browser,
  request,
}, testInfo) => {
  const fixture = await setup(browser, request, testInfo);
  try {
    const alice = await fixture.pageFor("alice"),
      bob = await fixture.pageFor("bob"),
      charlie = await fixture.pageFor("charlie");
    await inventory(alice, true);
    const card = highlight(alice);
    await card.getByRole("button", { name: "Edit audience & note" }).click();
    await card.getByLabel("Member username").fill(fixture.people.charlie.username);
    await expect(card.getByRole("button", { name: "Save permissions" })).toBeDisabled();
    await card.getByRole("button", { name: "Find member" }).click();
    await expect(card.getByRole("status")).toContainText(fixture.people.charlie.username);
    await card.getByRole("button", { name: "Save permissions" }).click();
    await expect(card.getByRole("button", { name: "Save permissions" })).toHaveCount(0);
    await inventory(bob);
    await expect(bob.getByText(note, { exact: true })).toHaveCount(0);
    await inventory(charlie);
    await expect(charlie.getByText(note, { exact: true })).toBeVisible();
    await card.getByRole("button", { name: "Unshare", exact: true }).click();
    await expect(alice.getByRole("button", { name: "Unshare", exact: true })).toHaveCount(0);
    await inventory(charlie);
    await expect(charlie.getByText(note, { exact: true })).toHaveCount(0);
    const persisted = await charlie.request.get("/api/fore/social/sharing?view=received");
    expect((await persisted.json()).items.some((item) => item.id === fixture.annotationId)).toBe(
      false,
    );
  } finally {
    await fixture.close();
  }
});

test("shared note edits require an explicit republish", async ({ browser, request }, testInfo) => {
  const fixture = await setup(browser, request, testInfo);
  const updatedNote = "Updated note awaiting publication.";
  try {
    const alice = await fixture.pageFor("alice"),
      bob = await fixture.pageFor("bob");
    await alice.goto("/highlights");
    let card = alice.locator("article.annotation-card").filter({ hasText: quote });
    await card.getByRole("button", { name: "Edit highlight note" }).click();
    const editor = alice.getByLabel("Note on this passage");
    await expect(editor).toHaveValue(note);
    await editor.fill(updatedNote);
    await expect(alice.getByRole("button", { name: "Save note" })).toBeEnabled();
    await alice.getByRole("button", { name: "Save note" }).click();
    const prompt = alice.getByRole("alertdialog");
    await expect(prompt).toBeVisible();
    await prompt.getByRole("button", { name: "Keep published copies unchanged" }).click();
    await inventory(bob);
    await expect(bob.getByText(note, { exact: true })).toBeVisible();

    await alice.goto("/highlights");
    card = alice.locator("article.annotation-card").filter({ hasText: quote });
    await card.getByRole("button", { name: "Edit highlight note" }).click();
    const republish = alice.getByRole("button", { name: "Review & republish note…" });
    await expect(republish).toBeVisible();
    await republish.click();
    await alice.getByRole("alertdialog").getByRole("button", { name: "Republish note" }).click();
    await inventory(bob);
    await expect(bob.getByText(updatedNote, { exact: true })).toBeVisible();
  } finally {
    await fixture.close();
  }
});

test("spoilers stay out of both the inbox DOM and its API response", async ({
  browser,
  request,
}, testInfo) => {
  const fixture = await setup(browser, request, testInfo, 0);
  try {
    const bob = await fixture.pageFor("bob");
    await inventory(bob);
    await expect(bob.getByText(/This passage is ahead of your reading progress/)).toBeVisible();
    await expect(bob.getByText(note, { exact: true })).toHaveCount(0);
    const response = await bob.request.get("/api/fore/social/sharing?view=received");
    const item = (await response.json()).items.find((item) => item.id === fixture.annotationId);
    expect(item.locked).toBe(true);
    expect(item.quote).toBeUndefined();
    expect(item.note).toBeUndefined();
    expect(item.cfi).toBeUndefined();
    const updated = await bob.request.post("/api/fore/library", {
      data: { bookId: "1342", progress: 1 },
    });
    expect(updated.ok(), await updated.text()).toBeTruthy();
    await inventory(bob);
    await expect(bob.getByText(note, { exact: true })).toBeVisible();
  } finally {
    await fixture.close();
  }
});

test("EPUB reader opens and joined members receive group margin discussions", async ({
  browser,
  request,
}, testInfo) => {
  const fixture = await setup(browser, request, testInfo);
  try {
    const bob = await fixture.pageFor("bob"),
      outsider = await fixture.pageFor("charlie");
    await inventory(bob);
    const groupCard = bob
      .locator("article.margin-conversation-card")
      .filter({ hasText: discussion });
    await expect(groupCard).toBeVisible();
    const openReader = groupCard.getByRole("link", { name: "Open in reader" });
    const href = await openReader.getAttribute("href");
    expect(href).toMatch(/^\/read\/[^/?]+/);
    const bookId = decodeURIComponent(href.split("/read/")[1].split("?")[0]);
    const epubResponse = await bob.request.get(
      `/api/fore/books/${encodeURIComponent(bookId)}/epub`,
    );
    expect(
      epubResponse.ok(),
      `Reader EPUB endpoint: ${epubResponse.status()} ${await epubResponse.text().catch(() => "")}`,
    ).toBeTruthy();
    const bytes = await epubResponse.body();
    expect(bytes.subarray(0, 2).toString(), "EPUB starts with ZIP magic bytes").toBe("PK");
    const noPreviousBiosync = await bob.request.get(
      `/api/fore/biosync/${encodeURIComponent(bookId)}`,
    );
    expect(noPreviousBiosync.ok()).toBeTruthy();
    expect(await noPreviousBiosync.json()).toBeNull();
    const anonymousBiosync = await request.get(`/api/fore/biosync/${encodeURIComponent(bookId)}`);
    expect(anonymousBiosync.status()).toBe(401);
    await openReader.click();
    await expect
      .poll(
        async () => {
          if (await bob.getByRole("button", { name: "Next page", exact: true }).isEnabled())
            return "ready";
          return (
            (await bob.locator(".reader-loading").allTextContents()).join(" | ") ||
            "reader not ready"
          );
        },
        { message: "EPUB reader initialization" },
      )
      .toBe("ready");
    await expect(bob.locator(".reader-social-gutter button").first()).toBeVisible();
    await bob.locator(".reader-social-gutter button").first().click();
    await expect(
      bob.locator(".reader-social-panel").getByText(discussion, { exact: true }),
    ).toBeVisible();
    // A ready toolbar is not sufficient: iPad WebKit previously showed a blank
    // page while the social panel worked and no EPUB iframe was mounted.
    const chapterFrame = bob.frameLocator(".reader-stage .epub-container iframe");
    await expect(bob.locator(".reader-stage .epub-container iframe")).toBeVisible();
    await expect(chapterFrame.locator("#passage")).toContainText("Browser QA passage for sharing.");
    const markerBox = await bob.locator(".reader-social-gutter button").first().boundingBox();
    const passageBox = await chapterFrame.locator("#passage").boundingBox();
    expect(Math.abs(markerBox.y - passageBox.y), "Marker is beside its passage").toBeLessThan(40);
    const thread = bob.locator(".reader-social-panel .social-thread").first();
    const post = thread.locator(".social-post").first();
    const reaction = post.locator("footer button").first();
    await reaction.click();
    await expect(reaction).toHaveAttribute("aria-pressed", "true");
    await post.locator("footer button").nth(1).click();
    await thread.getByLabel("Write a reply").fill("A reply from the margin panel.");
    await thread.getByRole("button", { name: "Reply", exact: true }).click();
    await expect(
      thread.locator("p").getByText("A reply from the margin panel.", { exact: true }),
    ).toBeVisible();
    const replyCard = thread
      .locator(".social-post")
      .filter({
        has: bob.locator("p").getByText("A reply from the margin panel.", { exact: true }),
      })
      .last();
    const replyId = await replyCard.getAttribute("data-post-id");
    const editingCard = thread.locator(`[data-post-id="${replyId}"]`);
    await editingCard.getByRole("button", { name: "Edit", exact: true }).click();
    await editingCard.getByLabel("Edit discussion").fill("An edited margin reply.");
    await editingCard.getByRole("button", { name: "Save published edit", exact: true }).click();
    await expect(
      thread.locator("p").getByText("An edited margin reply.", { exact: true }),
    ).toBeVisible();
    await thread
      .locator(".social-post")
      .filter({ has: bob.getByText("An edited margin reply.", { exact: true }) })
      .last()
      .getByRole("button", { name: "Delete", exact: true })
      .click();
    await expect(thread.getByText("An edited margin reply.", { exact: true })).toHaveCount(0);
    await post.getByRole("button", { name: "Report", exact: true }).click();
    await expect(bob.getByText("Report sent to moderation")).toBeVisible();
    await noOverflow(bob);
    await bob.screenshot({ path: testInfo.outputPath("group-reader.png"), fullPage: true });
    await inventory(outsider);
    await expect(outsider.getByText(discussion, { exact: true })).toHaveCount(0);
    const response = await outsider.request.get("/api/fore/social/sharing?view=received");
    expect((await response.json()).items.some((item) => item.id === fixture.postId)).toBe(false);
  } finally {
    await fixture.close();
  }
});

test("native browser storage persists nonextractable offline encryption keys", async ({
  browser,
  request,
}, testInfo) => {
  const fixture = await setup(browser, request, testInfo);
  try {
    const page = await fixture.pageFor(null);
    await page.goto("/community?tab=received");
    await page.evaluate(async () => {
      const { putRecord } = await import("/src/features/fore/offline.ts");
      const id = "qa-key",
        iv = crypto.getRandomValues(new Uint8Array(12));
      const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
        "encrypt",
        "decrypt",
      ]);
      const cipher = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv },
        key,
        new TextEncoder().encode("Cove offline QA"),
      );
      await putRecord("assets", { id, key, iv, cipher });
    });
    await page.reload();
    const result = await page.evaluate(async () => {
      const { getRecord, deleteRecord } = await import("/src/features/fore/offline.ts");
      const id = "qa-key",
        saved = await getRecord("assets", id);
      const plain = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: saved.iv },
        saved.key,
        saved.cipher,
      );
      await deleteRecord("assets", id);
      return {
        extractable: saved.key.extractable,
        plaintext: new TextDecoder().decode(plain),
        deleted: !(await getRecord("assets", id)),
      };
    });
    expect(result).toEqual({ extractable: false, plaintext: "Cove offline QA", deleted: true });
  } finally {
    await fixture.close();
  }
});

test("journeys show their audience and enforce named-member links", async ({
  browser,
  request,
}, testInfo) => {
  const fixture = await setup(browser, request, testInfo);
  try {
    const alice = await fixture.pageFor("alice"),
      bob = await fixture.pageFor("bob"),
      charlie = await fixture.pageFor("charlie");
    expect(fixture.journeyId).toBeTruthy();
    await alice.goto(`/community?journey=${fixture.journeyId}`);
    await expect(alice.getByText("Current audience:", { exact: false })).toContainText("Followers");
    await expect(
      alice.getByRole("button", { name: "Enable anyone-with-link access", exact: true }),
    ).toBeDisabled();
    await alice
      .getByRole("combobox", { name: "Journey visibility", exact: true })
      .selectOption("private");
    await alice.getByRole("button", { name: "Save journey settings", exact: true }).click();
    await expect(alice.getByText("Current audience:", { exact: false })).toContainText("Private");
    await alice.getByLabel("Member username").fill(fixture.people.bob.username);
    await alice.getByRole("button", { name: "Find member", exact: true }).click();
    await expect(
      alice.getByRole("button", { name: "Grant member access", exact: true }),
    ).toBeDisabled();
    await alice.getByLabel(`Grant access to @${fixture.people.bob.username}`).check();
    await alice.getByRole("button", { name: "Grant member access", exact: true }).click();
    await expect(
      alice.getByRole("button", { name: "Revoke member access", exact: true }),
    ).toBeVisible();
    const grants = await (
      await alice.request.get(`/api/fore/social/journeys/${fixture.journeyId}/recipients`)
    ).json();
    const token = grants.recipients[0].share_token;
    await bob.goto(`/community?journey=${token}`);
    await expect(bob.locator(".journey-page h1")).toHaveText("Pride and Prejudice");
    await charlie.goto(`/community?journey=${token}`);
    await expect(
      charlie.getByText("Reading Journey is unavailable or access was revoked."),
    ).toBeVisible();
    expect(
      (await charlie.request.get(`/api/fore/social/journeys/${token}/card.svg`)).status(),
    ).toBe(404);
    await alice.getByRole("button", { name: "Revoke member access", exact: true }).click();
    await bob.reload();
    await expect(
      bob.getByText("Reading Journey is unavailable or access was revoked."),
    ).toBeVisible();
    await noOverflow(alice);
    const results = await new AxeBuilder({ page: alice })
      .include(".journey-page")
      .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
      .analyze();
    expect(results.violations.filter((v) => ["serious", "critical"].includes(v.impact))).toEqual(
      [],
    );
  } finally {
    await fixture.close();
  }
});

test("zero density persists and hides passage markers", async ({ browser, request }, testInfo) => {
  const fixture = await setup(browser, request, testInfo);
  try {
    const bob = await fixture.pageFor("bob");
    await inventory(bob);
    await bob
      .locator("article.margin-conversation-card")
      .filter({ hasText: discussion })
      .getByRole("link", { name: "Open in reader" })
      .click();
    await expect(bob.locator(".reader-social-gutter button").first()).toBeVisible();
    await bob.locator(".reader-social-gutter button").first().click();
    const slider = bob.getByRole("slider");
    await slider.focus();
    await slider.press("Home");
    await slider.press("Tab");
    await expect(slider).toHaveAttribute("aria-valuenow", "0");
    await expect(bob.getByText("No margin indicators", { exact: true })).toBeVisible();
    await expect(bob.locator(".reader-social-gutter button")).toHaveCount(0);
    const href = bob.url(),
      id = decodeURIComponent(new URL(href).pathname.split("/read/")[1]);
    expect(
      (await (await bob.request.get(`/api/fore/social/reader/${encodeURIComponent(id)}`)).json())
        .preferences.density,
    ).toBe(0);
    await bob.reload();
    await expect(bob.getByRole("button", { name: "Next page", exact: true })).toBeEnabled();
    await expect(bob.locator(".reader-social-gutter button")).toHaveCount(0);
  } finally {
    await fixture.close();
  }
});

test("discovery finds a particular member by username", async ({ browser, request }, testInfo) => {
  const fixture = await setup(browser, request, testInfo);
  try {
    const alice = await fixture.pageFor("alice");
    await alice.goto("/community?tab=discover");
    await alice.getByLabel("Find a member").fill(`@${fixture.people.bob.username}`);
    await expect(alice.locator(".people-grid .person-card")).toHaveCount(1);
    await expect(alice.locator(".people-grid .person-card")).toContainText(
      `@${fixture.people.bob.username}`,
    );
    await alice.getByLabel("Find a member").fill("no_such_reader_qa");
    await expect(alice.getByText("No members found.", { exact: true })).toBeVisible();
    await noOverflow(alice);
  } finally {
    await fixture.close();
  }
});
