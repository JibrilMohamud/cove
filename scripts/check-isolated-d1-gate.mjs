import assert from "node:assert/strict";
import {
  PERFORMANCE_D1,
  PRODUCTION_D1_ID,
  isolatedD1Config,
  verifySyntheticD1,
} from "./performance/isolated-d1-gate.mjs";

const template = `name = "cove-storefront-ssr-staging"
[placement]
mode = "smart"
[assets]
run_worker_first = true
[[ratelimits]]
namespace_id = "731903"
[[d1_databases]]
binding = "DB"
database_name = "cove-production"
database_id = "${PRODUCTION_D1_ID}"
[vars]
COVE_SSR_STAGING = "1"`;
for (const [role, id] of Object.entries(PERFORMANCE_D1)) {
  const name =
    role === "baseline" ? "cove-lazyfacet-control-staging" : "cove-lazyfacet-candidate-staging";
  const body = isolatedD1Config(template, role, name, role === "baseline" ? "732010" : "732011");
  assert.ok(body.includes('database_id = "' + id.id + '"'));
  assert.ok(body.includes('database_name = "' + id.name + '"'));
  assert.ok(!body.includes(PRODUCTION_D1_ID));
  assert.ok(!body.includes('database_name = "cove-production"'));
  assert.ok(!body.includes("[placement]"));
  assert.ok(body.includes('COVE_SSR_STAGING = "1"'));
}
assert.notEqual(PERFORMANCE_D1.baseline.id, PERFORMANCE_D1.current.id);
for (const [templateOverride, role, name] of [
  [
    template.replace('COVE_SSR_STAGING = "1"', 'COVE_SSR_STAGING = "0"'),
    "baseline",
    "cove-lazyfacet-control-staging",
  ],
  [
    template.replace(PRODUCTION_D1_ID, PERFORMANCE_D1.baseline.id),
    "baseline",
    "cove-lazyfacet-control-staging",
  ],
  [template, "unknown", "cove-lazyfacet-control-staging"],
  [template, "baseline", "cove-production"],
]) {
  assert.throws(() => isolatedD1Config(templateOverride, role, name, "732010"), /./);
}
const valid = {
  documents: 50000,
  active_grants: 44000,
  revoked_grants: 100,
  denied_grants: 110,
  active_products: 45000,
  live_us: 41500,
  live_ca: 1700,
  synthetic_documents: 50000,
  nonsynthetic_products: 0,
};
const probe = async (dbId, sql) => {
  assert.ok(Object.values(PERFORMANCE_D1).some((x) => x.id === dbId));
  assert.ok(sql.includes("retail_product_availability_rows"));
  return { success: true, results: [valid] };
};
await verifySyntheticD1(PERFORMANCE_D1.baseline.id, probe);
await verifySyntheticD1(PERFORMANCE_D1.current.id, probe);
for (const modification of [
  { documents: 23, synthetic_documents: 23 },
  { nonsynthetic_products: 1 },
  { denied_grants: 0 },
  { revoked_grants: 0 },
  { live_ca: 0 },
  { live_us: 0 },
  { synthetic_documents: 49999 },
]) {
  await assert.rejects(
    verifySyntheticD1(PERFORMANCE_D1.baseline.id, async () => ({
      success: true,
      results: [{ ...valid, ...modification }],
    })),
  );
}
await assert.rejects(verifySyntheticD1(PRODUCTION_D1_ID, probe));
await assert.rejects(
  verifySyntheticD1(PERFORMANCE_D1.baseline.id, async () => ({ success: false, results: [valid] })),
);
console.log(
  "PASS: paired stages cannot bind primary production D1 or accept missing/mixed/rightsless synthetic fixtures",
);
