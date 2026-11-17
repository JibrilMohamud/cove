import assert from "node:assert/strict";
import { latestSecretDeploymentStatus } from "../cloudflare-deployment-readiness.mjs";

const token = process.env.CLOUDFLARE_API_TOKEN;
const account = "d26430caa63ec55f6612e32f36aca5e9";
const originMs = Number(process.env.COVE_STAGE_SECRET_ROTATION_EPOCH_MS);
assert.ok(typeof token === "string" && token.length >= 20);
assert.ok(Number.isFinite(originMs) && originMs > 0);
const endpoint =
  "https://api.cloudflare.com/client/v4/accounts/" +
  account +
  "/workers/scripts/cove-storefront-phase-staging/deployments";
const deadline = Date.now() + 120_000;
let ready = false;
while (Date.now() < deadline) {
  const response = await fetch(endpoint, {
    method: "GET",
    redirect: "error",
    headers: { authorization: "Bearer " + token },
    signal: AbortSignal.timeout(10_000),
  });
  assert.ok(response.ok, "Stage Worker deployment control-plane verification failed");
  const payload = await response.json();
  assert.equal(payload.success, true);
  if (latestSecretDeploymentStatus(payload, originMs, Date.now()).ready) {
    ready = true;
    break;
  }
  await new Promise((resolve) => setTimeout(resolve, 2_000));
}
assert.ok(ready, "Stage secret version did not settle at 100 percent");
console.log("PASS: isolated stage bearer deployment settled without prewarming HTTP");
