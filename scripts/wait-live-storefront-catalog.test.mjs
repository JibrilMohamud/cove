import assert from "node:assert/strict";
import { test } from "node:test";
import { catalogReadinessFailure, waitForLiveCatalog } from "./wait-live-storefront-catalog.mjs";

const headers = {
  "content-type": "application/json",
  "cache-control": "no-store",
  "x-cove-persistence": "remote-d1-r2",
};
const response = (status = 200, data = { results: [{ productId: "prd_test", title: "Title" }] }, h = headers) =>
  new Response(JSON.stringify(data), { status, headers: h });
const opts = { origin: "https://cove-puce-theta.vercel.app", pause: async () => {} };

test("guest catalog acceptance is exact and fails closed without backend proof", async () => {
  assert.equal(await catalogReadinessFailure(response()), null);
  assert.equal(await catalogReadinessFailure(response(503)), "http-unavailable");
  assert.equal(await catalogReadinessFailure(response(401)), "http-unavailable");
  assert.equal(await catalogReadinessFailure(response(200, { results: [] })), "missing-authorized-books");
  assert.equal(
    await catalogReadinessFailure(response(200, { results: [{ title: "No product" }] })),
    "missing-authorized-books",
  );
  assert.equal(
    await catalogReadinessFailure(response(200, { results: [{ productId: "id", title: "T" }] }, {
      ...headers,
      "x-cove-persistence": "stale-seed",
    })),
    "missing-live-backend-proof",
  );
  assert.equal(
    await catalogReadinessFailure(response(200, { results: [{ productId: "id", title: "T" }] }, {
      ...headers,
      "cache-control": "public, max-age=300",
    })),
    "unsafe-cache-policy",
  );
});

test("one transient 503 can recover, but real catalog is always required", async () => {
  let calls = 0;
  const out = await waitForLiveCatalog({
    ...opts,
    fetcher: async (url, init) => {
      calls += 1;
      assert.match(url, /\\/api\\/fore\\/catalog\\?/);
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
  await assert.rejects(
    waitForLiveCatalog({ ...opts, fetcher: async () => response(200, { results: [] }), attempts: 2 }),
    /missing-authorized-books/,
  );
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
