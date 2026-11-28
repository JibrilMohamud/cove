import assert from "node:assert/strict";
import { withStagePresentationStore } from "./stage-presentation-storage.mjs";
import fs from "node:fs";
import path from "node:path";

// Cleans ONLY this CI run's private synthetic v2 presentation objects.
// Never wildcard-delete and never touch production/ or real/ namespaces.
const run = process.env.GITHUB_RUN_ID || "";
assert.match(run, /^[1-9][0-9]{7,14}$/);
const account = "d26430caa63ec55f6612e32f36aca5e9";
assert.equal(process.env.CLOUDFLARE_ACCOUNT_ID, account);
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
let failures = 0;
for (const { country, objectKey } of manifest.objects) {
  assert.match(country, /^[A-Z]{2}$/);
  assert.equal(objectKey, prefix + "private/presentation/v2/home/" + country + ".json");
  assert.ok(!seen.has(objectKey), "Refuse duplicate deletion");
  seen.add(objectKey);
}
async function deleteManifest(storage) {
  for (const { country } of manifest.objects) {
    try {
      await storage.delete(country);
    } catch (error) {
      const status = Number.isInteger(error?.actual) ? error.actual : null;
      console.error("COVE_STAGE_V2_DELETE_FAILED", JSON.stringify({ country, status }));
      failures++;
    }
  }
}
await withStagePresentationStore("synthetic", deleteManifest, "cleanup");

console.log("COVE_STAGE_V2_CLEANUP " + JSON.stringify({ targets: seen.size, failures }));
assert.equal(failures, 0, "Private synthetic R2/KV cleanup failed");
