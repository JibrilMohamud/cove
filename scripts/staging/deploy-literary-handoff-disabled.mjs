import assert from "node:assert/strict";
import fs from "node:fs";
import { spawnSync } from "node:child_process";

const account = "d26430caa63ec55f6612e32f36aca5e9";
const primary = "4bd657ac-8789-403e-a28c-93aba8d0a989";
const secondary = "400c3af3-5d40-41fd-83cc-98228e40ddac";
const bucket = "cove-literary-originals-isolated-20261024";
const name = "cove-literary-handoff-isolated-disabled";
const token = process.env.CLOUDFLARE_API_TOKEN;
assert.equal(process.env.CLOUDFLARE_ACCOUNT_ID, account);
assert.ok(token, "Cloudflare deploy credential unavailable");
const file = "wrangler.content-literary-handoff.prod-disabled.jsonc";
const config = JSON.parse(fs.readFileSync(file, "utf8"));
assert.equal(config.name, name);
assert.equal(config.workers_dev, false);
assert.equal(config.preview_urls, false);
assert.equal(config.vars.FORE_CONTENT_PROCESSOR_ROLE, "literary-handoff");
assert.deepEqual(
  config.d1_databases.map((x) => x.database_id),
  [secondary],
);
assert.deepEqual(
  config.r2_buckets.map((x) => x.bucket_name),
  [bucket],
);
for (const key of [
  "FORE_CONTENT_PROCESSOR_ENABLED",
  "FORE_CONTENT_PREPARE_ENABLED",
  "FORE_CONTENT_HANDOFF_ENABLED",
  "FORE_LITERARY_DRAIN_RECONCILE_ENABLED",
])
  assert.equal(config.vars[key], "0", "Unarmed Worker must remain fully disabled: " + key);
assert.ok(
  !config.triggers && !config.routes && !config.route && !config.queues,
  "No cron, public route or queue may start the disabled handoff Worker",
);

async function request(method, path, body) {
  const response = await fetch("https://api.cloudflare.com/client/v4" + path, {
    method,
    headers: {
      authorization: "Bearer " + token,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(30000),
  });
  const data = await response.json();
  assert.ok(
    response.ok && data.success,
    "Isolated handoff API rejected " + method + " " + response.status,
  );
  return data.result;
}
const query = (db, sql) =>
  request("POST", `/accounts/${account}/d1/database/${db}/query`, { sql }).then(
    (x) => x[0].results,
  );
const [identity, frontier, productionOwner] = await Promise.all([
  query(secondary, "SELECT domain,schema_version FROM literary_budget_domain_identity WHERE id=1"),
  query(secondary, "SELECT status,after_job_id FROM literary_legacy_reconcile_frontier WHERE id=1"),
  query(primary, "SELECT value FROM cove_runtime_config WHERE key='literary_processing_owner'"),
]);
assert.deepEqual(identity, [{ domain: "cove-isolated-literary-budget", schema_version: 1 }]);
assert.equal(frontier[0]?.status, "disarmed", "No handoff may be armed during deployment");
assert.equal(frontier[0]?.after_job_id, "");
assert.equal(productionOwner.length, 0, "Legacy production ownership must not change");
const migration = await query(
  primary,
  "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('literary_prepare_outbox','literary_prepared_evidence') ORDER BY name",
);
assert.deepEqual(
  migration.map((x) => x.name),
  ["literary_prepare_outbox", "literary_prepared_evidence"],
);
const result = spawnSync(
  "npm",
  ["exec", "--yes", "--package=wrangler@4.151.0", "--", "wrangler", "deploy", "--config", file],
  {
    env: { ...process.env, CLOUDFLARE_SEND_METRICS: "false" },
    encoding: "utf8",
    timeout: 180000,
  },
);
if (result.status !== 0)
  throw Error(
    "Disabled literary handoff deployment failed: " +
      String(result.stderr || result.error?.message || "")
        .replace(/Bearer\s+\S+/g, "Bearer [redacted]")
        .slice(-550),
  );
let observed = false;
for (let i = 0; i < 10; i++) {
  const [settings, worker] = await Promise.all([
    request("GET", `/accounts/${account}/workers/scripts/${name}/settings`),
    request("GET", `/accounts/${account}/workers/workers/${name}`),
  ]);
  const bindings = settings.bindings || [];
  const get = (key) => bindings.find((b) => b.name === key);
  const ids = bindings.filter((b) => b.type === "d1").map((b) => b.database_id ?? b.id);
  const r2 = bindings.filter((b) => b.type === "r2_bucket").map((b) => b.bucket_name);
  const disabled = [
    "FORE_CONTENT_PROCESSOR_ENABLED",
    "FORE_CONTENT_PREPARE_ENABLED",
    "FORE_CONTENT_HANDOFF_ENABLED",
    "FORE_LITERARY_DRAIN_RECONCILE_ENABLED",
  ].every((key) => get(key)?.text === "0");
  if (
    !ids.includes(primary) &&
    ids.includes(secondary) &&
    ids.length === 1 &&
    r2.length === 1 &&
    r2[0] === bucket &&
    get("FORE_CONTENT_PROCESSOR_ROLE")?.text === "literary-handoff" &&
    disabled &&
    !worker.subdomain?.enabled &&
    !worker.subdomain?.previews_enabled &&
    !settings.routes?.length
  ) {
    observed = true;
    break;
  }
  await new Promise((resolve) => setTimeout(resolve, 1600));
}
assert.ok(observed, "Disabled handoff Worker did not converge to nonpublic isolated bindings");
console.log(
  "LITERARY_PROD_HANDOFF_DORMANT_PASS separate CONTENT_DB/R2, required schema, primary remains legacy, no cron, no routes, processing OFF",
);
