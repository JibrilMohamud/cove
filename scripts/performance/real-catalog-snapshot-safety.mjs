import assert from "node:assert/strict";

// A D1 binding is physically capable of writes even if its Worker currently
// executes SELECTs only. Never give any new Workers.dev or preview Worker a
// direct primary production DB binding.
export const PRIMARY_D1 = "4bd657ac-8789-403e-a28c-93aba8d0a989";
const INCOMPLETE_SYNTHETIC_D1 = new Set([
  "e4cbb0ef-6288-4fa1-9dbb-fb42fe01d4f3",
  "cc842ee5-c526-431e-96ee-5e093fb45e6d",
]);
export const REAL_CATALOG_MINIMUM_PRODUCTS = 82_247;

export function requireIsolatedCatalogSnapshotTarget(id, name) {
  assert.match(String(id || ""), /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i,
    "Missing full-catalog isolated staging D1 UUID; fail before Worker deployment");
  assert.notEqual(id, PRIMARY_D1,
    "Production primary D1 must never be directly bound to an acceptance Worker");
  assert.ok(!INCOMPLETE_SYNTHETIC_D1.has(id),
    "Known 50k synthetic fixture is not a legally current real-catalog snapshot");
  assert.match(String(name || ""), /^cove-[a-z0-9](?:[a-z0-9-]{0,58}[a-z0-9])?$/,
    "Dedicated isolated full-catalog staging database name required");
  assert.ok(!/production|primary/i.test(name),
    "A production-primary name cannot masquerade as an isolated fixture");
  return { id, name };
}

export function requireNoPrimaryD1PreviewBinding(config, expectedIsolatedId) {
  assert.ok(config && Array.isArray(config.d1_databases) && config.d1_databases.length === 1,
    "Isolated preview must have exactly one direct D1 binding");
  const binding = config.d1_databases[0];
  assert.ok(binding && binding.database_id === expectedIsolatedId,
    "Preview database binding changed or was not the approved isolated fixture");
  assert.notEqual(binding.database_id, PRIMARY_D1,
    "A preview Worker must never directly bind production primary D1");
  const text = JSON.stringify(config);
  assert.ok(!text.includes(PRIMARY_D1),
    "Production primary database ID found in isolated Worker deployment config");
  assert.ok(!config.routes && !config.route && !config.queues,
    "Isolated preview cannot have customer routes or production queues");
  return true;
}

/**
 * Minimum synthetic-vs-real fixture guard, NOT a legal snapshot certificate.
 * A true release must separately attest complete legal-owner generation,
 * withdrawal epoch, search/facet/page parity and private-data exclusions.
 * Called BEFORE any Worker upload or R2/KV seeding.
 */
export function requireMinimumRealCatalogSnapshot(readResult) {
  assert.ok(Array.isArray(readResult) && readResult.length === 1,
    "Incomplete full-catalog snapshot preflight response");
  const one = readResult[0];
  assert.ok(one?.meta?.changed_db === false && one.meta.changes === 0,
    "Snapshot preflight is not explicitly certified zero-write");
  assert.ok(Array.isArray(one.results) && one.results.length === 1,
    "Missing complete snapshot preflight row");
  const row = one.results[0];
  for (const name of ["products", "editions", "taxonomy_links", "rights_grants"]) {
    assert.ok(Number.isSafeInteger(row[name]) && row[name] >= 0,
      "Invalid isolated snapshot aggregate: " + name);
  }
  assert.ok(row.products >= REAL_CATALOG_MINIMUM_PRODUCTS,
    "Incomplete isolated real-catalog product coverage");
  assert.ok(row.editions >= REAL_CATALOG_MINIMUM_PRODUCTS,
    "Incomplete isolated real-catalog edition coverage");
  assert.ok(row.taxonomy_links > 0 && row.rights_grants > 0,
    "Isolated fixture lacks taxonomy or legal-rights data");
  return {
    products: row.products,
    editions: row.editions,
    taxonomyLinksPresent: true,
    grantsPresent: true,
    legalGenerationAttested: false,
    releaseCertified: false,
  };
}
