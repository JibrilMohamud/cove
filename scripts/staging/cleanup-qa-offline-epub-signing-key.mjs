// Stage-only, fail-closed cleanup of the ephemeral P-256 offline EPUB signer.
// NEVER act on a production or differently named Worker.
import assert from "node:assert/strict";

const account = "d26430caa63ec55f6612e32f36aca5e9";
const worker = "cove-commerce-customer-qa-stage";
const secret = "FORE_OFFLINE_AUDIO_SIGNING_JWK";
const token = process.env.CLOUDFLARE_API_TOKEN;
assert.equal(process.env.CLOUDFLARE_ACCOUNT_ID, account);
assert.ok(token, "Isolated QA Cloudflare API credential required for cleanup");

async function request(method, suffix) {
  const response = await fetch(
    "https://api.cloudflare.com/client/v4/accounts/" + account + "/workers/" + suffix,
    {
      method,
      headers: { authorization: "Bearer " + token },
      signal: AbortSignal.timeout(20000),
    },
  );
  const result = await response.json();
  assert.ok(response.ok && result.success, "Isolated QA signer cleanup Cloudflare API failed");
  return result.result;
}

const workerSettingsPath = "scripts/" + worker + "/settings";
const hasSigner = (settings) =>
  settings?.bindings?.some((binding) => binding.name === secret && binding.type === "secret_text");
const before = await request("GET", workerSettingsPath);
if (hasSigner(before)) {
  await request("DELETE", "scripts/" + worker + "/secrets/" + secret);
}
const after = await request("GET", workerSettingsPath);
assert.equal(hasSigner(after), false, "QA offline signing secret must not persist after test");
const details = await request("GET", "workers/" + worker);
assert.equal(details.subdomain?.enabled, false, "QA Worker must be private after test");
assert.equal(details.subdomain?.previews_enabled, false, "QA Worker previews must be disabled");
console.log(
  "PASS: isolated QA offline signer destroyed and QA workers.dev/preview exposure disabled",
);
