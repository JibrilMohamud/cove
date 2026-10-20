import assert from "node:assert/strict";
import ts from "typescript";
import { PERFORMANCE_D1, PRODUCTION_D1_ID } from "./isolated-d1-gate.mjs";

/** Validate JSONC before any Cloudflare mutation; this diagnostic cannot target production. */
export function parseDiscoveryBenchmarkConfig(source) {
  const parsed = ts.parseConfigFileTextToJson("wrangler.discovery-benchmark.jsonc", source);
  assert.ok(!parsed.error, "Discovery benchmark config must be valid JSONC");
  const config = parsed.config;
  assert.equal(config.name, "cove-discovery-read-model-staging");
  assert.equal(config.main, "artifacts/discovery-benchmark/worker.mjs");
  assert.equal(config.d1_databases.length, 2);
  assert.equal(config.d1_databases[0].binding, "DB");
  assert.equal(config.d1_databases[1].binding, "ENGAGEMENT_DB");
  assert.equal(config.d1_databases[1].database_id, "86915082-bfa5-478e-a8c4-90d05f01e62c");
  assert.equal(config.d1_databases[1].migrations_dir, "engagement-migrations");
  assert.equal(config.vars.COVE_PERF_ENGAGEMENT_DATABASE_ID, config.d1_databases[1].database_id);
  assert.equal(config.d1_databases[0].database_id, PERFORMANCE_D1.current.id);
  assert.ok(!source.includes(PRODUCTION_D1_ID));
  assert.equal(config.r2_buckets.length, 1);
  assert.equal(config.r2_buckets[0].binding, "DISCOVERY_MODELS");
  assert.equal(config.r2_buckets[0].bucket_name, "cove-discovery-models-benchmark");
  assert.equal(config.vars.COVE_SSR_STAGING, "1");
  assert.equal(config.vars.COVE_PERF_DATABASE_ID, PERFORMANCE_D1.current.id);
  assert.equal(config.workers_dev, true);
  const allowed = new Set([
    "name",
    "main",
    "compatibility_date",
    "compatibility_flags",
    "workers_dev",
    "limits",
    "d1_databases",
    "r2_buckets",
    "ratelimits",
    "vars",
    "observability",
  ]);
  for (const key of Object.keys(config))
    assert.ok(allowed.has(key), `Unexpected benchmark resource: ${key}`);
  return config;
}
