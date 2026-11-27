import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { build } from "esbuild";
import { chromium } from "@playwright/test";
import {
  loadVisualCoverFixtures,
  coverFixtureForUrl,
  decodeVisualCatalog,
} from "./visual-cover-fixtures.mjs";

// A renderer/asset protocol test only. Synthetic bootstrap carries no legal
// authority; full-schema withdrawal is tested separately at the actual ingress.
const fixtures = loadVisualCoverFixtures();
const root = fs.mkdtempSync(path.join(os.tmpdir(), "cove-visual-covers-"));
let browser;
try {
  await build({
    entryPoints: ["src/storefront-strangler/render.ts"],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile: path.join(root, "render.mjs"),
    logLevel: "silent",
  });
  const { renderStranglerStorefront } = await import(path.join(root, "render.mjs"));
  const books = [...fixtures.values()].map((f) => ({
    id: f.sourceExternalId,
    productId: "prd_gutenberg_" + f.sourceExternalId,
    editionId: f.editionId,
    sourceExternalId: f.sourceExternalId,
    title: f.editionId,
    authors: [],
    subjects: [],
    bookshelves: [],
    languages: ["en"],
    formats: { "image/jpeg": f.source },
    download_count: 1,
    offer: { type: "public-domain", currency: "USD", amountMinor: 0 },
  }));
  const html = renderStranglerStorefront(
    {
      context: {
        locale: "en-US",
        direction: "ltr",
        currency: "USD",
        storefrontCountry: "US",
        rightsCountry: "US",
      },
      page: {},
      catalog: { results: books, count: 24, next: null },
    },
    "https://candidate.test",
    false,
  );
  browser = await chromium.launch({
    headless: true,
    ...(process.env.COVE_TEST_CHROMIUM
      ? {
          executablePath: process.env.COVE_TEST_CHROMIUM,
          args: ["--no-sandbox", "--disable-dev-shm-usage"],
        }
      : {}),
  });
  const page = await browser.newPage();
  let hits = 0,
    broken = false;
  await page.route("**/*", async (route) => {
    const url = route.request().url();
    const fixture = coverFixtureForUrl(fixtures, url, "https://candidate.test");
    if (fixture) {
      hits++;
      return route.fulfill({
        status: 200,
        contentType: fixture.contentType,
        body:
          broken && fixture === fixtures.values().next().value
            ? Buffer.from("invalid JPEG")
            : fixture.body,
      });
    }
    if (url === "https://candidate.test/")
      return route.fulfill({ status: 200, contentType: "text/html", body: html });
    return route.abort();
  });
  await page.goto("https://candidate.test/", { waitUntil: "domcontentloaded" });
  assert.deepEqual(await decodeVisualCatalog(page, fixtures), {
    total: 24,
    matched: 24,
    decoded: 24,
  });
  assert.equal(hits, 24);
  broken = true;
  await page.reload({ waitUntil: "domcontentloaded" });
  await assert.rejects(
    () => decodeVisualCatalog(page, fixtures),
    /All 24 authorized edition covers/,
  );
  console.log(
    "PASS: real renderer selects all 24 authentic covers; Chromium decodes them and rejects a corrupt cover",
  );
} finally {
  await browser?.close();
  fs.rmSync(root, { recursive: true, force: true });
}
