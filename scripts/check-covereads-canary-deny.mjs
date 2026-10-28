import assert from "node:assert/strict";

const ownedCanary = "https://ssr-canary.covereads.com";
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
console.log("PASS: owned-domain Cloudflare SSR canary denied every public, static, account and mutation request");
console.log(JSON.stringify(observations));
