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
assert.equal(config.vars.MUSIC_SUPPLY_ENABLED, "0");
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
  if (
    get("MUSIC_DB")?.database_id === musicDb &&
    get("MUSIC_BUCKET")?.bucket_name === "cove-music-supply-qa-20261023" &&
    get("MUSIC_SUPPLY_ENABLED")?.text === "0"
  ) {
    certified = true;
    break;
  }
  await new Promise((resolve) => setTimeout(resolve, 1500));
}
assert.ok(certified, "Isolated disabled music Worker bindings never converged");
console.log(
  "HOSTED_MUSIC_SUPPLY_SHADOW_PASS isolated QA D1/R2 only, disabled, nonpublic, no production binding or routing.",
);
