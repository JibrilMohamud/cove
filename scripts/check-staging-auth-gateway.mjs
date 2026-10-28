import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";

if (!globalThis.crypto) globalThis.crypto = webcrypto;
const { default: gateway } = await import("../src/cloudflare/staging-auth-gateway.mjs");

const host = "https://cove-asset-auth-gateway.cove-jibrilmohamud.workers.dev";
const key = "a".repeat(64);
let upstreamCount = 0;
let lastRequest = null;
const env = {
  COVE_STAGING_INGRESS_HOST: new URL(host).hostname,
  COVE_SSR_STAGING_GATE_KEY: key,
  STAGING: {
    fetch: async (request) => {
      upstreamCount++;
      lastRequest = request;
      return new Response("manifest", {
        status: 200,
        headers: { "cache-control": "public, max-age=300" },
      });
    },
  },
};
const query = async (path, init = {}, overrides = {}) =>
  gateway.fetch(new Request(host + path, init), { ...env, ...overrides });

const one = await query("/manifest.webmanifest");
assert.equal(one.status, 401);
assert.equal(upstreamCount, 0, "No unauthenticated static bytes can reach service binding");

const wrong = await query("/manifest.webmanifest", {
  headers: { authorization: "Bearer " + "b".repeat(64) },
});
assert.equal(wrong.status, 401);
assert.equal(upstreamCount, 0);

const missing = await query("/manifest.webmanifest", {}, { COVE_SSR_STAGING_GATE_KEY: "" });
assert.equal(missing.status, 503);
assert.equal(upstreamCount, 0);

const wrongHost = await gateway.fetch(
  new Request("https://unrelated.example/manifest.webmanifest"),
  env,
);
assert.equal(wrongHost.status, 404);
assert.equal(upstreamCount, 0);

const approved = { headers: { authorization: "Bearer " + key } };
const manifest = await query("/manifest.webmanifest", approved);
assert.equal(manifest.status, 200);
assert.equal(await manifest.text(), "manifest");
assert.match(manifest.headers.get("cache-control") || "", /no-store/);
assert.equal(manifest.headers.get("x-robots-tag"), "noindex, nofollow, noarchive");
assert.match(
  manifest.headers.get("server-timing") || "",
  /cove_gateway;dur=\d+(?:\.\d+)?/,
  "The protected gateway must expose numeric owner-side timing for cold attribution",
);
assert.equal(lastRequest.headers.get("authorization"), "Bearer " + key);

const mutation = await query("/api/fore/cart/item", {
  method: "POST",
  headers: approved.headers,
});
assert.equal(mutation.status, 405);
assert.equal(upstreamCount, 1, "Even valid bearer cannot write through read-only gateway");

const unavailable = await query("/", approved, { STAGING: undefined });
assert.equal(unavailable.status, 503);
assert.equal(upstreamCount, 1);

const redirected = await query("/", approved, {
  STAGING: { fetch: async () => Response.redirect("https://example.org/") },
});
assert.equal(redirected.status, 502, "Unreviewed upstream redirect must fail closed");

const outage = await query("/", approved, {
  STAGING: {
    fetch: async () => {
      throw Error("upstream unavailable");
    },
  },
});
assert.equal(outage.status, 503);
assert.equal(outage.headers.get("cache-control"), "no-store, max-age=0");
console.log(
  "PASS: isolated asset-less gateway denies unauthorized assets, writes, redirects, and missing backends",
);
