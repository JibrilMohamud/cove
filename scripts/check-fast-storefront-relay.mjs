import assert from "node:assert/strict";
import { build } from "esbuild";

async function importBundled(path) {
  const result = await build({
    entryPoints: [path],
    bundle: true,
    write: false,
    platform: "node",
    format: "esm",
    target: "es2022",
    logLevel: "silent",
  });
  const code = result.outputFiles[0].text;
  return import("data:text/javascript;base64," + Buffer.from(code).toString("base64"));
}

const relay = await importBundled("src/lib/fast-storefront-relay.server.ts");
const proxy = await importBundled("src/lib/fast-storefront-proxy.server.ts");
const secret = "a".repeat(64);
const now = Date.now();
const claim = {
  country: "US",
  ip: "198.51.100.6",
  timestamp: now,
  nonce: "0".repeat(32),
};
const headers = await relay.signFastCountryClaim(claim, secret);
assert.deepEqual(await relay.verifyFastCountryClaim(headers, secret, now), claim);
const altered = new Headers(headers);
altered.set("x-cove-fast-country", "CA");
assert.equal(await relay.verifyFastCountryClaim(altered, secret, now), null);
const alteredIp = new Headers(headers);
alteredIp.set("x-cove-fast-client", "198.51.100.7");
assert.equal(await relay.verifyFastCountryClaim(alteredIp, secret, now), null);
assert.equal(await relay.verifyFastCountryClaim(headers, "b".repeat(64), now), null);
assert.equal(await relay.verifyFastCountryClaim(headers, secret, now + 20000), null);
assert.equal(await relay.verifyFastCountryClaim(new Headers(), secret, now), null);
await assert.rejects(
  () => relay.signFastCountryClaim({ ...claim, country: "XX" }, secret),
  /Invalid fast storefront/,
);
const vercelHeaders = {
  "x-vercel-ip-country": "US",
  "x-vercel-forwarded-for": "198.51.100.6",
};
const req = (url = "https://cove-puce-theta.vercel.app/", init = {}) =>
  new Request(url, { ...init, headers: { ...vercelHeaders, ...init.headers } });
assert.deepEqual(relay.verifiedVercelClient(req()), { country: "US", ip: "198.51.100.6" });
const bogusGeo = req("https://cove-puce-theta.vercel.app/", {
  headers: { "x-vercel-ip-country": "XX" },
});
assert.equal(relay.verifiedVercelClient(bogusGeo), null);
const preview = {
  VERCEL_ENV: "preview",
  COVE_FAST_STOREFRONT_MODE: "preview",
  COVE_FAST_STOREFRONT_RELEASE_CERTIFIED: "1",
};
const notEligible = (request, env) => assert.equal(proxy.eligibleFastHomepage(request, env), false);
assert.equal(proxy.eligibleFastHomepage(req(), preview), true);
const protectedPreviewRequest = req("https://cove-puce-theta.vercel.app/", {
  headers: { cookie: "_vercel_jwt=" + "a".repeat(64) },
});
assert.equal(
  proxy.eligibleFastHomepage(protectedPreviewRequest, preview),
  true,
  "the Vercel-protected preview login is not a Cove customer session",
);
notEligible(protectedPreviewRequest, {
  ...preview,
  VERCEL_ENV: "production",
  COVE_FAST_STOREFRONT_MODE: "canary",
  COVE_FAST_STOREFRONT_PERCENT: "1",
});
notEligible(
  req("https://cove-puce-theta.vercel.app/", {
    headers: { cookie: "_vercel_jwt=" + "a".repeat(64) + "; fore-auth=customer" },
  }),
  preview,
);
notEligible(
  req("https://cove-puce-theta.vercel.app/", {
    headers: { cookie: "fore-auth=customer; _vercel_jwt=" + "a".repeat(64) },
  }),
  preview,
);
notEligible(
  req("https://cove-puce-theta.vercel.app/", {
    headers: { cookie: "_vercel_jwt=invalid" },
  }),
  preview,
);
notEligible(req(), { ...preview, COVE_FAST_STOREFRONT_RELEASE_CERTIFIED: "0" });
notEligible(req(), { ...preview, VERCEL_ENV: "production" });
notEligible(req("https://cove-puce-theta.vercel.app/search"), preview);
notEligible(req("https://cove-puce-theta.vercel.app/?country=US"), preview);
notEligible(
  req("https://cove-puce-theta.vercel.app/", {
    headers: { cookie: "fore-auth=test" },
  }),
  preview,
);
notEligible(
  req("https://cove-puce-theta.vercel.app/", {
    headers: { authorization: "Bearer demo" },
  }),
  preview,
);
notEligible(req("https://cove-puce-theta.vercel.app/", { method: "POST" }), preview);
assert.equal(await proxy.maybeProxyFastHomepage(req(), {}), null);
const spoofedOrigin = {
  ...preview,
  COVE_FAST_RELAY_KEY: secret,
  COVE_FAST_STOREFRONT_ORIGIN: "https://attacker.example.com/",
};
assert.equal(await proxy.maybeProxyFastHomepage(req(), spoofedOrigin), null);
const missingKey = {
  ...preview,
  COVE_FAST_RELAY_KEY: "invalid",
  COVE_FAST_STOREFRONT_ORIGIN: "https://cove-fast-gateway.cove-jibrilmohamud.workers.dev/",
};
assert.equal(await proxy.maybeProxyFastHomepage(req(), missingKey), null);
for (const percent of ["-1", "0", "2", "3", "4", "5", "6", "100", "abc"]) {
  const canary = {
    ...preview,
    VERCEL_ENV: "production",
    COVE_FAST_STOREFRONT_MODE: "canary",
    COVE_FAST_STOREFRONT_PERCENT: percent,
  };
  notEligible(req(), canary);
}
// A complete HMAC-signed QA proxy response must never become an
// authorization source for cookies, checkout or a forged territory. The
// unchanged SSR application owns the fallback whenever the Worker is ill.
const qa = {
  ...preview,
  COVE_FAST_RELAY_KEY: secret,
  COVE_FAST_STOREFRONT_ORIGIN: "https://cove-fast-gateway.cove-jibrilmohamud.workers.dev/",
};
const actualFetch = globalThis.fetch;
const makeResponse = (status, renderer = "strangler-live", type = "text/html") =>
  new Response("<main>Signed QA storefront</main>", {
    status,
    headers: {
      "x-cove-renderer": renderer,
      "content-type": type,
      "set-cookie": "session=should-not-forward",
    },
  });
try {
  let called = 0;
  globalThis.fetch = async (target, options) => {
    called++;
    assert.equal(target, qa.COVE_FAST_STOREFRONT_ORIGIN);
    assert.equal(options.method, "GET");
    assert.equal(options.redirect, "manual");
    assert.ok(options.signal);
    assert.deepEqual(await relay.verifyFastCountryClaim(options.headers, secret), {
      country: "US",
      ip: "198.51.100.6",
      timestamp: Number(options.headers.get("x-cove-fast-timestamp")),
      nonce: options.headers.get("x-cove-fast-nonce"),
    });
    return makeResponse(200);
  };
  const success = await proxy.maybeProxyFastHomepage(req(), qa);
  assert.equal(success?.status, 200);
  assert.equal(success.headers.get("cache-control"), "private, no-store");
  assert.equal(success.headers.get("set-cookie"), null);
  assert.match(await success.text(), /Signed QA storefront/);
  assert.equal(called, 1);
  notEligible(
    req("https://cove-puce-theta.vercel.app/", { headers: { cookie: "fore-auth=test" } }),
    qa,
  );
  globalThis.fetch = async () => makeResponse(503);
  assert.equal(await proxy.maybeProxyFastHomepage(req(), qa), null, "503 falls back to CORE");
  globalThis.fetch = async () => makeResponse(200, "unverified-renderer");
  assert.equal(await proxy.maybeProxyFastHomepage(req(), qa), null, "renderer spoof fails closed");
  globalThis.fetch = async () => makeResponse(200, "strangler-live", "application/json");
  assert.equal(await proxy.maybeProxyFastHomepage(req(), qa), null, "non-HTML fails closed");
  globalThis.fetch = async () => {
    throw new Error("gateway_unreachable");
  };
  assert.equal(await proxy.maybeProxyFastHomepage(req(), qa), null, "network error falls back");
  assert.equal(
    await proxy.maybeProxyFastHomepage(req(), {
      ...qa,
      COVE_FAST_STOREFRONT_RELEASE_CERTIFIED: "0",
    }),
    null,
    "rollback flag removes routing immediately",
  );
} finally {
  globalThis.fetch = actualFetch;
}

console.log(
  "PASS: zero-default signed-country relay, expired/tampered geo rejection, bounded canary, authenticated-route bypass, origin allowlist, valid signed relay, SSR rollback",
);
