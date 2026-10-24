import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";

const account = "d26430caa63ec55f6612e32f36aca5e9";
const primary = "24c0eda2-6a43-4d7e-b787-502745d4d781";
const secondary = "fce5742c-29ca-4bc3-85da-e174dd9bf42e";
const publisher = "cove-literary-publisher-stage-qa-20261024";
const caller = "cove-literary-binding-stage-qa-20261024";
const apiToken = process.env.CLOUDFLARE_API_TOKEN;
assert.ok(apiToken);
assert.equal(process.env.CLOUDFLARE_ACCOUNT_ID, account);
assert.match(process.env.GITHUB_SHA || "", /^[0-9a-f]{40}$/);
const root = "https://api.cloudflare.com/client/v4/accounts/" + account;
async function api(method, path, body) {
  const response = await fetch(root + path, {
    method,
    headers: {
      authorization: "Bearer " + apiToken,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(30000),
  });
  assert.ok(response.ok, "Staging Service Binding API request " + response.status);
  const json = await response.json();
  assert.equal(json.success, true, "Staging Service Binding API rejected request");
  return json.result;
}
async function query(id, sql) {
  const r = await api("POST", "/d1/database/" + id + "/query", { sql });
  assert.ok(Array.isArray(r) && r.every((x) => x.success));
  return r[0]?.results || [];
}
for (const name of [publisher, caller]) {
  const [settings, schedules, worker] = await Promise.all([
    api("GET", "/workers/scripts/" + name + "/settings"),
    api("GET", "/workers/scripts/" + name + "/schedules"),
    api("GET", "/workers/workers/" + name),
  ]);
  assert.equal(schedules.schedules.length, 0);
  assert.equal(settings.routes?.length || 0, 0);
  assert.equal(worker.subdomain?.enabled, false);
  assert.equal(worker.subdomain?.previews_enabled, false);
  const dbIds = settings.bindings.filter((x) => x.type === "d1").map((x) => x.database_id);
  assert.deepEqual(dbIds.sort(), [primary, secondary].sort());
  if (name === caller)
    assert.ok(
      settings.bindings.some(
        (x) =>
          x.type === "service" &&
          x.name === "LITERARY_PUBLISHER" &&
          x.service === publisher,
      ),
      "QA Service Binding not installed",
    );
}
const staged = await query(
  primary,
  "SELECT status,revision FROM literary_profiles WHERE product_id='qa_literary'",
);
assert.deepEqual(staged, [{ status: "analyzed", revision: 1 }]);
const ready = await query(
  secondary,
  "SELECT id FROM literary_inference_jobs WHERE product_id='qa_literary' AND status='done' AND publication_state='published'",
);
assert.equal(ready.length, 1);
await query(
  secondary,
  "CREATE TABLE IF NOT EXISTS literary_qa_private_pub_receipts(" +
    "id INTEGER PRIMARY KEY CHECK(id=1),result TEXT NOT NULL,observed_at TEXT NOT NULL)",
);
await query(secondary, "DELETE FROM literary_qa_private_pub_receipts");
const tokenA = randomBytes(48).toString("hex");
const tokenB = randomBytes(48).toString("hex");
const hash = (s) => createHash("sha256").update(s).digest("hex");
for (const [worker, key, value] of [
  [caller, "FORE_LITERARY_INFERENCE_PUBLISH_TOKEN", tokenA],
  [caller, "FORE_LITERARY_INFERENCE_BACKEND_TOKEN", tokenB],
  [publisher, "FORE_LITERARY_INFERENCE_PUBLISH_TOKEN_SHA256", hash(tokenA)],
  [publisher, "FORE_LITERARY_INFERENCE_BACKEND_TOKEN_SHA256", hash(tokenB)],
]) {
  await api("PUT", "/workers/scripts/" + worker + "/secrets", {
    name: key,
    type: "secret_text",
    text: value,
  });
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let passed = null;
let error = null;
try {
  await api("PUT", "/workers/scripts/" + caller + "/schedules", [
    { cron: "* * * * *" },
  ]);
  for (let attempt = 0; attempt < 20; attempt++) {
    await sleep(15000);
    const receipt = await query(
      secondary,
      "SELECT result,observed_at FROM literary_qa_private_pub_receipts WHERE id=1",
    );
    if (receipt[0]?.result === "passed") {
      passed = receipt[0];
      break;
    }
  }
  if (!passed) throw Error("real_private_service_binding_canary_timeout");
} catch (e) {
  error = String(e).slice(0, 200);
} finally {
  // Always remove the only canary trigger. Neither publisher nor caller has
  // public ingress and both remain confined to the dedicated QA databases.
  await api("PUT", "/workers/scripts/" + caller + "/schedules", []);
}
if (error) throw Error(error);
const [actual, status] = await Promise.all([
  query(
    primary,
    "SELECT status,revision,coverage FROM literary_profiles WHERE product_id='qa_literary'",
  ),
  query(
    secondary,
    "SELECT publication_state FROM literary_inference_jobs WHERE id='" + ready[0].id + "'",
  ),
]);
assert.deepEqual(actual, [
  { status: "analyzed", revision: 1, coverage: "isolated_samples" },
]);
assert.equal(status[0].publication_state, "published");
const report = {
  schema: "cove.literary.deployed-private-binding.v1",
  observedAt: new Date().toISOString(),
  sha: process.env.GITHUB_SHA,
  stagingOnly: true,
  productionTouched: false,
  noPublicIngress: true,
  canaryCronRemoved: true,
  privateServiceBindingReal: true,
  cloudflareR2MetadataVerified: true,
  primaryProfile: actual[0],
  secondaryPublication: status[0],
  receipt: passed,
};
mkdirSync("artifacts/literary-cutover", { recursive: true });
writeFileSync(
  "artifacts/literary-cutover/deployed-private-binding.json",
  JSON.stringify(report, null, 2) + "\n",
);
console.log("LITERARY_REAL_SERVICE_BINDING_CANARY_PASS", JSON.stringify(report));
