import assert from "node:assert/strict";
import { test } from "node:test";
import { capacityHtmlFailureKind } from "./strict-capacity-response-diagnostics.mjs";
import { validateHtml } from "../check-production-storefront-performance.mjs";

test("exact authenticated HTML and book cards remain mandatory", () => {
  const good = '<article class="book-card">Authorized title</article>';
  assert.equal(capacityHtmlFailureKind(200, "text/html; charset=utf-8", good), null);
  assert.equal(validateHtml(200, "text/html", good), 1);
  assert.equal(
    capacityHtmlFailureKind(200, "text/html", "<html><main>Loading</main></html>"),
    "missing-ssr-book-cards",
  );
  assert.throws(() => validateHtml(200, "text/html", "<html></html>"), /no server-rendered/);
  assert.equal(capacityHtmlFailureKind(401, "text/html", good), "unexpected-http-status");
  assert.equal(capacityHtmlFailureKind(429, "text/html", good), "unexpected-http-status");
  assert.equal(capacityHtmlFailureKind(503, "text/html", good), "unexpected-http-status");
  assert.equal(capacityHtmlFailureKind(200, "application/json", good), "unexpected-media-type");
  assert.equal(
    capacityHtmlFailureKind(200, "text/html", "x".repeat(4_000_001)),
    "html-safety-limit",
  );
});

test("classification emits no arbitrary response or credential material", () => {
  const secret = "private-token-do-not-emit";
  const result = capacityHtmlFailureKind(200, "text/html", `<p>${secret}</p>`);
  assert.equal(result, "missing-ssr-book-cards");
  assert.ok(!result.includes(secret));
});
