import assert from "node:assert/strict";
import { PERFORMANCE_D1, verifySyntheticD1 } from "./isolated-d1-gate.mjs";
const account = process.env.CLOUDFLARE_ACCOUNT_ID;
const token = process.env.CLOUDFLARE_API_TOKEN;
assert.match(account || "", /^[a-f0-9]{32}$/);
assert.ok(token && token.length > 16);
const query = async (dbId, sql) => {
  assert.ok(Object.values(PERFORMANCE_D1).some((x) => x.id === dbId));
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${account}/d1/database/${dbId}/query`,
    {
      method: "POST",
      headers: {
        Authorization: "Bearer " + token,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ sql }),
      signal: AbortSignal.timeout(60000),
    },
  );
  if (!response.ok) throw Error("Synthetic-only database query denied");
  const body = await response.json();
  return { success: body.success && body.result?.[0]?.success, results: body.result?.[0]?.results };
};
const baseline = await verifySyntheticD1(PERFORMANCE_D1.baseline.id, query);
const candidate = await verifySyntheticD1(PERFORMANCE_D1.current.id, query);
assert.deepEqual(
  baseline,
  candidate,
  "Identical fixtures required to attribute true concurrency effects",
);
for (const [role, spec] of Object.entries(PERFORMANCE_D1)) {
  // These are NEGATIVE rights assertions, not a count-only proxy:
  // fixed seed 107 is granted and explicitly denied US, but granted CA
  // neither; seed 31 is CA-licensed; seed 103 is US denied.
  const deniedId = "perf-synth-000107";
  const revokedId = "perf-synth-000097";
  const caId = "perf-synth-000031";
  const validId = "perf-synth-000001";
  const rows = (
    await query(
      spec.id,
      `
    SELECT
    EXISTS(SELECT 1 FROM retail_product_availability_rows WHERE product_id='${validId}' AND territory_code='US') allowed_us,
    EXISTS(SELECT 1 FROM retail_product_availability_rows WHERE product_id='${deniedId}' AND territory_code='US') forbidden_denied,
    EXISTS(SELECT 1 FROM retail_product_availability_rows WHERE product_id='${revokedId}' AND territory_code='US') forbidden_revoked,
    EXISTS(SELECT 1 FROM retail_product_availability_rows WHERE product_id='${caId}' AND territory_code='CA') allowed_ca,
    EXISTS(SELECT 1 FROM retail_product_availability_rows WHERE product_id='${validId}' AND territory_code='CA') forbidden_ca
  `,
    )
  ).results;
  assert.ok(rows?.length === 1);
  assert.equal(Number(rows[0].allowed_us), 1, role + " US legal grant missing");
  assert.equal(Number(rows[0].forbidden_denied), 0, role + " denied title is incorrectly sellable");
  assert.equal(
    Number(rows[0].forbidden_revoked),
    0,
    role + " revoked title is incorrectly sellable",
  );
  assert.equal(Number(rows[0].allowed_ca), 1, role + " CA legal grant missing");
  assert.equal(Number(rows[0].forbidden_ca), 0, role + " US-only title is sellable in CA");
}
console.log(
  "PASS: two identical 50k wholly synthetic isolated D1 catalogs; fresh US/CA allow/deny/revoke assertions",
);
