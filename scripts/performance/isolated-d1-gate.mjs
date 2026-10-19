import assert from "node:assert/strict";

export const PERFORMANCE_D1 = Object.freeze({
  baseline: {
    id: "cc842ee5-c526-431e-96ee-5e093fb45e6d",
    name: "cove-perf-isolated-control-20261019",
  },
  current: {
    id: "e4cbb0ef-6288-4fa1-9dbb-fb42fe01d4f3",
    name: "cove-perf-isolated-candidate-20261019",
  },
});
export const PRODUCTION_D1_ID = "4bd657ac-8789-403e-a28c-93aba8d0a989";

/** A release load test must NEVER share the production database service. */
export function isolatedD1Config(template, role, workerName, namespace) {
  const db = PERFORMANCE_D1[role];
  assert.ok(db, "Unknown isolated D1 performance cohort");
  assert.match(template, /COVE_SSR_STAGING = "1"/);
  assert.match(template, /run_worker_first = true/);
  assert.match(template, /database_id = "4bd657ac-8789-403e-a28c-93aba8d0a989"/);
  assert.match(workerName, /^cove-lazyfacet-(control|candidate)-staging$/);
  assert.match(namespace, /^[0-9]{6}$/);
  assert.match(template, /^name = "cove-storefront-ssr-staging"$/m);
  assert.match(template, /^namespace_id = "731903"$/m);
  const replaced = template
    .replace(/\[placement\]\s*mode\s*=\s*"smart"\s*/m, "")
    .replace(/^name = "cove-storefront-ssr-staging"$/m, `name = "${workerName}"`)
    .replace(/^namespace_id = "731903"$/m, `namespace_id = "${namespace}"`)
    .replace(/^database_name = "cove-production"$/m, `database_name = "${db.name}"`)
    .replace(/^database_id = "4bd657ac-8789-403e-a28c-93aba8d0a989"$/m, `database_id = "${db.id}"`);
  assert.doesNotMatch(replaced, new RegExp(PRODUCTION_D1_ID, "i"));
  assert.doesNotMatch(replaced, /^database_name = "cove-production"$/m);
  assert.match(replaced, new RegExp(`^database_id = "${db.id}"$`, "m"));
  assert.match(replaced, new RegExp(`^database_name = "${db.name}"$`, "m"));
  assert.match(replaced, new RegExp(`^name = "${workerName}"$`, "m"));
  assert.match(replaced, new RegExp(`^namespace_id = "${namespace}"$`, "m"));
  assert.match(replaced, /COVE_SSR_STAGING = "1"/);
  assert.match(replaced, /run_worker_first = true/);
  assert.doesNotMatch(replaced, /^\[placement\]/m);
  return replaced;
}

/** Require independently licensed, synthetic catalog scale and rights states. */
export async function verifySyntheticD1(dbId, api, { minDocuments = 40000 } = {}) {
  assert.ok(Object.values(PERFORMANCE_D1).some((x) => x.id === dbId));
  const sql = `SELECT
    (SELECT COUNT(*) FROM catalog_search_documents) AS documents,
    (SELECT COUNT(*) FROM rights_grants WHERE status='active' AND decision='allow') AS active_grants,
    (SELECT COUNT(*) FROM rights_grants WHERE status='revoked') AS revoked_grants,
    (SELECT COUNT(*) FROM rights_grants WHERE decision='deny') AS denied_grants,
    (SELECT COUNT(*) FROM products WHERE storefront_status='active') AS active_products,
    (SELECT COUNT(*) FROM retail_product_availability_rows WHERE territory_code='US') AS live_us,
    (SELECT COUNT(*) FROM retail_product_availability_rows WHERE territory_code='CA') AS live_ca,
    (SELECT COUNT(*) FROM catalog_search_documents WHERE product_id LIKE 'perf-synth-%') AS synthetic_documents,
    (SELECT COUNT(*) FROM products WHERE id NOT LIKE 'perf-synth-%') AS nonsynthetic_products`;
  const response = await api(dbId, sql);
  assert.ok(response?.success, "Synthetic D1 readiness query failed closed");
  const data = response.results?.[0];
  assert.ok(data, "Synthetic D1 readiness row missing");
  for (const key of [
    "documents",
    "active_grants",
    "revoked_grants",
    "denied_grants",
    "active_products",
    "live_us",
    "live_ca",
    "synthetic_documents",
    "nonsynthetic_products",
  ])
    assert.ok(Number.isSafeInteger(Number(data[key])), "Invalid synthetic fixture metric " + key);
  assert.ok(data.documents >= minDocuments, "Synthetic catalog is not representative");
  assert.equal(data.synthetic_documents, data.documents, "Non-synthetic catalog detected");
  assert.equal(data.nonsynthetic_products, 0, "Live/private products detected");
  assert.ok(data.active_grants > minDocuments / 2, "Rights fixtures missing");
  assert.ok(data.revoked_grants > 0 && data.denied_grants > 0, "Negative rights fixtures missing");
  assert.ok(data.live_us > minDocuments / 3, "Rights-authorized US shelf absent");
  assert.ok(data.live_ca > 0 && data.live_ca < data.live_us, "Territorial distinction missing");
  return Object.fromEntries(Object.entries(data).map(([key, value]) => [key, Number(value)]));
}
