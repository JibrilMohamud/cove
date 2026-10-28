import assert from "node:assert/strict";

// The custom-domain binding was detached after a static asset bypassed auth.
// Prove the original Workers.dev staging ingress fails closed before any
// future candidate custom-domain binding can be safely reattempted.
const ownedCanary =
  "https://cove-storefront-ssr-staging.cove-jibrilmohamud.workers.dev";
const requests = [
  { path: "/", method: "GET" },
  { path: "/", method: "HEAD" },
  { path: "/_build/does-not-exist.js", method: "GET" },
  { path: "/api/fore/account", method: "GET" },
  { path: "/api/fore/cart/item", method: "POST" },
  { path: "/manifest.webmanifest", method: "GET" },
];
const observations = [];
for (const spec of requests) {
  const response = await fetch(ownedCanary + spec.path, {
    method: spec.method,
    redirect: "manual",
    headers: { accept: "text/plain" },
    signal: AbortSignal.timeout(12_000),
  });
  const observed = { path: spec.path, method: spec.method, status: response.status };
  observations.push(observed);
  assert.equal(
    response.status,
    401,
    "Protected, owned Cloudflare SSR canary must deny unauthenticated " + spec.method + " " + spec.path,
  );
  assert.match(response.headers.get("cache-control") || "", /no-store/);
  assert.match(response.headers.get("x-robots-tag") || "", /noindex/);
  assert.ok(
    !response.headers.has("location"),
    "A protected staging request must not redirect to Vercel or a public page",
  );
  await response.body?.cancel();
}
console.log("PASS: original staging ingress denied public, static, account and mutation requests; owned-domain binding remains disabled");
console.log(JSON.stringify(observations));
