import fs from "node:fs";
import { build } from "esbuild";
import ts from "typescript";

const configPath = "wrangler.music-supply.qa.jsonc";
const parsed = ts.parseConfigFileTextToJson(configPath, fs.readFileSync(configPath, "utf8"));
if (parsed.error) throw Error("Invalid QA Wrangler config");
const c = parsed.config;
if (
  c.name !== "cove-music-supply-isolated-qa" ||
  c.workers_dev !== false ||
  c.preview_urls !== false ||
  c.routes ||
  c.route ||
  c.triggers ||
  c.queues ||
  c.vars?.MUSIC_SUPPLY_ENABLED !== "0" ||
  c.vars?.MUSIC_ANALYSIS_ENABLED !== "0" ||
  c.vars?.MUSIC_AUTO_QUIET_APPROVAL !== "0" ||
  c.d1_databases?.length !== 1 ||
  c.d1_databases[0]?.binding !== "MUSIC_DB" ||
  c.d1_databases[0]?.database_id !== "fe9a9dd2-64b8-451c-a356-9ec71d9ee211" ||
  c.r2_buckets?.length !== 1 ||
  c.r2_buckets[0]?.bucket_name !== "cove-music-supply-qa-20261023"
)
  throw Error("Isolated music QA must remain non-public and disabled");
const outfile = ".output/music-supply/worker.mjs";
fs.mkdirSync(".output/music-supply", { recursive: true });
await build({
  entryPoints: ["src/music-supply/worker.ts"],
  bundle: true,
  platform: "browser",
  format: "esm",
  target: "es2022",
  outfile,
  logLevel: "silent",
});
console.log("Music supply worker built; isolated DB/R2 only; no ingress, cron or enabled feeds");
