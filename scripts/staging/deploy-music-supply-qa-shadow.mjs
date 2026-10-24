import assert from "node:assert/strict";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { build } from "esbuild";

const account = "d26430caa63ec55f6612e32f36aca5e9";
const musicDb = "fe9a9dd2-64b8-451c-a356-9ec71d9ee211";
const primary = "4bd657ac-8789-403e-a28c-93aba8d0a989";
const name = "cove-music-supply-isolated-qa";
assert.equal(process.env.CLOUDFLARE_ACCOUNT_ID, account);
assert.ok(process.env.CLOUDFLARE_API_TOKEN);
const config = JSON.parse(fs.readFileSync("wrangler.music-supply.qa.jsonc", "utf8"));
assert.equal(config.name, name);
assert.equal(config.workers_dev, false);
assert.equal(config.preview_urls, false);
for (const name of [
  "MUSIC_SUPPLY_ENABLED",
  "MUSIC_ANALYSIS_ENABLED",
  "MUSIC_EXECUTION_ENABLED",
  "MUSIC_AUTO_QUIET_APPROVAL",
]) {
  assert.equal(config.vars[name], "0", name + " must be disabled on the hosted shadow");
}
assert.ok(!config.routes && !config.route && !config.triggers && !config.queues);
assert.deepEqual(
  config.d1_databases.map((x) => x.database_id),
  [musicDb],
);
assert.deepEqual(
  config.r2_buckets.map((x) => x.bucket_name),
  ["cove-music-supply-qa-20261023"],
);
await build({
  entryPoints: ["src/music-supply/worker.ts"],
  bundle: true,
  platform: "browser",
  format: "esm",
  target: "es2022",
  outfile: ".output/music-supply/worker.mjs",
  logLevel: "silent",
});
const run = spawnSync(
  "npm",
  [
    "exec",
    "--yes",
    "--package=wrangler@4.151.0",
    "--",
    "wrangler",
    "deploy",
    "--config",
    "wrangler.music-supply.qa.jsonc",
  ],
  {
    encoding: "utf8",
    timeout: 180000,
    env: {
      ...process.env,
      CLOUDFLARE_SEND_METRICS: "false",
    },
  },
);
if (run.status !== 0)
  throw Error(
    "Nonpublic music Worker deployment failed: " +
      String(run.stderr || "")
        .replace(/Bearer\s+\S+/g, "Bearer [redacted]")
        .slice(-550),
  );
// Wrangler completion and the global account settings view can be briefly
// out of sync. Re-read the exact script until the disabled D1/R2-only
// settings have propagated; never mistake an absent binding for success.
let certified = false;
for (let attempt = 0; attempt < 8; attempt++) {
  const result = await fetch(
    "https://api.cloudflare.com/client/v4/accounts/" +
      account +
      "/workers/scripts/" +
      name +
      "/settings",
    {
      headers: { authorization: "Bearer " + process.env.CLOUDFLARE_API_TOKEN },
      signal: AbortSignal.timeout(20000),
    },
  );
  const settings = await result.json();
  assert.ok(result.ok && settings.success, "Cloudflare Worker settings unavailable");
  const bindings = settings.result?.bindings || [];
  const get = (binding) => bindings.find((x) => x.name === binding);
  assert.ok(!bindings.some((x) => x.name === "DB" || x.database_id === primary));
  assert.equal(settings.result?.routes?.length || 0, 0);
  assert.deepEqual(
    bindings.filter((x) => x.type === "d1").map((x) => x.database_id),
    [musicDb],
    "Hosted worker may bind only the isolated MUSIC_DB",
  );
  assert.deepEqual(
    bindings.filter((x) => x.type === "r2_bucket").map((x) => x.bucket_name),
    ["cove-music-supply-qa-20261023"],
    "Hosted worker may bind only the isolated MUSIC_BUCKET",
  );
  if (
    get("MUSIC_DB")?.database_id === musicDb &&
    get("MUSIC_BUCKET")?.bucket_name === "cove-music-supply-qa-20261023" &&
    [
      "MUSIC_SUPPLY_ENABLED",
      "MUSIC_ANALYSIS_ENABLED",
      "MUSIC_EXECUTION_ENABLED",
      "MUSIC_AUTO_QUIET_APPROVAL",
    ].every((name) => get(name)?.text === "0")
  ) {
    certified = true;
    break;
  }
  await new Promise((resolve) => setTimeout(resolve, 1500));
}
assert.ok(certified, "Isolated disabled music Worker bindings never converged");

// Migration readiness is verified with a read-only query; deployments never
// migrate production D1, seed supposed rights, or enable pipeline processors.
const schema = await fetch(
  "https://api.cloudflare.com/client/v4/accounts/" + account + "/d1/database/" + musicDb + "/query",
  {
    method: "POST",
    headers: {
      authorization: "Bearer " + process.env.CLOUDFLARE_API_TOKEN,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      sql: "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'music_%' ORDER BY name",
    }),
    signal: AbortSignal.timeout(20000),
  },
);
const inspected = await schema.json();
assert.ok(schema.ok && inspected.success, "Isolated MUSIC_DB schema inspection failed");
const found = new Set(inspected.result?.[0]?.results?.map((row) => row.name) || []);
for (const name of [
  "music_contracts",
  "music_masters",
  "music_publication_outbox",
  "music_analysis_jobs",
  "music_source_limits",
  "music_intake_jobs",
  "music_quality_jobs",
  "music_stage_events",
  "music_human_reviews",
  "music_open_source_candidates",
  "music_open_discovery_runs",
  "music_open_discovery_cursors",
  "music_open_technical_qa",
])
  assert.ok(found.has(name), "Isolated MUSIC_DB migration missing: " + name);

console.log(
  "HOSTED_MUSIC_SUPPLY_SHADOW_PASS current Worker code, complete isolated QA D1 schema/R2, all processing switches disabled, no production bindings or routing.",
);
