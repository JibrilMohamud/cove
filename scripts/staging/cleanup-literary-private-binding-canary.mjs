import assert from "node:assert/strict";

const account = "f51e8ccbc394e2d6016ff8c2c303d54b";
const worker = "cove-literary-binding-stage-qa-20261024";
assert.equal(process.env.CLOUDFLARE_ACCOUNT_ID, account);
const token = process.env.COVE_CF_QA_WORKERS_DEPLOY_TOKEN;
assert.ok(token, "Protected QA deploy credential unavailable for cron cleanup");
assert.ok(!process.env.CLOUDFLARE_API_TOKEN);
const endpoint =
  "https://api.cloudflare.com/client/v4/accounts/" +
  account +
  "/workers/scripts/" +
  worker +
  "/schedules";
async function send(method, body) {
  const response = await fetch(endpoint, {
    method,
    headers: {
      authorization: "Bearer " + token,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  });
  if (response.status === 404) return null;
  assert.ok(response.ok, "Private QA cron cleanup rejected: " + response.status);
  const result = await response.json();
  assert.equal(result.success, true);
  return result.result;
}
const current = await send("GET");
if (current !== null) {
  await send("PUT", []);
  const verified = await send("GET");
  assert.equal(verified?.schedules?.length, 0, "Private QA cron still attached");
}
console.log("LITERARY_QA_CRON_CLEANUP_PASS no scheduled staging QA worker");
