import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyProtectedSsrNavigation as classify } from "./cloudflare-browser-failure-kind.mjs";

test("real D1 503 subtype outranks the generic empty stage marker", () => {
  const cases = [
    ["cove_ssr_read_catalog;dur=0, cove_ssr_read_d1_resource_window;dur=0", "d1-resource-window"],
    ["cove_ssr_read_d1_queue_full;dur=0", "d1-queue-full"],
    ["cove_ssr_read_d1_queue_wait;dur=0", "d1-queue-wait"],
    ["cove_ssr_read_transient_service;dur=0", "transient-service"],
    ["", "empty-unverified-catalog"],
  ];
  for (const [marker, expected] of cases) {
    assert.equal(classify(503, "cove_ssr_empty;dur=0, " + marker), expected);
  }
});

test("navigation failures remain hard failures; no raw provider detail is emitted", () => {
  const privateData = "secret:Bearer-personal-token SQL:DELETE FROM rights";
  const cases = [
    [200, null],
    [null, "no-navigation-response"],
    [401, "authorization-denied"],
    [429, "rate-limited"],
    [500, "other-server-error"],
    [503, "unclassified-503"],
  ];
  for (const [status, expected] of cases) {
    const kind = classify(status, privateData);
    assert.equal(kind, expected);
    assert.ok(!kind?.includes(privateData), "Never echo credential or provider text");
  }
  assert.equal(
    classify(503, 'cove_ssr_read_d1_queue_full;desc="' + privateData + '"'),
    "unclassified-503",
  );
  assert.equal(classify(503, "cove_ssr_read_d1_queue_full;dur=2"), "unclassified-503");
  assert.equal(classify(503, "cove_ssr_read_d1_queue_full;dur=0.0"), "d1-queue-full");
  assert.equal(classify(503, "cove_ssr_read_catalog;dur=0, " + privateData), "catalog-read");
});
