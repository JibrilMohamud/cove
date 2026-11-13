import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

// Cleans ONLY this CI run's private synthetic v2 presentation objects.
// Never wildcard-delete and never touch production/ or real/ namespaces.
const run = process.env.GITHUB_RUN_ID || "";
assert.match(run, /^[1-9][0-9]{7,14}$/);
const account = "d26430caa63ec55f6612e32f36aca5e9";
assert.equal(process.env.CLOUDFLARE_ACCOUNT_ID, account);
const token = process.env.CLOUDFLARE_API_TOKEN || "";
assert.ok(token.length > 20);
const prefix = `campaign/${run}/synthetic/`;
const directory = ".output/strangler/private-v2-capacity";
const file = path.join(directory, "manifest.json");
if (!fs.existsSync(file)) {
  console.log("COVE_STAGE_V2_CLEANUP: no synthetic presentation was published");
  process.exit(0);
}
const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
assert.equal(manifest.schema, "cove.stage.v2.cleanup.v1");
assert.equal(manifest.prefix, prefix);
assert.ok(Array.isArray(manifest.objects) && manifest.objects.length <= 32);
const seen = new Set();
const bucket = "cove-strangler-private-presentation-stage";
const kvId = "8245d5f2116a445d9571405b41b7c8c3";
let failures = 0;
for (const { country, objectKey } of manifest.objects) {
  assert.match(country, /^[A-Z]{2}$/);
  assert.equal(objectKey, prefix + "private/presentation/v2/home/" + country + ".json");
  assert.ok(!seen.has(objectKey), "Refuse duplicate deletion");
  seen.add(objectKey);
  const wrangler = spawnSync(
    "npm",
    [
      "exec",
      "--yes",
      "--package=wrangler@4.151.0",
      "--",
      "wrangler",
      "r2",
      "object",
      "delete",
      bucket + "/" + objectKey,
      "--remote",
    ],
    {
      encoding: "utf8",
      timeout: 90_000,
      env: { ...process.env, CLOUDFLARE_SEND_METRICS: "false" },
    },
  );
  if (wrangler.status !== 0) failures++;
  try {
    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${account}/storage/kv/namespaces/${kvId}/values/${encodeURIComponent(objectKey)}`,
      {
        method: "DELETE",
        headers: { authorization: "Bearer " + token },
        signal: AbortSignal.timeout(30000),
      },
    );
    const data = await response.json();
    if (!response.ok || data.success !== true) failures++;
  } catch {
    failures++;
  }
}
console.log("COVE_STAGE_V2_CLEANUP " + JSON.stringify({ targets: seen.size, failures }));
assert.equal(failures, 0, "Private synthetic R2/KV cleanup failed");
