import assert from "node:assert/strict";

const account = "d26430caa63ec55f6612e32f36aca5e9";
const primary = "4bd657ac-8789-403e-a28c-93aba8d0a989";
const secondary = "400c3af3-5d40-41fd-83cc-98228e40ddac";
const bucket = "cove-literary-originals-isolated-20261024";
const publisher = "cove-literary-publisher-isolated-disabled";
const mode = process.argv[2];
assert.ok(mode === "pre" || mode === "post", "Use pre or post");
assert.equal(process.env.CLOUDFLARE_ACCOUNT_ID, account);
const token = process.env.CLOUDFLARE_API_TOKEN;
assert.ok(token, "Protected deployment credential unavailable");
const base = "https://api.cloudflare.com/client/v4/accounts/" + account;
async function api(method, path, body) {
  const response = await fetch(base + path, {
    method,
    headers: {
      authorization: "Bearer " + token,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(30000),
  });
  assert.ok(response.ok, "Publisher verification request failed: " + response.status);
  const data = await response.json();
  assert.equal(data.success, true, "Cloudflare response denied");
  return data.result;
}
async function query(database, sql) {
  const rows = await api("POST", "/d1/database/" + database + "/query", { sql });
  assert.ok(Array.isArray(rows) && rows.every((x) => x.success));
  return rows[0].results;
}
const [owner, frontier] = await Promise.all([
  query(primary, "SELECT value FROM cove_runtime_config WHERE key='literary_processing_owner'"),
  query(secondary, "SELECT status,after_job_id FROM literary_legacy_reconcile_frontier WHERE id=1"),
]);
assert.deepEqual(owner, [], "Publisher deployment forbidden after legacy cutover begins");
assert.deepEqual(frontier, [{ status: "disarmed", after_job_id: "" }]);
for (const [worker, flags] of [
  [
    "cove-literary-handoff-isolated-disabled",
    ["FORE_CONTENT_PROCESSOR_ENABLED", "FORE_CONTENT_HANDOFF_ENABLED"],
  ],
  ["cove-literary-prepare-isolated-disabled", ["FORE_CONTENT_PROCESSOR_ENABLED"]],
  ["cove-literary-infer-isolated-disabled", ["FORE_CONTENT_PROCESSOR_ENABLED"]],
]) {
  const [settings, schedules] = await Promise.all([
    api("GET", "/workers/scripts/" + worker + "/settings"),
    api("GET", "/workers/scripts/" + worker + "/schedules"),
  ]);
  const values = Object.fromEntries(
    settings.bindings.filter((x) => x.type === "plain_text").map((x) => [x.name, x.text]),
  );
  for (const flag of flags) assert.equal(values[flag], "0");
  assert.equal(schedules.schedules.length, 0);
}
if (mode === "post") {
  const [settings, schedules, worker] = await Promise.all([
    api("GET", "/workers/scripts/" + publisher + "/settings"),
    api("GET", "/workers/scripts/" + publisher + "/schedules"),
    api("GET", "/workers/workers/" + publisher),
  ]);
  const bindings = settings.bindings || [];
  const plain = Object.fromEntries(
    bindings.filter((x) => x.type === "plain_text").map((x) => [x.name, x.text]),
  );
  assert.equal(plain.FORE_LITERARY_INFERENCE_PUBLISH_ENABLED, "0");
  assert.ok(
    !bindings.some((x) =>
      [
        "FORE_LITERARY_INFERENCE_PUBLISH_TOKEN_SHA256",
        "FORE_LITERARY_INFERENCE_BACKEND_TOKEN_SHA256",
      ].includes(x.name),
    ),
    "Publisher secrets must be absent during dormant deployment",
  );
  assert.deepEqual(
    bindings
      .filter((x) => x.type === "d1")
      .map((x) => x.database_id)
      .sort(),
    [primary, secondary].sort(),
  );
  assert.deepEqual(
    bindings.filter((x) => x.type === "r2_bucket").map((x) => x.bucket_name),
    [bucket],
  );
  assert.equal(schedules.schedules.length, 0);
  assert.equal(settings.routes?.length || 0, 0);
  assert.equal(worker.subdomain?.enabled, false);
  assert.equal(worker.subdomain?.previews_enabled, false);
}
console.log(
  "LITERARY_DORMANT_PUBLISHER_LIVE_PASS",
  JSON.stringify({ mode, legacyOwner: true, frontierDisarmed: true, publisherDisabled: true }),
);
