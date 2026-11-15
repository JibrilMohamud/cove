import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { build } from "esbuild";

const ACCOUNT = "d26430caa63ec55f6612e32f36aca5e9";
const run = process.env.GITHUB_RUN_ID;
assert.match(run || "", /^[0-9]{8,15}$/);
assert.equal(process.env.CLOUDFLARE_ACCOUNT_ID, ACCOUNT);
assert.ok(process.env.CLOUDFLARE_API_TOKEN, "Isolated Cloudflare deploy token required");
const name = "cove-owner-do-capacity-" + run;
const gate = randomBytes(32).toString("hex");
mkdirSync(".output/stage-owner-do", { recursive: true });
await build({
  entryPoints: ["src/storefront-strangler/owner-do-capacity.stage.ts"],
  outfile: ".output/stage-owner-do/worker.mjs",
  bundle: true,
  platform: "neutral",
  format: "esm",
  target: "es2022",
  external: ["cloudflare:workers"],
  logLevel: "warning",
});
const config = {
  name,
  main: ".output/stage-owner-do/worker.mjs",
  compatibility_date: "2026-11-15",
  workers_dev: true,
  preview_urls: false,
  routes: [],
  durable_objects: {
    bindings: [{ name: "OWNER_DO", class_name: "StageUnifiedOwner" }],
  },
  migrations: [
    { tag: "cove-owner-do-capacity-stage-v1", new_sqlite_classes: ["StageUnifiedOwner"] },
  ],
  vars: {
    COVE_OWNER_DO_STAGE: "1",
    COVE_OWNER_DO_EXPIRES_AT: String(Date.now() + 15 * 60_000),
  },
};
assert.deepEqual(config.routes, []);
assert.equal("d1_databases" in config, false);
assert.equal("services" in config, false);
writeFileSync("wrangler.owner-do-capacity.generated.jsonc", JSON.stringify(config, null, 2));
writeFileSync(".output/stage-owner-do/secrets.json", JSON.stringify({
  COVE_OWNER_DO_GATE: gate,
}), { mode: 0o600, flag: "wx" });
console.log(JSON.stringify({
  event: "cove_stage_owner_do_prepared",
  worker: name,
  noD1Binding: true,
  noCustomerRoutes: true,
  releaseCertified: false,
}));
