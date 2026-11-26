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
  assert.match(
    String(id || ""),
    /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i,
    "Missing full-catalog isolated staging D1 UUID; fail before Worker deployment",
  );
  // UUIDs identify the same D1 independent of alphabetic case. Never
  // allow an uppercase primary ID to bypass the physical writer fence.
  const normalizedId = String(id).toLowerCase();
  assert.notEqual(
    normalizedId,
    PRIMARY_D1,
    "Production primary D1 must never be directly bound to an acceptance Worker",
  );
  assert.ok(
    !INCOMPLETE_SYNTHETIC_D1.has(normalizedId),
    "Known 50k synthetic fixture is not a legally current real-catalog snapshot",
  );
  assert.match(
    String(name || ""),
    /^cove-[a-z0-9](?:[a-z0-9-]{0,58}[a-z0-9])?$/,
    "Dedicated isolated full-catalog staging database name required",
  );
  assert.ok(
    !/production|primary/i.test(name),
    "A production-primary name cannot masquerade as an isolated fixture",
  );
  return { id: normalizedId, name };
}

export function requireNoPrimaryD1PreviewBinding(config, expectedIsolatedId) {
  assert.ok(
    config && Array.isArray(config.d1_databases) && config.d1_databases.length === 1,
    "Isolated preview must have exactly one direct D1 binding",
  );
  const binding = config.d1_databases[0];
  assert.ok(
    binding && binding.database_id === expectedIsolatedId,
    "Preview database binding changed or was not the approved isolated fixture",
  );
  assert.notEqual(
    binding.database_id,
    PRIMARY_D1,
    "A preview Worker must never directly bind production primary D1",
  );
  const serialized = JSON.stringify(config).toLowerCase();
  assert.ok(
    !serialized.includes(PRIMARY_D1),
    "Production primary database ID found in isolated Worker deployment config",
  );
  // A service or Durable Object binding can reach the legal owner and its
  // production primary D1 even when this Worker's direct DB binding is safe.
  // Deny all indirection and privileged platform capabilities before upload.
  for (const capability of [
    "routes",
    "route",
    "queues",
    "services",
    "durable_objects",
    "dispatch_namespaces",
    "hyperdrive",
    "workflows",
    "tail_consumers",
    "unsafe",
    "send_email",
    "mtls_certificates",
    "vectorize",
    "analytics_engine_datasets",
    "ai",
    "browser",
    "assets",
    "triggers",
    "zone_id",
  ]) {
    if (capability === "services") {
      assert.ok(
        !config.services || (Array.isArray(config.services) && config.services.length === 0),
        "Isolated preview cannot have service bindings",
      );
    } else {
      assert.ok(
        !Object.hasOwn(config, capability),
        "Isolated preview cannot attach privileged capability: " + capability,
      );
    }
  }
  assert.match(
    String(config.name || ""),
    /^cove-strangler-real-preview-[1-9][0-9]*-[1-9][0-9]*$/,
    "Only a unique disposable preview Worker name is allowed",
  );
  assert.equal(config.workers_dev, true, "Isolated preview must use Workers.dev only");
  assert.equal(config.preview_urls, false, "Preview URL aliases must remain disabled");
  assert.ok(
    config.vars && typeof config.vars === "object",
    "Isolated preview must have explicit vars",
  );
  assert.equal(
    config.vars.COVE_STRANGLER_DATABASE_ID,
    expectedIsolatedId,
    "Isolated runtime must identify only its authorized staging DB",
  );
  assert.equal(config.vars.COVE_STRANGLER_MODE, "isolated-real-catalog");
  assert.equal(config.vars.COVE_SSR_STAGING, "1");
  assert.notEqual(config.vars.COVE_STRANGLER_RELEASE_CERTIFIED, "1");
  assert.equal(
    config.vars.FORE_PUBLIC_URL,
    `https://${config.name}.cove-jibrilmohamud.workers.dev`,
    "Isolated preview origin cannot point to customer infrastructure",
  );
  assert.ok(
    !Object.keys(config.vars).some((key) =>
      /^(?:COVE_RIGHTS_OWNER|COVE_LEGAL_|COVE_COMMERCE_|STRIPE_)/.test(key),
    ),
    "Legal owner and payment authority cannot be injected through preview vars",
  );
  assert.ok(
    config.observability?.enabled === false,
    "Real-catalog staging must disable Worker log collection",
  );
  if (Object.hasOwn(config, "r2_buckets")) {
    assert.deepEqual(
      config.r2_buckets,
      [{ binding: "PRESENTATION", bucket_name: "cove-strangler-private-presentation-stage" }],
      "Preview can bind only the approved isolated R2 presentation bucket",
    );
  }
  if (Object.hasOwn(config, "kv_namespaces")) {
    assert.deepEqual(
      config.kv_namespaces,
      [{ binding: "PRESENTATION_KV", id: "8245d5f2116a445d9571405b41b7c8c3" }],
      "Preview can bind only the approved isolated presentation KV namespace",
    );
  }
  return true;
}

/**
 * Minimum synthetic-vs-real fixture guard, NOT a legal snapshot certificate.
 * A true release must separately attest complete legal-owner generation,
 * withdrawal epoch, search/facet/page parity and private-data exclusions.
 * Called BEFORE any Worker upload or R2/KV seeding.
 */
export function requireMinimumRealCatalogSnapshot(readResult) {
  assert.ok(
    Array.isArray(readResult) && readResult.length === 1,
    "Incomplete full-catalog snapshot preflight response",
  );
  const one = readResult[0];
  assert.ok(
    one?.meta?.changed_db === false &&
      one.meta.changes === 0 &&
      (one.meta.rows_written === undefined || one.meta.rows_written === 0),
    "Snapshot preflight is not explicitly certified zero-write",
  );
  assert.ok(
    Array.isArray(one.results) && one.results.length === 1,
    "Missing complete snapshot preflight row",
  );
  const row = one.results[0];
  for (const name of ["products", "editions", "taxonomy_links", "rights_grants"]) {
    assert.ok(
      Number.isSafeInteger(row[name]) && row[name] >= 0,
      "Invalid isolated snapshot aggregate: " + name,
    );
  }
  assert.ok(
    row.products >= REAL_CATALOG_MINIMUM_PRODUCTS,
    "Incomplete isolated real-catalog product coverage",
  );
  assert.ok(
    row.editions >= REAL_CATALOG_MINIMUM_PRODUCTS,
    "Incomplete isolated real-catalog edition coverage",
  );
  assert.ok(
    row.taxonomy_links > 0 && row.rights_grants > 0,
    "Isolated fixture lacks taxonomy or legal-rights data",
  );
  return {
    products: row.products,
    editions: row.editions,
    taxonomyLinksPresent: true,
    grantsPresent: true,
    legalGenerationAttested: false,
    releaseCertified: false,
  };
}
