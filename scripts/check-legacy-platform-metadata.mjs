import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

const read = (path) => readFileSync(path, "utf8");
const hosting = read("config/integrations/openai-sites-hosting.json");
const lovable = read("config/integrations/lovable-project.json");
const stage = read("scripts/stage-sites.mjs");

assert.equal(existsSync(".openai"), false, "Source .openai directory must be gone");
assert.equal(existsSync(".lovable"), false, "Source .lovable directory must be gone");
assert.deepEqual(JSON.parse(hosting), {
  project_id: "appgprj_6aaf4b7c06108191b9ff8cd55735fb24",
  d1: "DB",
  r2: "BUCKET",
});
assert.deepEqual(JSON.parse(lovable), {
  schemaVersion: 1,
  template: "tanstack_start_ts_current",
  revision: "tanstack_start_ts_current-219b062142fe",
});
assert.ok(
  stage.includes(
    'cp("config/integrations/openai-sites-hosting.json", "dist/.openai/hosting.json")',
  ),
  "Legacy Sites build artifact must retain original expected metadata location",
);
assert.equal(
  stage.includes('cp(".openai/hosting.json", "dist/.openai/hosting.json")'),
  false,
  "Build must no longer require deleted source directory",
);
if (process.argv.includes("--after-build")) {
  assert.deepEqual(
    JSON.parse(read("dist/.openai/hosting.json")),
    JSON.parse(hosting),
    "The generated Sites package must preserve the exact project and binding IDs",
  );
  assert.equal(existsSync("dist/.openai/drizzle"), true, "Migrations must still be staged");
  assert.equal(existsSync("dist/server/index.js"), true, "Worker entry must still be staged");
}
console.log(
  "PASS: both root metadata folders absent, identities preserved, Sites package compatible",
);
