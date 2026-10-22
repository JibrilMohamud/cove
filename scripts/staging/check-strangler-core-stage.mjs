import assert from "node:assert/strict";
import fs from "node:fs";

const config = fs.readFileSync("wrangler.storefront-core.stage.toml", "utf8");
assert.match(config, /^name = "cove-thin-core-staging"$/m);
assert.match(config, /^workers_dev = false$/m);
assert.match(config, /^preview_urls = false$/m);
assert.match(config, /^COVE_SSR_STAGING = "1"$/m);
assert.match(config, /^database_id = "e4cbb0ef-6288-4fa1-9dbb-fb42fe01d4f3"$/m);
assert.doesNotMatch(config, /4bd657ac-8789-403e-a28c-93aba8d0a989/);
assert.doesNotMatch(config, /cove-production-media/);
assert.doesNotMatch(config, /^route\s*=|^routes\s*=|^workers_dev = true|^preview_urls = true/m);
assert.doesNotMatch(config, /^(?:\[triggers\]|\[\[queues\.|\[\[r2_buckets\]\])/m);
const thin = JSON.parse(fs.readFileSync("wrangler.storefront-strangler.stage.jsonc", "utf8"));
assert.equal(thin.services?.[0]?.service, "cove-thin-core-staging");
console.log("PASS: CORE staging executes genuine app build, isolated D1, gated, unroutable.");
