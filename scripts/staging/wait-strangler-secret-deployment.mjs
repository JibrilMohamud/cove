import assert from "node:assert/strict";
import { latestSecretDeploymentStatus } from "../cloudflare-deployment-readiness.mjs";

const token = process.env.CLOUDFLARE_API_TOKEN || "";
const account = process.env.CLOUDFLARE_ACCOUNT_ID || "";
const rotated = Number(process.env.COVE_STAGE_SECRET_ROTATION_EPOCH_MS);
assert.match(account, /^[0-9a-f]{32}$/);
assert.ok(token.length >= 20);
assert.ok(Number.isFinite(rotated) && rotated > 0);
const url =
  "https://api.cloudflare.com/client/v4/accounts/" +
  account +
  "/workers/scripts/cove-strangler-m1-staging/deployments";
const deadline = Date.now() + 120_000;
while (Date.now() < deadline) {
  const response = await fetch(url, {
    headers: { authorization: "Bearer " + token },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw Error("Thin stage control-plane check failed: " + response.status);
  const data = await response.json();
  if (!data.success) throw Error("Thin stage control-plane result unavailable");
  if (latestSecretDeploymentStatus(data, rotated, Date.now(), 30_000).ready) {
    console.log("COVE_STRANGLER_COLD_READY: new 100% secret deployment settled without HTTP warmup");
    process.exit(0);
  }
  await new Promise((resolve) => setTimeout(resolve, 2000));
}
throw Error("Protected thin stage never settled after secret rotation");
