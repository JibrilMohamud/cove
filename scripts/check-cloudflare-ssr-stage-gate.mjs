import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { build } from "esbuild";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cove-staging-gate-"));
try {
  await build({
    entryPoints: ["src/lib/cloudflare-ssr-stage-gate.server.ts"],
    bundle: true,
    platform: "browser",
    format: "esm",
    outfile: path.join(dir, "gate.mjs"),
    logLevel: "silent",
  });
  const { rejectUnauthenticatedStagingRequest, stageNoStore, isStagingStaticAsset } = await import(
    path.join(dir, "gate.mjs")
  );
  const token = "a".repeat(64);
  const env = { COVE_SSR_STAGING: "1", COVE_SSR_STAGING_GATE_KEY: token };
  const request = (headers = {}, method = "GET") =>
    new Request("https://cove.test/", { method, headers });
  assert.equal(await rejectUnauthenticatedStagingRequest(request(), {}), null);
  const missing = await rejectUnauthenticatedStagingRequest(request(), env);
  assert.equal(missing.status, 401);
  const wrong = await rejectUnauthenticatedStagingRequest(
    request({ Authorization: "Bearer " + "b".repeat(64) }),
    env,
  );
  assert.equal(wrong.status, 401);
  const authorized = await rejectUnauthenticatedStagingRequest(
    request({ Authorization: "Bearer " + token }),
    env,
  );
  assert.equal(authorized, null);
  const attemptedWrite = await rejectUnauthenticatedStagingRequest(
    request({ Authorization: "Bearer " + token }, "POST"),
    env,
  );
  assert.equal(attemptedWrite.status, 405);
  // No public bearer bypass for general checkout or account mutation. The
  // only explicit exception is a QA Stripe webhook, which is subsequently
  // authenticated by the actual signed-HMAC commerce handler.
  const qa = {
    ...env,
    COVE_SSR_STAGING_COMMERCE_QA: "1",
    COVE_STRIPE_SIGNED_WEBHOOK_QA_ENABLED: "1",
  };
  const qaUrl = "https://cove-commerce-customer-qa-stage.cove-jibrilmohamud.workers.dev";
  const webhook = (url = qaUrl + "/api/fore/stripe/webhook", headers = {}) =>
    new Request(url, { method: "POST", headers });
  const stripeHeaders = {
    "content-type": "application/json",
    "stripe-signature": "t=1234567890,v1=" + "f".repeat(64),
  };
  assert.equal(
    await rejectUnauthenticatedStagingRequest(webhook(undefined, stripeHeaders), qa),
    null,
    "Only configured isolated QA Stripe POST reaches mandatory HMAC verification",
  );
  for (const [req, vars] of [
    [webhook(), qa],
    [webhook(undefined, { "stripe-signature": stripeHeaders["stripe-signature"] }), qa],
    [webhook(undefined, { "content-type": "application/json" }), qa],
    [webhook(qaUrl + "/api/fore/checkout/payment", stripeHeaders), qa],
    [webhook("https://www.covereads.com/api/fore/stripe/webhook", stripeHeaders), qa],
    [webhook(undefined, stripeHeaders), { ...qa, COVE_STRIPE_SIGNED_WEBHOOK_QA_ENABLED: "0" }],
    [webhook(undefined, stripeHeaders), { ...qa, COVE_SSR_STAGING_COMMERCE_QA: "0" }],
  ]) {
    const denied = await rejectUnauthenticatedStagingRequest(req, vars);
    assert.equal(denied?.status, 401, "Untrusted QA webhook ingress must be denied");
  }
  const noQaSecret = await rejectUnauthenticatedStagingRequest(webhook(undefined, stripeHeaders), {
    ...qa,
    COVE_SSR_STAGING_GATE_KEY: undefined,
  });
  assert.equal(noQaSecret.status, 503);
  const unconfigured = await rejectUnauthenticatedStagingRequest(
    request({ Authorization: "Bearer " + token }),
    { COVE_SSR_STAGING: "1" },
  );
  assert.equal(unconfigured.status, 503);
  const sealed = stageNoStore(
    new Response("safe", { headers: { "cache-control": "public" } }),
    true,
  );
  assert.match(sealed.headers.get("cache-control"), /no-store/);
  assert.match(sealed.headers.get("x-robots-tag"), /noindex/);
  assert.equal(isStagingStaticAsset("/assets/main.js"), true);
  assert.equal(isStagingStaticAsset("/_build/client.js"), true);
  assert.equal(isStagingStaticAsset("/api/fore/catalog"), false);
  assert.equal(isStagingStaticAsset("/"), false);
  const countrySource = fs.readFileSync("src/lib/cloudflare-country.server.ts", "utf8");
  assert.match(countrySource, /headers\.delete\("x-cove-client-ip"\)/);
  assert.equal(stageNoStore(new Response("ok"), false).headers.get("x-robots-tag"), null);
  const wrangler = fs.readFileSync("wrangler.frontend.staging.toml", "utf8");
  assert.match(wrangler, /^workers_dev\s*=\s*true$/m);
  assert.match(wrangler, /^run_worker_first\s*=\s*true$/m);
  assert.match(wrangler, /\[\[ratelimits\]\][\s\S]*?name = "COVE_STOREFRONT_READ_LIMITER"/);
  assert.match(wrangler, /\[ratelimits\.simple\]\s*\nlimit = 180\s*\nperiod = 60/);
  // This isolated trial now tests default ingress-edge placement, matching
  // the unpublished production candidate rather than Smart Placement.
  // Do not permit a hidden fixed-region or automatic placement override.
  assert.doesNotMatch(wrangler, /^\[placement\]\s*$/m);
  assert.doesNotMatch(wrangler, /^region\s*=|^host\s*=|^hostname\s*=/m);
  assert.match(wrangler, /^COVE_SSR_STAGING\s*=\s*"1"$/m);
  assert.doesNotMatch(wrangler, /COVE_SSR_STAGING_GATE_KEY\s*=/);
  assert.doesNotMatch(wrangler, /^routes?\s*=/m);
  console.log("Cloudflare staging auth, read-only route and asset gate: PASS");
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
