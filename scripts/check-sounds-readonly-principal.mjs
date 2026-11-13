import assert from "node:assert/strict";
import fs from "node:fs";

const service = "cove-canonical-d1-readonly";
for (const file of [
  "wrangler.sounds-publication.prod-isolated.jsonc",
  "wrangler.sounds-publication.prod-disabled.jsonc",
]) {
  const config = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(config.name, "cove-sounds-publication");
  assert.equal(config.workers_dev, false);
  assert.equal(config.preview_urls, false);
  assert.ok(!config.routes && !config.route);
  assert.ok(!config.d1_databases?.length, "Never regrant native canonical D1: " + file);
  assert.deepEqual(config.services, [{ binding: "COVE_CANONICAL_READONLY", service }]);
  assert.equal(config.vars.COVE_CANONICAL_READONLY_RPC, "1");
  assert.equal(config.vars.COVE_SOUNDS_MARKETS, "US");
  assert.deepEqual(config.triggers.crons, ["11 * * * *"], "Preserve hourly publication");
  assert.equal(config.r2_buckets[0].bucket_name, "cove-sounds-private-presentation");
  assert.equal(config.kv_namespaces[0].id, "544267f3cf604c1d8976f1b06d258e24");
}
const active = JSON.parse(
  fs.readFileSync("wrangler.sounds-publication.prod-isolated.jsonc", "utf8"),
);
const disabled = JSON.parse(
  fs.readFileSync("wrangler.sounds-publication.prod-disabled.jsonc", "utf8"),
);
assert.equal(active.vars.COVE_SOUNDS_PUBLICATION_ENABLED, "1");
assert.equal(disabled.vars.COVE_SOUNDS_PUBLICATION_ENABLED, "0");
const source = fs.readFileSync("src/storefront-strangler/sounds-publication.worker.ts", "utf8");
assert.match(source, /canonicalReadonlyD1\(env\.COVE_CANONICAL_READONLY\)/);
assert.match(source, /env\.SOURCE_DB\s*\|\|/);
assert.match(source, /COVE_CANONICAL_READONLY_RPC\s*!==\s*"1"/);
assert.doesNotMatch(source, /env\.SOURCE_DB\.prepare\(/);
const seed = fs.readFileSync("scripts/staging/seed-cove-sounds-private.mjs", "utf8");
assert.match(seed, /COVE_CANONICAL_READONLY_RPC:\s*"1"/);
assert.match(seed, /COVE_CANONICAL_READONLY:\s*seedReadService/);
assert.match(seed, /served_by_primary !== true/);
assert.match(seed, /rows_written !== 0/);
assert.doesNotMatch(seed, /SOURCE_DB:\s*\{/);

console.log(
  "PASS: active/disabled Sounds config has no native D1 or public route, preserves US hourly cron and private R2/KV, read service required",
);
