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
    await expect(bob.getByRole("heading", { name: "Finished.", exact: true })).toHaveCount(0);
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
    await bob
      .getByRole("alertdialog")
      .getByRole("button", { name: "Delete published discussion", exact: true })
      .click();
    await expect(thread.getByText("An edited margin reply.", { exact: true })).toHaveCount(0);
    await post.getByRole("button", { name: "Report", exact: true }).click();
    const report = bob.getByRole("dialog", { name: "Report this discussion" });
    await expect(report.getByRole("button", { name: "Submit report" })).toBeDisabled();
    await report.getByLabel("Report reason").selectOption("harassment");
    await report
      .getByLabel("Report details")
      .fill("Please review this passage discussion for harassment.");
    await report.getByRole("button", { name: "Submit report" }).click();
    await expect(bob.getByText("Report sent to moderation")).toBeVisible();
    await noOverflow(bob);
    await bob.screenshot({ path: testInfo.outputPath("group-reader.png"), fullPage: true });
    await bob.getByRole("button", { name: "Close", exact: true }).click();
    await bob.getByRole("button", { name: "Next page", exact: true }).click();
    await expect(chapterFrame.locator("#passage")).not.toBeInViewport();
    await expect(bob.locator(".reader-social-gutter button")).toHaveCount(0);
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
    await expect(page.locator('html[data-cove-client-ready="true"]')).toHaveCount(1);
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
    await expect(page.locator('html[data-cove-client-ready="true"]')).toHaveCount(1);
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
    await bob.getByRole("button", { name: "Close", exact: true }).click();
    await expect(bob.locator(".reader-save-status")).toHaveText("Position saved");
    await bob.reload();
    await expect(bob.getByRole("button", { name: "Next page", exact: true })).toBeEnabled();
    await expect(bob.locator(".reader-social-gutter button")).toHaveCount(0);
  } finally {
    await fixture.close();
  }
});

test("public reader IDs save repeatedly and real remote conflicts remain fenced", async ({
  browser,
  request,
}, testInfo) => {
  const fixture = await setup(browser, request, testInfo);
  try {
    const bob = await fixture.pageFor("bob");
    await inventory(bob);
    await bob
      .locator("article.margin-conversation-card")
      .filter({ hasText: discussion })
      .getByRole("link", { name: "Open in reader" })
      .click();
    await expect(bob.locator(".reader-save-status")).toHaveText("Position saved");
    const pageSave = bob.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/api/fore/library" &&
        response.request().method() === "POST" &&
        response.ok(),
    );
    await bob.getByRole("button", { name: "Next page", exact: true }).click();
    await pageSave;
    await expect(bob.locator(".reader-save-status")).toHaveText("Position saved");
    const id = decodeURIComponent(new URL(bob.url()).pathname.split("/read/")[1]);
    const account = await (await bob.request.get("/api/fore/account")).json();
    const current = account.library.find(
      (entry) => entry.book.id === id || entry.book.publicProductId === id,
    );
    expect(current.version).toBeGreaterThan(2);
    const remoteCfi = "epubcfi(/6/2!/4/6/1:0)";
    const changed = await bob.request.post("/api/fore/library", {
      data: {
        bookId: id,
        cfi: remoteCfi,
        progress: 0.7,
        status: "reading",
        expectedVersion: current.version,
      },
    });
    expect(changed.ok(), await changed.text()).toBeTruthy();
    await bob.getByRole("button", { name: "Next page", exact: true }).click();
    await expect(bob.locator(".reader-save-status")).toHaveText(
      "Position changed on another device — reload to choose",
    );
    await bob.getByRole("button", { name: "Next page", exact: true }).click();
    const after = await (await bob.request.get("/api/fore/account")).json();
    expect(after.library.find((entry) => entry.productId === current.productId).cfi).toBe(
      remoteCfi,
    );
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

async function selectReaderPassage(page) {
  const passage = page.frameLocator(".epub-container iframe").locator("#passage");
  await expect(passage).toBeVisible();
  // Sharing dialogs return focus to their trigger outside the EPUB. WebKit
  // requires the text document to regain focus before it retains a selection.
  await passage.click();
  const nativeSelection = await passage.evaluate((element) => {
    const doc = element.ownerDocument,
      range = doc.createRange();
    range.selectNodeContents(element);
    const selection = doc.defaultView.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    doc.dispatchEvent(new Event("selectionchange"));
    return {
      text: selection.toString(),
      rangeText: range.toString(),
      frameElementAvailable: !!doc.defaultView.frameElement,
      documentFocused: doc.hasFocus(),
    };
  });
  expect(nativeSelection.rangeText).toBe(quote);
  await expect(page.locator(".selection-toolbar"), JSON.stringify(nativeSelection)).toBeVisible();
}

test("saved defaults, independent group pickers and simultaneous audiences drive publication", async ({
  browser,
  request,
}, testInfo) => {
  const fixture = await setup(browser, request, testInfo);
  try {
    const alice = await fixture.pageFor("alice");
    const me = await (await alice.request.get("/api/fore/social/me")).json();
    const profile = me.profile;
    const saveDefault = await alice.request.post("/api/fore/social/profile", {
      data: {
        bio: profile.bio || "",
        profileVisibility: profile.profile_visibility,
        followPolicy: profile.follow_policy,
        repliesPolicy: profile.replies_policy,
        activityVisibility: profile.activity_visibility,
        journeyVisibilityDefault: profile.journey_visibility_default,
        highlightVisibilityDefault: "followers",
        showCurrentlyReading: !!profile.show_currently_reading,
        expectedVersion: profile.version,
      },
    });
    expect(saveDefault.ok(), await saveDefault.text()).toBeTruthy();
    const secondGroupName = `Another circle ${fixture.people.alice.username}`;
    const secondGroup = await (
      await alice.request.post("/api/fore/social/groups", {
        data: { name: secondGroupName, visibility: "private" },
      })
    ).json();
    const book = await (await alice.request.get("/api/fore/books/1342")).json();
    await alice.goto(`/read/${book.publicProductId || book.id}`);
    await expect(alice.getByRole("button", { name: "Next page", exact: true })).toBeEnabled();
    expect(await alice.locator(".epub-container iframe").getAttribute("sandbox")).not.toContain(
      "allow-scripts",
    );
    if (!(await alice.getByRole("button", { name: "Book highlights", exact: true }).isVisible()))
      await alice.getByRole("button", { name: "Show reader controls", exact: true }).click();
    await expect(alice.getByRole("button", { name: "Book highlights", exact: true })).toBeVisible();
    await alice.getByRole("button", { name: "Book highlights", exact: true }).click();
    await expect(
      alice.locator(".reader-highlights").getByText(quote, { exact: true }),
    ).toBeVisible();
    await alice.getByRole("button", { name: `Share highlight: ${quote}`, exact: true }).click();
    let share = alice.getByRole("dialog", { name: "Share this highlight." });
    await expect(share.getByRole("combobox").first()).toContainText("Followers");
    await expect(share.getByRole("button", { name: "Share with this audience" })).toBeDisabled();
    await share.getByRole("combobox").first().click();
    await alice.getByRole("option", { name: "Reading group", exact: true }).click();
    await expect(share.getByRole("combobox").nth(1)).toContainText("Choose a reading group");
    await share.getByRole("combobox").nth(1).click();
    await alice.getByRole("option", { name: secondGroupName, exact: true }).click();
    await share.getByLabel("Include my private note with this shared highlight").check();
    await expect(share.getByText(note, { exact: true })).toBeVisible();
    await share.getByRole("checkbox", { name: /I confirm this highlight/ }).check();
    await share.getByRole("button", { name: "Share with this audience" }).click();
    await expect(share).toHaveCount(0);
    const route = `/api/fore/social/highlights/${fixture.annotationId}/share`;
    let published = await (await alice.request.get(route)).json();
    const independent = published.shares.find((item) => item.groupId === secondGroup.id);
    expect(independent.shareNote).toBe(true);
    expect(published.shares.some((item) => item.recipientUserId === fixture.people.bob.id)).toBe(
      true,
    );
    if (!(await alice.getByRole("button", { name: "Book highlights", exact: true }).isVisible()))
      await alice.getByRole("button", { name: "Show reader controls", exact: true }).click();
    await expect(alice.getByRole("button", { name: "Book highlights", exact: true })).toBeVisible();
    await alice.getByRole("button", { name: "Book highlights", exact: true }).click();
    await alice.getByRole("button", { name: `Share highlight: ${quote}`, exact: true }).click();
    share = alice.getByRole("dialog", { name: "Share this highlight." });
    await share.getByRole("combobox").first().click();
    await alice.getByRole("option", { name: "Reading group", exact: true }).click();
    await share.getByRole("combobox").nth(1).click();
    await alice.getByRole("option", { name: fixture.groupName, exact: true }).click();
    await share.getByRole("checkbox", { name: /I confirm this highlight/ }).check();
    await share.getByRole("button", { name: "Share with this audience" }).click();
    await expect(share).toHaveCount(0);
    published = await (await alice.request.get(route)).json();
    expect(published.shares).toHaveLength(3);
    expect(published.shares.find((item) => item.id === independent.id).version).toBe(
      independent.version,
    );
    expect(published.shares.find((item) => item.groupId === fixture.groupId).shareNote).toBe(false);

    // Leave the transient success toast rather than keep it paused by mouse hover.
    await alice.mouse.move(0, 0);
    await expect(alice.locator("[data-sonner-toast]")).toHaveCount(0);
    await selectReaderPassage(alice);
    await alice
      .locator(".selection-toolbar")
      .getByRole("button", { name: "Discuss", exact: true })
      .click();
    const composer = alice.getByRole("dialog", { name: "Start a margin conversation." });
    await expect(composer.getByRole("combobox").first()).toContainText("Friends / mutuals");
    await composer
      .getByLabel("Margin discussion")
      .fill("An explicitly addressed margin discussion.");
    await expect(composer.getByRole("button", { name: /^Post to/ })).toBeDisabled();
    await composer.getByRole("combobox").first().click();
    await alice.getByRole("option", { name: "Reading group", exact: true }).click();
    await composer.getByRole("combobox").nth(1).click();
    await alice.getByRole("option", { name: secondGroupName, exact: true }).click();
    await composer.getByRole("checkbox", { name: /I confirm this discussion/ }).check();
    const posted = alice.waitForResponse(
      (r) =>
        new URL(r.url()).pathname === "/api/fore/social/posts" && r.request().method() === "POST",
    );
    await composer.getByRole("button", { name: /^Post to/ }).click();
    const response = await posted;
    expect(response.ok()).toBeTruthy();
    const post = await response.json();
    const thread = await (
      await alice.request.get(
        `/api/fore/social/posts?contextType=margin&contextId=1342&postId=${post.id}`,
      )
    ).json();
    expect(thread.posts[0].groupId).toBe(secondGroup.id);
    const viewing = await (await alice.request.get("/api/fore/social/reader/1342")).json();
    expect(viewing.preferences.groupId).toBe(fixture.groupId);
    await noOverflow(alice);
  } finally {
    await fixture.close();
  }
});

test("note republishing selects audiences and rejects a concurrently changed private note", async ({
  browser,
  request,
}, testInfo) => {
  const fixture = await setup(browser, request, testInfo);
  try {
    const alice = await fixture.pageFor("alice"),
      bob = await fixture.pageFor("bob"),
      charlie = await fixture.pageFor("charlie");
    const shareRoute = `/api/fore/social/highlights/${fixture.annotationId}/share`;
    const source = await (await alice.request.get(shareRoute)).json();
    const shared = await alice.request.post(shareRoute, {
      data: {
        visibility: "member",
        recipientUserId: fixture.people.charlie.id,
        shareNote: true,
        expectedAnnotationVersion: source.annotationVersion,
        expectedVersion: 0,
        audienceConfirmed: true,
      },
    });
    expect(shared.ok(), await shared.text()).toBeTruthy();
    await alice.goto("/highlights");
    let card = alice.locator("article.annotation-card").filter({ hasText: quote });
    await card.getByRole("button", { name: "Edit highlight note" }).click();
    await expect(alice.getByText("This highlight remains shared", { exact: true })).toBeVisible();
    await alice.getByLabel("Note on this passage").fill("A new copy only for Bob.");
    await alice.getByRole("button", { name: "Save note", exact: true }).click();
    let dialog = alice.getByRole("alertdialog");
    await expect(dialog).toBeVisible();
    await dialog
      .getByRole("checkbox", { name: `@${fixture.people.charlie.username}`, exact: true })
      .uncheck();
    await dialog.getByRole("button", { name: "Republish note", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await inventory(bob);
    await expect(bob.getByText("A new copy only for Bob.", { exact: true })).toBeVisible();
    await inventory(charlie);
    await expect(charlie.getByText(note, { exact: true })).toBeVisible();
    await alice.goto("/highlights");
    card = alice.locator("article.annotation-card").filter({ hasText: quote });
    await card.getByRole("button", { name: "Edit highlight note" }).click();
    await expect(alice.getByRole("button", { name: "Review & republish note…" })).toBeEnabled();
    await alice.getByRole("button", { name: "Review & republish note…" }).click();
    dialog = alice.getByRole("alertdialog");
    await expect(dialog).toBeVisible();
    const current = await (await alice.request.get(shareRoute)).json();
    const edited = await alice.request.patch(`/api/fore/annotations/${fixture.annotationId}`, {
      data: {
        note: "A private edit from another device.",
        color: "yellow",
        expectedVersion: current.annotationVersion,
      },
    });
    expect(edited.ok(), await edited.text()).toBeTruthy();
    await dialog.getByRole("button", { name: "Republish note", exact: true }).click();
    await expect(alice.getByText(/Your private note changed\./)).toBeVisible();
    await expect(dialog).toHaveCount(0);
    await inventory(bob);
    await expect(bob.getByText("A new copy only for Bob.", { exact: true })).toBeVisible();
    await inventory(charlie);
    await expect(charlie.getByText(note, { exact: true })).toBeVisible();
    await card.getByRole("button", { name: "Edit highlight note" }).click();
    await expect(alice.getByLabel("Note on this passage")).toHaveValue(
      "A private edit from another device.",
    );
  } finally {
    await fixture.close();
  }
});

test("loading older margin activity preserves the newest visible note and opens older conversations", async ({
  browser,
  request,
}, testInfo) => {
  const fixture = await setup(browser, request, testInfo);
  try {
    const alice = await fixture.pageFor("alice"),
      bob = await fixture.pageFor("bob");
    const reader = await (await bob.request.get("/api/fore/social/reader/1342")).json();
    const preference = await bob.request.post("/api/fore/social/reader/preferences", {
      data: {
        ...reader.preferences,
        audienceMode: "friends",
        groupId: null,
        expectedVersion: reader.preferences.version,
      },
    });
    expect(preference.ok(), await preference.text()).toBeTruthy();
    const olderBody = "An older accessible conversation.";
    const published = await alice.request.post("/api/fore/social/posts", {
      data: {
        contextType: "margin",
        contextId: "1342",
        bookId: "1342",
        cfi: "epubcfi(/6/2!/4/6/1:0)",
        chapter: "Chapter 1",
        progress: 0,
        passageText: "Reading paragraph 1.",
        body: olderBody,
        visibility: "member",
        recipientUserId: fixture.people.bob.id,
        audienceConfirmed: true,
      },
    });
    expect(published.ok(), await published.text()).toBeTruthy();
    const post = await published.json();
    const projection = await (await bob.request.get("/api/fore/social/reader/1342")).json();
    const original = projection.indicators.find((cluster) =>
      cluster.highlights.some((highlight) => highlight.annotationId === fixture.annotationId),
    );
    const older = projection.indicators.find((cluster) =>
      cluster.posts.some((item) => item.id === post.id),
    );
    expect(original).toBeTruthy();
    expect(older).toBeTruthy();
    // Server cursor filtering is covered by the database pagination regression.
    // Here we feed those authorized projections as two pages to exercise UI merging.
    const currentHighlight = { ...original.highlights[0], updatedAt: "2030-01-01T00:00:00.000Z" };
    await bob.route("**/api/fore/social/reader/*", async (route) => {
      const cursor = new URL(route.request().url()).searchParams.get("cursor");
      await route.fulfill({
        json: {
          ...projection,
          indicators: cursor
            ? [
                {
                  ...original,
                  highlights: [
                    {
                      ...currentHighlight,
                      id: "older_publication",
                      updatedAt: "2020-01-01T00:00:00.000Z",
                      note: "An older published note.",
                    },
                  ],
                },
                older,
              ]
            : [{ ...original, highlights: [currentHighlight] }],
          nextCursor: cursor ? null : "qa_older_page",
        },
      });
    });
    await bob.goto("/read/1342");
    await expect(bob.getByRole("button", { name: "Next page", exact: true })).toBeEnabled();
    await bob.locator(".reader-social-gutter button").first().click();
    const panel = bob.locator(".reader-social-panel");
    await expect(panel.getByText(note, { exact: true })).toBeVisible();
    // Loading the final page removes its own button. WebKit's pointer action
    // can retry after that successful removal; keyboard activation completes
    // before the update while exercising the same accessible control.
    const loadOlder = panel.getByRole("button", { name: "Load older passage activity" });
    await expect(loadOlder).toBeEnabled();
    await loadOlder.focus();
    await loadOlder.press("Enter");
    await expect(panel.getByRole("button", { name: "Load older passage activity" })).toHaveCount(0);
    await expect(panel.getByText(note, { exact: true })).toBeVisible();
    await expect(panel.getByText("An older published note.", { exact: true })).toHaveCount(0);
    await panel.getByRole("button", { name: "← All visible activity" }).click();
    await panel
      .locator(".reader-social-summary button")
      .filter({ hasText: "Reading paragraph 1." })
      .click();
    await expect(panel.getByText(olderBody, { exact: true })).toBeVisible();
    await expect(panel.getByRole("button", { name: "Go to this passage" })).toBeVisible();
    await noOverflow(bob);
  } finally {
    await fixture.close();
  }
});
