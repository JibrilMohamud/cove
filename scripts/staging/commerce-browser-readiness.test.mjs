import assert from "node:assert/strict";
import test from "node:test";
import { commerceQaIngress } from "../../src/cloudflare/commerce-qa-ingress.mjs";
import { prepareCommerceBrowser } from "./commerce-browser-readiness.mjs";

const origin = "https://cove-commerce-customer-qa-stage.cove-qa-reads.workers.dev";
const instance = "a".repeat(32);
const vars = {
  COVE_SSR_STAGING: "1",
  COVE_SSR_STAGING_COMMERCE_QA: "1",
  STRIPE_LIVEMODE: "false",
  COVE_LEGAL_WRITER_PRIMARY_ID: "f9354381-bd9f-496b-bd05-d6f62a32ec0c",
};
function response(status = 200, headers = {}, api = false) {
  return {
    status: () => status,
    headers: () => ({
      "x-cove-qa-ingress-instance": instance,
      "cache-control": "no-store",
      "content-type": api ? "application/json" : "text/html",
      ...headers,
    }),
    url: () => origin + (api ? "/api/fore/auth/options" : "/"),
    json: async () => ({ available: true }),
  };
}
function harness(nav = () => response(), api = () => response(200, {}, true)) {
  let navigations = 0,
    reads = 0,
    sleeps = 0;
  const headers = { authorization: "Bearer " + "b".repeat(64) };
  const page = {
    async goto(url, options) {
      navigations++;
      assert.equal(url, origin + "/");
      assert.equal(options.waitUntil, "domcontentloaded");
      return nav(navigations);
    },
    context() {
      return {
        request: {
          async get(url, options) {
            reads++;
            assert.equal(url, origin + "/api/fore/auth/options");
            assert.equal(options.maxRedirects, 0);
            assert.deepEqual(options.headers, headers);
            return api(reads);
          },
        },
      };
    },
  };
  return {
    options: {
      page,
      origin,
      headers,
      instance,
      sleep: async (ms) => {
        assert.equal(ms, 2000);
        sleeps++;
      },
    },
    counts: () => ({ navigations, reads, sleeps }),
  };
}
const edge404 = () => response(404, { "x-cove-qa-ingress-instance": undefined });
test("a Chromium edge 404 delays preparation; both exact-instance HTML and auth router must pass before login", async () => {
  const h = harness(
    (n) => (n === 1 ? edge404() : response()),
    (n) =>
      n === 1
        ? response(404, { "x-cove-qa-ingress-instance": undefined }, true)
        : response(200, {}, true),
  );
  const outcome = await prepareCommerceBrowser(h.options);
  assert.deepEqual(outcome, { waves: 3, edge404: 2 });
  assert.deepEqual(h.counts(), { navigations: 3, reads: 2, sleeps: 2 });
});
test("persistent unmarked 404s fail at a hard bound and never call any mutation", async () => {
  const h = harness(edge404);
  await assert.rejects(
    () => prepareCommerceBrowser(h.options),
    /did not settle before login: edge404=30/,
  );
  assert.deepEqual(h.counts(), { navigations: 30, reads: 0, sleeps: 29 });
});
test("application 404s, stale markers, authorization failures, 5xx, redirects and forged 200s fail immediately", async () => {
  for (const invalid of [
    response(404),
    response(404, { "x-cove-qa-ingress-instance": undefined, "x-fore-request-id": "application" }),
    response(404, { "x-cove-qa-ingress-instance": undefined, "x-robots-tag": "noindex" }),
    response(404, {
      "x-cove-qa-ingress-instance": undefined,
      "content-security-policy": "default-src 'self'",
    }),
    response(401),
    response(500),
    response(503, { "x-cove-qa-ingress-instance": undefined }),
    response(200, { "x-cove-qa-ingress-instance": "c".repeat(32) }),
    response(200, { "x-cove-qa-ingress-instance": undefined }),
    { ...response(), url: () => "https://elsewhere.example/" },
    response(200, { "content-type": "application/json" }),
  ]) {
    const h = harness(() => invalid);
    await assert.rejects(() => prepareCommerceBrowser(h.options));
    assert.deepEqual(h.counts(), { navigations: 1, reads: 0, sleeps: 0 });
  }
  for (const invalid of [
    response(404, {}, true),
    response(401, {}, true),
    { ...response(200, {}, true), json: async () => ({ available: false }) },
  ]) {
    const h = harness(undefined, () => invalid);
    await assert.rejects(() => prepareCommerceBrowser(h.options));
    assert.deepEqual(h.counts(), { navigations: 1, reads: 1, sleeps: 0 });
  }
});
test("wrong origin or absent instance fails before any navigation", async () => {
  for (const overrides of [{ origin: "https://covereads.com" }, { instance: "" }]) {
    const h = harness();
    await assert.rejects(() => prepareCommerceBrowser({ ...h.options, ...overrides }));
    assert.deepEqual(h.counts(), { navigations: 0, reads: 0, sleeps: 0 });
  }
});
test("run-bound QA wrapper preserves application denial and never authorizes or changes body", async () => {
  const request = new Request(origin + "/api/fore/checkout/payment", { method: "POST" });
  const ctx = { waitUntil() {} };
  const wrapper = commerceQaIngress(
    {
      async fetch(r, e, c) {
        assert.equal(r, request);
        assert.equal(e, vars);
        assert.equal(c, ctx);
        return new Response("Denied by application", {
          status: 401,
          headers: { "x-cove-qa-ingress-instance": "forged", "content-type": "text/plain" },
        });
      },
    },
    instance,
  );
  const result = await wrapper.fetch(request, vars, ctx);
  assert.equal(result.status, 401);
  assert.equal(await result.text(), "Denied by application");
  assert.equal(result.headers.get("x-cove-qa-ingress-instance"), instance);
  assert.equal(result.headers.get("cache-control"), "no-store, max-age=0");
});
test("QA wrapper refuses production origin, live payments and wrong data-plane identity before delegation", async () => {
  const wrapper = commerceQaIngress(
    {
      fetch() {
        assert.fail("Untrusted scope reached application");
      },
    },
    instance,
  );
  for (const [url, env] of [
    ["https://covereads.com", vars],
    [origin, { ...vars, STRIPE_LIVEMODE: "true" }],
    [origin, { ...vars, COVE_SSR_STAGING: "0" }],
    [origin, { ...vars, COVE_LEGAL_WRITER_PRIMARY_ID: "4bd657ac-8789-403e-a28c-93aba8d0a989" }],
  ])
    assert.equal((await wrapper.fetch(new Request(url), env, {})).status, 503);
  assert.throws(() => commerceQaIngress({}, "not-a-run-instance"));
});
