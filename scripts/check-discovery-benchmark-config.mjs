import assert from "node:assert/strict";
import fs from "node:fs";
import { parseDiscoveryBenchmarkConfig } from "./performance/discovery-benchmark-config.mjs";
const source = fs.readFileSync("wrangler.discovery-benchmark.jsonc", "utf8");
const config = parseDiscoveryBenchmarkConfig(source);
// Wrangler JSONC accepts comments and trailing commas. JSON.parse does not.
assert.equal(parseDiscoveryBenchmarkConfig("// private benchmark\n" + source).name, config.name);
for (const patch of [
  { routes: ["cove.example/*"] },
  { triggers: { crons: ["* * * * *"] } },
  { d1_databases: [{ binding: "DB", database_id: "4bd657ac-8789-403e-a28c-93aba8d0a989" }] },
  { r2_buckets: [{ binding: "DISCOVERY_MODELS", bucket_name: "cove-production-media" }] },
  { vars: { ...config.vars, COVE_SSR_STAGING: "0" } },
])
  assert.throws(() => parseDiscoveryBenchmarkConfig(JSON.stringify({ ...config, ...patch })));
console.log("PASS: JSONC parsing and fail-closed synthetic D1/R2/route/cron restrictions");
