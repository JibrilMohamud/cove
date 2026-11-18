import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

/** Offline D1-compatible SQLite fixture only: no staging/prod Cloudflare SQL. */
const temp = mkdtempSync(path.join(os.tmpdir(), "cove-seo-primary-cas-"));
const db = new DatabaseSync(":memory:");
try {
  const tables = {
    catalog: ["works", "editions", "products"],
    contributor: ["contributors", "edition_contributors", "work_contributors"],
    taxonomy: ["storefront_taxonomies", "storefront_taxonomy_nodes"],
    rights: [
      "rights_grants", "rights_grant_territories", "rights_contracts",
      "rights_contract_languages", "rights_contract_versions",
      "rights_contract_version_territories", "rights_contract_version_formats",
      "rights_contract_version_channels",
    ],
  };
  for (const name of Object.values(tables).flat())
    db.exec("CREATE TABLE " + name + " (id TEXT PRIMARY KEY, state TEXT);");

  const schema = readFileSync("scripts/staging/seo-primary-count-fence.prototype.sql", "utf8");
  assert.doesNotMatch(schema, /BEGIN\s+TRANSACTION|PRAGMA\s+writable_schema/i);
  db.exec(schema);

  const triggerRows = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'seo_gen_%'"
  ).all();
  assert.equal(triggerRows.length, 48, "all sixteen mutation table families need INSERT/UPDATE/DELETE triggers");
  let before = db.prepare("SELECT * FROM cove_seo_primary_fence WHERE slot=1").get();
  assert.equal(before.dirty, 1, "migration MUST start sealed and unavailable");
  assert.equal(before.catalog_generation, 0);

  // Independent values per source mutation category. Same SQLite statement as
  // the write increments the fence. Undo of a mutation must undo its epoch.
  for (const [family, names] of Object.entries(tables)) {
    for (const name of names) {
      db.prepare("INSERT INTO " + name + "(id,state) VALUES(?,?)").run("a", "active");
      db.prepare("UPDATE " + name + " SET state=? WHERE id=?").run("revoked", "a");
      db.prepare("DELETE FROM " + name + " WHERE id=?").run("a");
    }
  }
  const after = db.prepare("SELECT * FROM cove_seo_primary_fence WHERE slot=1").get();
  assert.equal(after.catalog_generation, 9);
  assert.equal(after.rights_generation, 24);
  assert.equal(after.taxonomy_generation, 6);
  assert.equal(after.contributor_generation, 9);
  assert.equal(after.withdrawal_generation, 9 + 24);

  const baseline = db.prepare("SELECT catalog_generation FROM cove_seo_primary_fence").get();
  db.exec("BEGIN");
  db.prepare("INSERT INTO works(id) VALUES(?)").run("rollback-test");
  db.exec("ROLLBACK");
  assert.equal(db.prepare("SELECT catalog_generation FROM cove_seo_primary_fence").get().catalog_generation,
    baseline.catalog_generation, "rolled back catalog mutation must not invalidate committed epoch");

  await build({
    entryPoints: [
      "src/features/fore/seo-count-projection.ts",
      "src/features/fore/seo-count-projection-producer.ts",
      "src/storefront-strangler/seo-primary-d1-counts.server.ts",
    ],
    outdir: temp, entryNames: "[name]", platform: "node",
    bundle: true, format: "esm",
    outExtension: { ".js": ".mjs" }, logLevel: "silent",
  });
  const { buildSeoCountProjection } = await import(pathToFileURL(
    path.join(temp, "seo-count-projection-producer.mjs")).href);
  const { verifiedSeoCounts } = await import(pathToFileURL(
    path.join(temp, "seo-count-projection.mjs")).href);
  const { readSeoCountEvidence, readSeoPrimaryFence, publishSeoCountCas,
    seoCountPrimaryBuildPort, SEO_PRIMARY_ID } = await import(pathToFileURL(
      path.join(temp, "seo-primary-d1-counts.server.mjs")).href);

  let primarySessionCalls = 0;
  const d1 = {
    withSession(constraint) {
      assert.equal(constraint, "first-primary", "a replica must never furnish SEO authority");
      primarySessionCalls++;
      return {
        prepare(query) {
          const values = [];
          return {
            bind(...args) { values.splice(0, values.length, ...args); return this; },
            async first() { return db.prepare(query).get(...values) || null; },
          };
        },
      };
    },
  };
  const witness = {
    primaryId: SEO_PRIMARY_ID,
    ownerVersion: "isolated-test-451", ownerEnabled: true,
    exclusiveWriter: true, authorizing: true,
  };
  // No positive owner version exists in the dirty-by-default schema.
  // A caller asserting authority cannot turn a missing owner into a witness.
  await assert.rejects(() => readSeoPrimaryFence(d1, witness), /seo_primary_owner_version_mismatch/);
  let heavyCounts = 0;
  const currentCounts = { books: 6, works: 4, editions: 5, authors: 3, categories: 2 };
  const now = 1794950000000;
  const port = () => seoCountPrimaryBuildPort(d1, witness, async (kind) => {
    heavyCounts++;
    return currentCounts[kind];
  }, () => now);

  assert.deepEqual(await buildSeoCountProjection(port()), {
    published: false, reason: "unavailable",
  });
  assert.equal(heavyCounts, 0);
  await assert.rejects(() => readSeoCountEvidence(d1, witness), /seo_primary_owner_version_mismatch/);

  // This unseals *only* our local fixture. Production owner remains disabled.
  db.prepare("UPDATE cove_seo_primary_fence SET owner_version=?,dirty=0 WHERE slot=1")
    .run(witness.ownerVersion);
  const seededPort = port();
  const good = await buildSeoCountProjection({
    ...seededPort,
    compareAndPublish: async (expected, snapshot) => {
      try {
        return await seededPort.compareAndPublish(expected, snapshot);
      } catch (error) {
        throw new Error("local_primary_cas_failure:" +
          (error instanceof Error ? error.message : "unknown"));
      }
    },
  });
  assert.deepEqual(good, { published: true, reason: "published" });
  assert.equal(heavyCounts, 5);
  const evidence = await readSeoCountEvidence(d1, witness);
  assert.equal(verifiedSeoCounts(evidence, now).works, 4);
  const oldFence = structuredClone(evidence.fence);
  const oldSnapshot = structuredClone(evidence.snapshot);

  // Revoke via an ordinary catalog/rights table write. No sidecar invalidation
  // can be forgotten: the trigger bumps primary epoch within the same commit.
  db.prepare("INSERT INTO rights_grants(id,state) VALUES(?,?)").run("right-123", "revoked");
  assert.equal(verifiedSeoCounts(await readSeoCountEvidence(d1, witness), now), null);
  assert.equal(await publishSeoCountCas(d1, witness, oldFence, oldSnapshot), false,
    "old producer cannot publish after rights withdrawal");

  // No older background job may overwrite a newer snapshot even on same epoch.
  assert.equal((await buildSeoCountProjection(port())).published, false,
    "a completed producer with the same timestamp may not overwrite prior result");
  const later = now + 100;
  const laterPort = seoCountPrimaryBuildPort(d1, witness, async (kind) => currentCounts[kind], () => later);
  assert.equal((await buildSeoCountProjection(laterPort)).published, true);
  assert.equal(verifiedSeoCounts(await readSeoCountEvidence(d1, witness), later).works, 4);

  const second = await readSeoCountEvidence(d1, witness);
  const beforeDirty = structuredClone(second.snapshot);
  db.prepare("UPDATE cove_seo_primary_fence SET dirty=1 WHERE slot=1").run();
  assert.equal(verifiedSeoCounts(await readSeoCountEvidence(d1, witness), later), null);
  assert.equal(await publishSeoCountCas(d1, witness, second.fence, beforeDirty), false);
  db.prepare("UPDATE cove_seo_primary_fence SET dirty=0,pending_withdrawals=1 WHERE slot=1").run();
  assert.equal(await publishSeoCountCas(d1, witness, second.fence, beforeDirty), false);
  db.prepare("UPDATE cove_seo_primary_fence SET pending_withdrawals=0,pending_writes=1 WHERE slot=1").run();
  assert.equal(await publishSeoCountCas(d1, witness, second.fence, beforeDirty), false);
  db.prepare("UPDATE cove_seo_primary_fence SET pending_writes=0 WHERE slot=1").run();

  // A second read cannot close a publish race; the atomic SQL predicate must.
  const preRace = await readSeoPrimaryFence(d1, witness);
  const raceResult = await buildSeoCountProjection({
    ...seoCountPrimaryBuildPort(d1, witness, async (kind) => currentCounts[kind], () => later + 20),
    compareAndPublish: async (expected, snapshot) => {
      db.prepare("INSERT INTO products(id) VALUES(?)").run("withdrawn-during-cas");
      return publishSeoCountCas(d1, witness, expected, snapshot);
    },
  });
  assert.deepEqual(raceResult, { published: false, reason: "publish-lost-race" });
  assert.notDeepEqual(preRace, await readSeoPrimaryFence(d1, witness));

  await assert.rejects(
    () => readSeoPrimaryFence(d1, { ...witness, exclusiveWriter: false }),
    /seo_owner_not_certified/
  );
  await assert.rejects(
    () => readSeoPrimaryFence({ withSession: () => { throw new Error("replica session"); } }, witness),
    /replica session/
  );
  assert.ok(primarySessionCalls >= 10);

  console.log("PASS: staging-only SQL trigger generations and single-statement primary-D1 CAS deny stale/dirty/withdrawn writes");
} finally {
  db.close();
  rmSync(temp, { recursive: true, force: true });
}
