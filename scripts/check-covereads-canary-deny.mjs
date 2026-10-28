import assert from "node:assert/strict";

// Test only an isolated, assets-less auth gateway. NEVER test the known
// vulnerable assets-bound staging Worker as though it were a secure ingress.
const origin = "https://cove-asset-auth-gateway.cove-jibrilmohamud.workers.dev";
const configured = process.env.COVE_SSR_PROTECTED_TEST_ORIGIN;
assert.equal(configured, origin, "Isolated gateway origin must be exact");
const token = process.env.COVE_GATE_TEST_BEARER;
assert.match(token || "", /^[a-f0-9]{64}$/, "Ephemeral shared bearer is required");
const tests = [
  { path: "/", method: "GET" },
  { path: "/", method: "HEAD" },
  { path: "/manifest.webmanifest", method: "GET" },
  { path: "/manifest.webmanifest?cache=1", method: "GET" },
  { path: "/assets/Shelves-D_7vVD5j.js", method: "GET" },
  { path: "/covers/5200.jpg", method: "GET" },
  { path: "/favicon.ico", method: "GET" },
  { path: "/api/fore/account", method: "GET" },
  { path: "/api/fore/cart/item", method: "POST" },
];
const outcomes = [];
for (const test of tests) {
  for (const authorization of [undefined, "Bearer " + "0".repeat(64)]) {
    const response = await fetch(origin + test.path, {
      method: test.method,
      redirect: "manual",
      headers: authorization ? { authorization } : undefined,
      signal: AbortSignal.timeout(15_000),
    });
    outcomes.push({
      path: test.path,
      method: test.method,
      authenticated: false,
      status: response.status,
    });
    assert.equal(response.status, 401, "Missing/invalid bearer bypassed gateway on " + test.path);
    assert.match(response.headers.get("cache-control") || "", /no-store/);
    assert.match(response.headers.get("x-robots-tag") || "", /noindex/);
    assert.equal(response.headers.get("location"), null, "Gateway must not redirect");
    await response.body?.cancel();
  }
}
const authorized = await fetch(origin + "/manifest.webmanifest", {
  headers: { authorization: "Bearer " + token },
  redirect: "manual",
  signal: AbortSignal.timeout(20_000),
});
assert.equal(authorized.status, 200, "Valid bearer must reach the actual SSR asset service");
assert.match(authorized.headers.get("cache-control") || "", /no-store/);
assert.match(authorized.headers.get("x-robots-tag") || "", /noindex/);
await authorized.body?.cancel();
// Direct access to the asset-bound Worker must be disabled, even though
// the inner service still works through the private gateway binding.
const privateStage = await fetch(
  "https://cove-asset-auth-stage.cove-jibrilmohamud.workers.dev/manifest.webmanifest",
  { redirect: "manual", signal: AbortSignal.timeout(12_000) },
);
assert.notEqual(privateStage.status, 200, "Private asset backend is still publicly exposed");
await privateStage.body?.cancel();

const mutation = await fetch(origin + "/api/fore/cart/item", {
  method: "POST",
  headers: { authorization: "Bearer " + token },
  redirect: "manual",
  signal: AbortSignal.timeout(15_000),
});
assert.equal(mutation.status, 405, "Read-only gateway must prevent even signed mutations");
await mutation.body?.cancel();
console.log(
  "PASS: isolated assets-less Worker rejects anonymous/forged homepage, real static assets, account and mutations",
);
console.log(JSON.stringify(outcomes));
