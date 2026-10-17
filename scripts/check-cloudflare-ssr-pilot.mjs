import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const workerFile = path.resolve(".output/server/index.mjs");
const assets = path.resolve(".output/public");
const config = fs.readFileSync("wrangler.frontend.pilot.toml", "utf8");
assert.match(config, /^main\s*=\s*"\.output\/server\/index\.mjs"$/m);
assert.match(config, /^workers_dev\s*=\s*false$/m);
assert.doesNotMatch(config, /^route(?:s)?\s*=/m);
assert.match(config, /^binding\s*=\s*"DB"$/m);
assert.match(config, /^binding\s*=\s*"BUCKET"$/m);
assert.ok(fs.existsSync(workerFile), "Cloudflare module server entry must exist");
assert.ok(fs.statSync(workerFile).size > 0, "Cloudflare module must not be empty");
assert.ok(fs.existsSync(assets) && fs.statSync(assets).isDirectory(), "SSR public assets required");
console.log(
  JSON.stringify({
    pilot: "build-only",
    workerBytes: fs.statSync(workerFile).size,
    staticAssetsPresent: true,
    publicRoutesEnabled: false,
  }),
);
