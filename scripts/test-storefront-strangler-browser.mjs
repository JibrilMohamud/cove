import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import { chromium } from "@playwright/test";

const html = fs.readFileSync("artifacts/strangler-fixture.html", "utf8");
assert.match(html, /data-rights-country="US"/);
const calls = { discovery: 0, merchandising: 0, language: 0, suggestions: 0, save: 0 };
const server = http.createServer(async (request, response) => {
  const url = new URL(request.url || "/", "http://localhost");
  const json = (body) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
  };
  if (url.pathname === "/" && !url.search) {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(html);
  } else if (url.pathname === "/api/fore/recommendations/discover") {
    assert.equal(request.method, "POST");
    calls.discovery++;
    json({
      rails: [
        {
          title: "Verified recommendations",
          books: [{ publicEditionId: "ed_123", title: "Example title" }],
        },
      ],
    });
  } else if (url.pathname === "/api/fore/merchandising") {
    calls.merchandising++;
    json({
      slots: {
        home: [{ title: "Featured collection", ctaHref: "/store", ctaLabel: "See collection" }],
      },
    });
  } else if (url.pathname === "/api/fore/search/suggest") {
    calls.suggestions++;
    assert.equal(request.method, "GET");
    json({
      suggestions: [
        {
          type: "book",
          productId: "prd_1",
          bookId: "ed_1",
          label: "Jane Austen",
          sublabel: "Author",
        },
      ],
    });
  } else if (url.pathname === "/api/fore/library") {
    calls.save++;
    assert.equal(request.method, "POST");
    response.writeHead(401, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "Sign in required" }));
  } else if (url.pathname === "/api/fore/storefront/context") {
    assert.equal(request.method, "POST");
    calls.language++;
    json({ success: true });
  } else {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end("<h1>Original CORE experience</h1>");
  }
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
const origin = `http://127.0.0.1:${address.port}`;
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(origin + "/", { waitUntil: "domcontentloaded" });
  assert.equal((await page.locator('[data-rights-country="US"] .book-card').count()) > 0, true);
  assert.equal((await page.locator('nav[aria-label="Main"] a').count()) >= 15, true);
  for (const path of ["/library", "/cart", "/orders", "/wishlist", "/downloads", "/publishing"]) {
    assert.equal((await page.locator(`a[href="${path}"]`).count()) > 0, true, path);
  }

  assert.equal((await page.locator("button.thin-save").count()) > 0, true);
  assert.equal((await page.locator("button.facet-toggle").count()) >= 5, true);
  await page.locator("#thin-search").fill("Jane");
  await page.locator("#thin-search-suggestions button").first().waitFor();
  assert.equal(calls.suggestions > 0, true);
  await page.locator("#thin-search-suggestions button").first().click();
  await page.waitForURL("**/search?q=Jane+Austen");
  assert.equal(await page.getByText("Original CORE experience").count(), 1);

  await page.goto(origin + "/");
  await page.locator("button.thin-save").first().click();
  await page.waitForURL("**/?storefront=full&auth=login");
  assert.equal(calls.save, 1);
  assert.equal(await page.getByText("Original CORE experience").count(), 1);

  await page.goto(origin + "/");
  await page.locator("button.facet-toggle").first().click();
  await page.waitForURL("**/deals");
  assert.equal(await page.getByText("Original CORE experience").count(), 1);

  await page.goto(origin + "/");
  await page.locator("#thin-discovery-query").fill("hope and adventure");
  await page.locator('#thin-discovery-form button[type="submit"]').click();
  await page.getByText("Example title").waitFor();
  assert.equal(calls.discovery, 1);
  assert.match(await page.locator("#thin-discovery-status").innerText(), /suggestions/);

  await page.locator("#thin-merchandising").scrollIntoViewIfNeeded();
  await page.getByText("Featured collection").waitFor();
  assert.equal(calls.merchandising, 1);
  await page.locator('[data-thin-filter="sort"]').selectOption("released");
  await page.waitForURL("**/store?sort=released");
  assert.equal(await page.getByText("Original CORE experience").count(), 1);

  await page.goto(origin + "/");
  await page.locator("#thin-search").fill("Jane Austen");
  await page.locator('.catalog-search button[type="submit"]').click();
  await page.waitForURL("**/search?q=Jane+Austen");
  assert.equal(await page.getByText("Original CORE experience").count(), 1);

  await page.goto(origin + "/");
  await page.locator("#thin-locale").dispatchEvent("change");
  await page.waitForURL("**/?storefront=full");
  assert.equal(calls.language, 1);
  assert.equal(await page.getByText("Original CORE experience").count(), 1);
  assert.deepEqual(errors, []);
  console.log(
    "PASS: responsive thin experience, route delegation, discovery, merchandising, locale, filtering and search.",
  );
} finally {
  await browser.close();
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}
