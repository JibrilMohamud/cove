import assert from "node:assert/strict";
const account = "d26430caa63ec55f6612e32f36aca5e9";
const script = "cove-literary-infer-draining-20261025";
assert.equal(process.env.CLOUDFLARE_ACCOUNT_ID, account);
const token = process.env.CLOUDFLARE_API_TOKEN;
assert.ok(token);
const url =
  "https://api.cloudflare.com/client/v4/accounts/" +
  account +
  "/workers/scripts/" +
  script +
  "/schedules";
async function request(method, body) {
  const response = await fetch(url, {
    method,
    headers: {
      authorization: "Bearer " + token,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(30000),
  });
  if (response.status === 404) return null;
  assert.ok(response.ok);
  const result = await response.json();
  assert.equal(result.success, true);
  return result.result;
}
await request("PUT", []);
const latest = await request("GET");
assert.ok(latest === null || (latest.schedules || []).length === 0);
console.log("LITERARY_INFER_ROLLBACK_CRON_REMOVED");
