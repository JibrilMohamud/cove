import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { webcrypto } from "node:crypto";

if (!globalThis.crypto) globalThis.crypto = webcrypto;
const { default: gateway } = await import("../src/cloudflare/commerce-qa-ingress.mjs");
const hostname = "cove-commerce-qa-ingress.cove-jibrilmohamud.workers.dev";
const origin = "https://" + hostname;
const token = "a".repeat(64);
let forwarded = 0;
const env = {
  COVE_QA_GATEWAY_HOST: hostname,
  COVE_SSR_STAGING_GATE_KEY: token,
  COVE_QA_SIGNED_WEBHOOK_GATE_ENABLED: "0",
  COMMERCE_QA: {
    fetch: async (request) => {
      forwarded++;
      return new Response("private-qa", {
        status: 200,
        headers: { "cache-control": "public, max-age=300" },
      });
    },
  },
};
const call = (path, init = {}, vars = env) =>
  gateway.fetch(new Request(origin + path, init), vars);
const bearer = { authorization: "Bearer " + token };
for (const path of ["/", "/manifest.webmanifest", "/assets/main.js", "/api/fore/account"]) {
  const response = await call(path);
  assert.equal(response.status, 401, "Every asset and account path must require bearer");
  assert.match(response.headers.get("cache-control") || "", /no-store/);
  assert.equal(response.headers.get("location"), null);
}
assert.equal(forwarded, 0, "Unauthorized requests must never reach the SSR/ASSETS Worker");
const wrongToken = await call("/", { headers: { authorization: "Bearer " + "b".repeat(64) } });
assert.equal(wrongToken.status, 401);
assert.equal(forwarded, 0);
const wrongHost = await gateway.fetch(new Request("https://www.covereads.com/"), env);
assert.equal(wrongHost.status, 404);
const badSecret = await call("/", { headers: bearer }, {
  ...env,
  COVE_SSR_STAGING_GATE_KEY: "",
});
assert.equal(badSecret.status, 503);
assert.equal(forwarded, 0);
const html = await call("/", { headers: bearer });
assert.equal(html.status, 200);
assert.equal(await html.text(), "private-qa");
assert.match(html.headers.get("cache-control") || "", /no-store/);
assert.match(html.headers.get("x-robots-tag") || "", /noindex/);
const cart = await call("/api/fore/cart/item", {
  method: "POST",
  headers: bearer,
});
assert.equal(cart.status, 200, "Authorized QA cart mutation can reach the private application");
const badWrite = await call("/api/fore/admin/arbitrary-sql", {
  method: "POST",
  headers: bearer,
});
assert.equal(badWrite.status, 405, "Unknown write routes are always prohibited");
const unsigned = await call("/api/fore/stripe/webhook", {
  method: "POST",
  headers: { "content-type": "application/json" },
});
assert.equal(unsigned.status, 401);
const stripe = {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "stripe-signature": "t=123456,v1=" + "c".repeat(64),
  },
};
const off = await call("/api/fore/stripe/webhook", stripe);
assert.equal(off.status, 401, "Signed route is disabled by default");
const liveEnv = { ...env, COVE_QA_SIGNED_WEBHOOK_GATE_ENABLED: "1" };
const authorizedStripe = await call("/api/fore/stripe/webhook", stripe, liveEnv);
assert.equal(authorizedStripe.status, 200, "Only the exact future QA Stripe endpoint reaches the HMAC handler");
const afterStripe = forwarded;
for (const invalid of [
  { method: "POST", headers: { "stripe-signature": "t=1,v1=fake" } },
  { method: "POST", headers: { "content-type": "application/json" } },
  { method: "GET", headers: stripe.headers },
]) {
  const denied = await call("/api/fore/stripe/webhook", invalid, liveEnv);
  assert.equal(denied.status, 401);
}
assert.equal(forwarded, afterStripe);
const large = await call("/api/fore/stripe/webhook", {
  method: "POST",
  headers: { ...stripe.headers, "content-length": "1048577" },
}, liveEnv);
assert.equal(large.status, 413);
assert.equal(forwarded, afterStripe);
const redirect = await call("/", { headers: bearer }, {
  ...env,
  COMMERCE_QA: { fetch: async () => Response.redirect("https://stripe.com/") },
});
assert.equal(redirect.status, 502);
const outage = await call("/", { headers: bearer }, {
  ...env,
  COMMERCE_QA: { fetch: async () => { throw Error("downstream unavailable"); } },
});
assert.equal(outage.status, 503);

const config = readFileSync("wrangler.commerce-qa.ingress.toml", "utf8");
assert.match(config, /^workers_dev = false$/m);
assert.match(config, /^preview_urls = false$/m);
assert.match(config, /^binding = "COMMERCE_QA"$/m);
assert.match(config, /^service = "cove-commerce-customer-qa-stage"$/m);
assert.match(config, /^COVE_QA_SIGNED_WEBHOOK_GATE_ENABLED = "0"$/m);
assert.doesNotMatch(config, /^\[assets\]|^\[\[d1_databases\]\]|^\[\[r2_buckets\]\]|^routes?\s*=/m);
const stage = readFileSync("src/lib/cloudflare-ssr-stage-gate.server.ts", "utf8");
assert.match(stage, /COVE_COMMERCE_PRIVATE_GATEWAY_ENABLED === "1"/);
const commerce = readFileSync("src/features/fore/commerce.server.ts", "utf8");
assert.match(commerce, /verifyStripeSignature\(raw, signature, secret\)/);
console.log(
  "PASS: isolated commerce gateway denies anonymous assets, unknown writes, forged hosts and disabled Stripe; private service and signed-only TEST ingress are constrained",
);
