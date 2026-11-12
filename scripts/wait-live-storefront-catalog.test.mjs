import assert from "node:assert/strict";
import { test } from "node:test";
import { catalogReadinessFailure, waitForLiveCatalog } from "./wait-live-storefront-catalog.mjs";

const headers = {
  "content-type": "application/json",
  "cache-control": "no-store",
  "x-cove-persistence": "remote-d1-r2",
};
const response = (
  status = 200,
  data = { results: [{ productId: "prd_test", title: "Title" }] },
  h = headers,
) => new Response(JSON.stringify(data), { status, headers: h });
const opts = { origin: "https://cove-puce-theta.vercel.app", pause: async () => {} };

test("guest catalog acceptance is exact and fails closed without backend proof", async () => {
  assert.equal(await catalogReadinessFailure(response()), null);
  assert.equal(await catalogReadinessFailure(response(503)), "http-unavailable");
  assert.equal(await catalogReadinessFailure(response(401)), "http-unavailable");

  const empty = response(200, { results: [] });
  const missingId = response(200, { results: [{ title: "No product" }] });
  assert.equal(await catalogReadinessFailure(empty), "missing-authorized-books");
  assert.equal(await catalogReadinessFailure(missingId), "missing-authorized-books");

  const valid = { results: [{ productId: "id", title: "T" }] };
  const untrusted = response(200, valid, { ...headers, "x-cove-persistence": "stale-seed" });
  const cacheable = response(200, valid, { ...headers, "cache-control": "public, max-age=300" });
  assert.equal(await catalogReadinessFailure(untrusted), "missing-live-backend-proof");
  assert.equal(await catalogReadinessFailure(cacheable), "unsafe-cache-policy");
});

test("one transient 503 can recover, but real catalog is always required", async () => {
  let calls = 0;
  const out = await waitForLiveCatalog({
    ...opts,
    fetcher: async (url, init) => {
      calls += 1;
      assert.match(url, /\/api\/fore\/catalog\?/);
      assert.equal(init.method, "GET");
      assert.equal(init.redirect, "manual");
      assert.ok(!init.headers.Authorization);
      return calls === 1 ? response(503) : response();
    },
    attempts: 3,
  });
  assert.deepEqual(out, { ready: true, attempts: 2 });
  await assert.rejects(
    waitForLiveCatalog({ ...opts, fetcher: async () => response(503), attempts: 2 }),
    /http-unavailable/,
  );
  const noBooks = waitForLiveCatalog({
    ...opts,
    fetcher: async () => response(200, { results: [] }),
    attempts: 2,
  });
  await assert.rejects(noBooks, /missing-authorized-books/);
});

test("backend deployment requires two consecutive live catalog responses", async () => {
  let calls = 0;
  const statuses = [503, 200, 503, 200, 200];
  const actual = await waitForLiveCatalog({
    ...opts,
    attempts: 8,
    consecutiveSuccesses: 2,
    fetcher: async () => response(statuses[calls++]),
  });
  assert.deepEqual(actual, { ready: true, attempts: 5 });
  assert.equal(calls, 5);
  await assert.rejects(
    waitForLiveCatalog({
      ...opts,
      attempts: 3,
      consecutiveSuccesses: 2,
      fetcher: async () => response(503),
    }),
    /http-unavailable/,
  );
  for (const value of [0, 4, 1.5]) {
    await assert.rejects(
      waitForLiveCatalog({ ...opts, attempts: 5, consecutiveSuccesses: value }),
      (error) => error?.name === "AssertionError",
    );
  }
});

test("network errors are bounded and never print secret exception text", async () => {
  await assert.rejects(
    waitForLiveCatalog({
      ...opts,
      attempts: 2,
      fetcher: async () => {
        throw Error("private-credential-should-not-be-emitted");
      },
    }),
    (error) =>
      /network-unavailable/.test(error.message) &&
      !error.message.includes("private-credential-should-not-be-emitted"),
  );
});
