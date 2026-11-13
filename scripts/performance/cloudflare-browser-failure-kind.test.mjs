import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyProtectedSsrNavigation as classify } from "./cloudflare-browser-failure-kind.mjs";

test("real D1 503 subtype outranks the generic empty stage marker", () => {
  assert.equal(classify(503, "cove_ssr_empty;dur=0, cove_ssr_read_catalog;dur=0, cove_ssr_read_d1_resource_window;dur=0"), "d1-resource-window");
  assert.equal(classify(503, "cove_ssr_empty;dur=0, cove_ssr_read_d1_queue_full;dur=0"), "d1-queue-full");
  assert.equal(classify(503, "cove_ssr_empty;dur=0, cove_ssr_read_d1_queue_wait;dur=0"), "d1-queue-wait");
  assert.equal(classify(503, "cove_ssr_empty;dur=0, cove_ssr_read_transient_service;dur=0"), "transient-service");
  assert.equal(classify(503, "cove_ssr_empty;dur=0"), "empty-unverified-catalog");
});

test("navigation failures remain hard failures; no raw provider detail is emitted", () => {
  const privateData = "secret:Bearer-personal-token SQL:DELETE FROM rights";
  assert.equal(classify(200, "cove_ssr_read_d1_queue_full;dur=0"), null);
  assert.equal(classify(null, privateData), "no-navigation-response");
  assert.equal(classify(401, privateData), "authorization-denied");
  assert.equal(classify(429, privateData), "rate-limited");
  assert.equal(classify(500, privateData), "other-server-error");
  assert.equal(classify(503, privateData), "unclassified-503");
  assert.equal(classify(503, "cove_ssr_read_d1_queue_full;desc=\"" + privateData + "\""), "unclassified-503");
  assert.equal(classify(503, "cove_ssr_read_d1_queue_full;dur=2"), "unclassified-503");
  assert.equal(classify(503, "cove_ssr_read_d1_queue_full;dur=0.0"), "d1-queue-full");
  assert.equal(classify(503, "cove_ssr_read_catalog;dur=0, " + privateData), "catalog-read");
  for (const status of [null, 400, 401, 429, 500, 503]) {
    const kind = classify(status, privateData);
    assert.ok(!kind.includes(privateData), "Never echo arbitrary diagnostic or credential text");
  }
});
