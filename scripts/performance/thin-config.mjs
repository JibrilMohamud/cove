import assert from "node:assert/strict";
import ts from "typescript";
import { PERFORMANCE_D1, PRODUCTION_D1_ID } from "./isolated-d1-gate.mjs";

export function parseThinConfig(source) {
  const parsed = ts.parseConfigFileTextToJson("wrangler.storefront-thin.jsonc", source);
  assert.ok(!parsed.error, "Thin Worker config must be valid JSONC");
  const config = parsed.config;
  assert.ok(!source.includes(PRODUCTION_D1_ID), "Production D1 is prohibited");
  assert.equal(config.name, "cove-thin-pilot-staging");
  assert.equal(config.d1_databases.length, 1);
  assert.equal(config.d1_databases[0].database_id, PERFORMANCE_D1.current.id);
  assert.equal(config.services.length, 1);
  assert.equal(config.services[0].service, "cove-thin-core-staging");
  assert.equal(config.vars.COVE_SSR_STAGING, "1");
  assert.equal(config.vars.COVE_THIN_STOREFRONT, "synthetic-only");
  assert.equal(config.vars.COVE_PERF_DATABASE_ID, PERFORMANCE_D1.current.id);
  assert.equal(config.ratelimits.length, 1);
  assert.deepEqual(config.ratelimits[0].simple, { limit: 180, period: 60 });
  for (const key of ["routes", "route", "r2_buckets", "placement"])
    assert.ok(!config[key], "Unexpected public/production resource in thin experiment: " + key);
  return config;
}
