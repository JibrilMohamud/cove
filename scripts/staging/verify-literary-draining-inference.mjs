import assert from "node:assert/strict";
const account = "d26430caa63ec55f6612e32f36aca5e9";
const primary = "4bd657ac-8789-403e-a28c-93aba8d0a989";
const secondary = "400c3af3-5d40-41fd-83cc-98228e40ddac";
const worker = "cove-literary-infer-draining-20261025";
assert.equal(process.env.CLOUDFLARE_ACCOUNT_ID, account);
assert.equal(process.env.GITHUB_REF, "refs/heads/main");
const token = process.env.CLOUDFLARE_API_TOKEN;
assert.ok(token);
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
  assert.ok(response.ok);
  const json = await response.json();
  assert.equal(json.success, true);
  return json.result;
}
async function query(db, sql) {
  const response = await api("POST", "/d1/database/" + db + "/query", { sql });
  assert.ok(Array.isArray(response) && response.every((item) => item.success));
  return response[0]?.results || [];
}
const [settings, schedules, workerInfo] = await Promise.all([
  api("GET", "/workers/scripts/" + worker + "/settings"),
  api("GET", "/workers/scripts/" + worker + "/schedules"),
  api("GET", "/workers/workers/" + worker),
]);
const bindings = settings.bindings || [];
const vars = Object.fromEntries(
  bindings.filter((x) => x.type === "plain_text").map((x) => [x.name, x.text]),
);
for (const key of [
  "FORE_CONTENT_PROCESSOR_ENABLED",
  "FORE_CONTENT_PREPARE_ENABLED",
  "FORE_CONTENT_INFERENCE_ENABLED",
])
  assert.equal(vars[key], "1");
assert.equal(vars.FORE_LITERARY_AUTOPUBLISH_ENABLED, "0");
assert.equal(vars.FORE_CONTENT_BUDGET_MODE, "isolated");
assert.equal(vars.FORE_CONTENT_D1_ADMISSION_MAX_MS, "100");
assert.equal(workerInfo.subdomain?.enabled, false);
assert.equal(workerInfo.subdomain?.previews_enabled, false);
assert.equal(settings.routes?.length || 0, 0);
assert.deepEqual(
  schedules.schedules.map((x) => x.cron),
  ["* * * * *"],
);
assert.ok(bindings.some((x) => x.name === "AI" && x.type === "ai"));
for (let attempt = 0; attempt < 72; attempt++) {
  const [owner, complete, failed] = await Promise.all([
    query(
      primary,
      "SELECT key,value FROM cove_runtime_config WHERE key IN ('literary_processing_owner','literary_budget_domain')",
    ),
    query(secondary, "SELECT COUNT(*) n FROM literary_inference_jobs WHERE status='done'"),
    query(secondary, "SELECT COUNT(*) n FROM literary_inference_jobs WHERE status='failed'"),
  ]);
  assert.deepEqual(Object.fromEntries(owner.map((x) => [x.key, x.value])), {
    literary_budget_domain: "isolated",
    literary_processing_owner: "draining",
  });
  if (complete[0]?.n >= 1) {
    console.log(
      "LITERARY_REAL_INFERENCE_PASS",
      JSON.stringify({
        completed: complete[0].n,
        failed: failed[0]?.n || 0,
        publicationDisabled: true,
        utc: new Date().toISOString(),
      }),
    );
    process.exit(0);
  }
  if (failed[0]?.n >= 3) throw Error("repeated_inference_failed");
  await new Promise((resolve) => setTimeout(resolve, 15000));
}
throw Error("real_inference_not_observed_in_cron_window");
