import assert from "node:assert/strict";

// Only test ephemeral owned-domain staging; every request is read-only except
// an expected 405 mutation. No retries or excluded samples for latency data.
const origin = "https://ssr-canary.covereads.com";
const secret = process.env.COVE_GATE_TEST_BEARER;
assert.match(secret || "", /^[a-f0-9]{64}$/, "Ephemeral test bearer missing");
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function query(path, init = {}) {
  return fetch(origin + path, {
    ...init,
    redirect: "manual",
    signal: AbortSignal.timeout(15_000),
  });
}

// Propagation readiness probes never call SSR; they are unauthenticated
// manifest-only requests rejected by the assets-less gateway before service.
let ready = false;
for (let i = 0; i < 18; i++) {
  try {
    const res = await query("/manifest.webmanifest");
    const code = res.status;
    await res.body?.cancel();
    if (code === 401) {
      ready = true;
      break;
    }
    if (code === 200) throw Error("Public canary manifest escaped authentication");
  } catch (error) {
    if (String(error).includes("escaped authentication")) throw error;
  }
  await pause(10_000);
}
assert.ok(ready, "Owned-domain TLS and fail-closed gateway never became ready");
const observations = [];
for (const path of [
  "/",
  "/manifest.webmanifest",
  "/manifest.webmanifest?public=1",
  "/covers/5200.jpg",
  "/assets/Shelves-D_7vVD5j.js",
  "/favicon.ico",
  "/api/fore/account",
]) {
  for (const credentials of [undefined, "Bearer " + "0".repeat(64)]) {
    const res = await query(path, {
      headers: credentials ? { authorization: credentials } : undefined,
    });
    observations.push({ path, status: res.status, credentialValid: false });
    assert.equal(res.status, 401, "Unprotected owned-canary path: " + path);
    assert.match(res.headers.get("cache-control") || "", /no-store/);
    assert.match(res.headers.get("x-robots-tag") || "", /noindex/);
    assert.equal(res.headers.get("location"), null);
    await res.body?.cancel();
  }
}
const authorized = await query("/manifest.webmanifest", {
  headers: { authorization: "Bearer " + secret },
});
assert.equal(authorized.status, 200, "Signed canary must reach internal SSR asset");
assert.match(authorized.headers.get("cache-control") || "", /no-store/);
await authorized.body?.cancel();
const deniedPost = await query("/api/fore/cart/item", {
  method: "POST",
  headers: { authorization: "Bearer " + secret },
});
assert.equal(deniedPost.status, 405, "Canary must remain read-only");
await deniedPost.body?.cancel();
console.log(
  "PASS: owned TLS SSR canary authenticated before assets, denies forged tokens and mutation",
);
console.log(JSON.stringify(observations));
