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
console.log(
  "PASS: zero-default signed-country relay, expired/tampered geo rejection, bounded canary, authenticated-route bypass, origin allowlist",
);
