import assert from "node:assert/strict";
import { build } from "esbuild";

const built = await build({
  entryPoints: ["src/lib/cloudflare-ssr-stage-gate.server.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  write: false,
  logLevel: "silent",
});
const { rejectUnauthenticatedStagingRequest: check } = await import(
  "data:text/javascript;base64," + Buffer.from(built.outputFiles[0].contents).toString("base64")
);
const token = "b".repeat(64);
const secretEnv = { COVE_SSR_STAGING: "1", COVE_SSR_STAGING_GATE_KEY: token };
const qaEnv = { ...secretEnv, COVE_SSR_STAGING_COMMERCE_QA: "1" };
const origin = "https://cove-commerce-customer-qa-stage.cove-jibrilmohamud.workers.dev";
function req(path, method = "POST", authorized = true, host = origin) {
  return new Request(host + path, {
    method,
    headers: authorized ? { authorization: "Bearer " + token } : {},
  });
}
const allowed = [
  "/api/fore/auth/login",
  "/api/fore/cart/item",
  "/api/fore/checkout/quote",
  "/api/fore/checkout/payment",
  "/api/fore/delivery/epub/grant",
  "/api/fore/account/device/register",
  "/api/fore/account/device/revoke",
  "/api/fore/offline-epub/license",
  "/api/fore/stripe/webhook",
  "/api/fore/admin/commerce/refund",
];
for (const path of allowed) {
  assert.equal(await check(req(path), qaEnv), null, "QA endpoint must be available: " + path);
  assert.equal((await check(req(path), secretEnv)).status, 405, "All old stages stay read-only");
  assert.equal((await check(req(path, "POST", false), qaEnv)).status, 401);
  assert.equal(
    (await check(req(path, "POST", true, "https://other-qa.workers.dev"), qaEnv)).status,
    405,
  );
}
for (const path of [
  "/api/fore/auth/signup",
  "/api/fore/admin/staff/bootstrap",
  "/api/fore/delivery/grant/revoke",
  "/api/fore/checkout/payment/override",
  "/api/fore/stripe/webhook/evil",
  "/api/fore/account/export",
]) {
  assert.equal((await check(req(path), qaEnv)).status, 405, "Unexpected write route " + path);
}
for (const method of ["PUT", "DELETE", "PATCH", "OPTIONS"])
  assert.equal((await check(req(allowed[0], method), qaEnv)).status, 405);
assert.equal(await check(req("/api/fore/catalog", "GET"), qaEnv), null);
assert.equal(
  (
    await check(req(allowed[0]), {
      COVE_SSR_STAGING: "1",
      COVE_SSR_STAGING_COMMERCE_QA: "1",
    })
  ).status,
  503,
);
assert.equal(await check(req(allowed[0]), {}), null);
console.log(
  "PASS: only exact QA host + rotating bearer + explicit POST allowlist; all other stages read-only.",
);
