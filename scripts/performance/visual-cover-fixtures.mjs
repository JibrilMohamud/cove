import assert from "node:assert/strict";
import fs from "node:fs";
import { createHash } from "node:crypto";

export function loadVisualCoverFixtures() {
  const manifest = JSON.parse(
    fs.readFileSync("scripts/fixtures/real-catalog-cover-manifest.json", "utf8"),
  );
  assert.equal(manifest.schema, "cove.visual-covers.v1");
  assert.equal(manifest.covers.length, 24);
  const fixtures = new Map();
  for (const item of manifest.covers) {
    const id = item.sourceExternalId;
    assert.match(id, /^[1-9][0-9]*$/);
    assert.equal(item.editionId, "ed_gutenberg_" + id);
    assert.ok(["image/jpeg", "image/png"].includes(item.contentType));
    assert.equal(
      item.path,
      "/covers/" + id + (item.contentType === "image/jpeg" ? ".jpg" : ".png"),
    );
    assert.equal(item.acquiredFrom, "canonical-epub-declared-cover");
    assert.equal(item.sourceEpubObject, `epubs/${id}.epub`);
    assert.match(item.sourceEpubSha256, /^[a-f0-9]{64}$/);
    assert.ok(item.epubMember && !item.epubMember.includes(".."));
    assert.equal(
      item.source,
      `https://www.gutenberg.org/cache/epub/${id}/pg${id}.cover.medium.jpg`,
    );
    assert.ok(!fixtures.has(item.editionId));
    const body = fs.readFileSync("public" + item.path);
    assert.equal(
      body.subarray(0, item.contentType === "image/jpeg" ? 3 : 8).toString("hex"),
      item.contentType === "image/jpeg" ? "ffd8ff" : "89504e470d0a1a0a",
      "Fixture must have its declared image format",
    );
    assert.equal(
      createHash("sha256").update(body).digest("hex"),
      item.sha256,
      "Cover fixture changed",
    );
    fixtures.set(item.editionId, { ...item, body });
  }
  return fixtures;
}

export function coverFixtureForUrl(fixtures, value, candidateOrigin) {
  const url = new URL(value);
  for (const fixture of fixtures.values()) {
    const source = new URL(fixture.source);
    if (
      (url.origin === candidateOrigin && url.pathname === fixture.path) ||
      (url.origin === source.origin && url.pathname === source.pathname)
    )
      return fixture;
  }
  return null;
}

export async function decodeVisualCatalog(page, fixtures) {
  const expected = [...fixtures.values()].map(({ editionId, path, source }) => ({
    editionId,
    path,
    source,
  }));
  const result = await page.evaluate(async (items) => {
    const cards = [...document.querySelectorAll("article.book-card")];
    const results = await Promise.all(
      cards.map(async (card) => {
        const edition = "ed_" + (card.getAttribute("data-product") || "").replace(/^prd_/, "");
        const fixture = items.find((item) => item.editionId === edition);
        const img = card.querySelector("img");
        const url = img ? new URL(img.currentSrc || img.src) : null;
        const matched =
          !!fixture &&
          !!url &&
          ((url.origin === location.origin && url.pathname === fixture.path) ||
            url.href === fixture.source);
        if (!img || !matched) return { matched: false, decoded: false };
        img.loading = "eager";
        try {
          await img.decode();
          return { matched: true, decoded: img.naturalWidth > 0 && img.naturalHeight > 0 };
        } catch {
          return { matched: true, decoded: false };
        }
      }),
    );
    return {
      total: cards.length,
      matched: results.filter((r) => r.matched).length,
      decoded: results.filter((r) => r.decoded).length,
    };
  }, expected);
  assert.deepEqual(
    result,
    { total: 24, matched: 24, decoded: 24 },
    "All 24 authorized edition covers must match and decode before pixel comparison",
  );
  return result;
}

export function observeBrowserFailures(page) {
  const diagnostics = {
    imageRequests: 0,
    imageFailures: 0,
    imageHttpFailures: 0,
    scriptFailures: 0,
    scriptHttpFailures: 0,
    pageErrors: 0,
  };
  page.on("pageerror", () => diagnostics.pageErrors++);
  page.on("request", (r) => {
    if (r.resourceType() === "image") diagnostics.imageRequests++;
  });
  page.on("requestfailed", (r) => {
    if (r.resourceType() === "image") diagnostics.imageFailures++;
    if (r.resourceType() === "script") diagnostics.scriptFailures++;
  });
  page.on("response", (r) => {
    if (r.status() < 400) return;
    if (r.request().resourceType() === "image") diagnostics.imageHttpFailures++;
    if (r.request().resourceType() === "script") diagnostics.scriptHttpFailures++;
  });
  return diagnostics;
}
