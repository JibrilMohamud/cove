import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

/** Private-source fixture. TWO independent SQLite instances simulate DO/D1. */
const temp = mkdtempSync(path.join(tmpdir(), "cove-seo-cross-owner-"));
const legal = new DatabaseSync(":memory:");
const primary = new DatabaseSync(":memory:");
try {
  await build({
    entryPoints: [
      "src/storefront-strangler/seo-owner-denial-epoch.ts",
      "src/storefront-strangler/seo-owner-denial-read.server.ts",
      "src/features/fore/seo-count-projection.ts",
      "src/features/fore/seo.server.ts",
    ],
    outdir: temp, entryNames: "[name]", bundle: true, platform: "node",
    format: "esm", outExtension: { ".js": ".mjs" }, logLevel: "silent",
  });
  const mod = async (filename) => import(pathToFileURL(path.join(temp, filename + ".mjs")).href);
  const {
    createSeoOwnerDenialEpochSchema, readSeoOwnerDenialEpoch, withSeoOwnerDenialEpoch,
    seoOwnerDenialProof, SEO_OWNER_DENIAL_ROUTE,
  } = await mod("seo-owner-denial-epoch");
  const { loadSeoCountEvidenceWithOwner, readFreshSeoOwnerDenialProof } =
    await mod("seo-owner-denial-read.server");
  const { verifiedSeoCountsForServing, verifiedSeoCounts } = await mod("seo-count-projection");
  const { handleSeoDocumentRequest } = await mod("seo.server");

  const legalSql = {
    exec(query, ...args) {
      const statement = legal.prepare(query);
      const rows = /^(?:\s*SELECT|\s*UPDATE[\s\S]*RETURNING)/i.test(query) ?
        statement.all(...args) : (statement.run(...args), []);
      return { toArray: () => rows };
    },
  };
  const transactionSync = (callback) => {
    legal.exec("BEGIN IMMEDIATE");
    try {
      const value = callback();
      legal.exec("COMMIT");
      return value;
    } catch (error) {
      legal.exec("ROLLBACK");
      throw error;
    }
  };
  createSeoOwnerDenialEpochSchema(legalSql);
  legal.exec("CREATE TABLE legal_denial_events(id TEXT PRIMARY KEY, status TEXT NOT NULL)");
  assert.equal(readSeoOwnerDenialEpoch(legalSql), 0);

  const script = readFileSync("scripts/staging/seo-primary-count-fence.prototype.sql", "utf8");
  primary.exec(script.slice(0, script.indexOf("CREATE TRIGGER")));
  const ownerVersion = "isolated-owner-451";
  primary.prepare("UPDATE cove_seo_primary_fence SET owner_version=?,dirty=0 WHERE slot=1")
    .run(ownerVersion);
  primary.prepare(
    `INSERT INTO cove_seo_count_snapshots(
      slot,owner_version,owner_denial_epoch,catalog_generation,rights_generation,
      withdrawal_generation,taxonomy_generation,contributor_generation,built_at_ms,
      expires_at_ms,books_count,works_count,editions_count,authors_count,categories_count
    ) VALUES(1,?,0,0,0,0,0,0,?,?,?,?,?,?,?)`
  ).run(ownerVersion, Date.now(), Date.now() + 25_000, 100, 75, 100, 30, 4);
  let primaryReads = 0;
  const d1 = {
    withSession(consistency) {
      assert.equal(consistency, "first-primary");
      return {
        prepare(sql) {
          const params = [];
          return {
            bind(...args) { params.splice(0, params.length, ...args); return this; },
            async first() {
              primaryReads++;
              return primary.prepare(sql).get(...params) || null;
            },
          };
        },
      };
    },
  };
  const witness = {
    primaryId: "4bd657ac-8789-403e-a28c-93aba8d0a989",
    ownerVersion, ownerEnabled: true, exclusiveWriter: true, authorizing: true,
  };
  const secret = "a".repeat(64);
  let ownerReads = 0;
  let unavailable = false;
  let cacheViolation = false;
  let badChallenge = false;
  const owner = {
    async fetch(request) {
      ownerReads++;
      assert.equal(new URL(request.url).pathname, SEO_OWNER_DENIAL_ROUTE);
      assert.equal(request.method, "POST");
      assert.equal(request.headers.get("authorization"), "Bearer " + secret);
      assert.equal(request.headers.get("cache-control"), "no-store");
      const input = await request.json();
      const proof = seoOwnerDenialProof(legalSql, ownerVersion, input.challenge);
      if (badChallenge) proof.challenge = "0".repeat(32);
      return new Response(JSON.stringify(proof), {
        status: unavailable ? 503 : 200,
        headers: {
          "content-type": "application/json",
          "cache-control": cacheViolation ? "public, max-age=900" : "no-store",
        },
      });
    },
  };
  const load = () => loadSeoCountEvidenceWithOwner(d1, witness, owner, secret);
  const request = () => new Request("https://covereads.com/sitemap.xml");
  const serve = () => handleSeoDocumentRequest(request(), d1, undefined, load);

  let evidence = await load();
  assert.deepEqual(verifiedSeoCountsForServing(evidence, Date.now()), {
    books: 100, works: 75, editions: 100, authors: 30, categories: 4,
  });
  const initially = await serve();
  assert.equal(initially.status, 200);
  assert.equal(initially.headers.get("cache-control"), "no-store");

  // Owner confirms withdrawal DURABLY before D1 has been touched. The
  // separate D1-only proof remains valid, but serving MUST reject it.
  const receipt = withSeoOwnerDenialEpoch(legalSql, "withdraw-1", transactionSync, () => {
    legal.prepare("INSERT INTO legal_denial_events(id,status) VALUES(?,?)")
      .run("withdraw-1", "denied");
    return { applied: true };
  });
  assert.deepEqual(receipt, { applied: true, replayed: false, epoch: 1 });
  assert.equal(readSeoOwnerDenialEpoch(legalSql), 1);
  assert.equal(primary.prepare("SELECT owner_denial_epoch FROM cove_seo_primary_fence").get().owner_denial_epoch, 0);
  evidence = await load();
  assert.equal(verifiedSeoCounts(evidence, Date.now()).works, 75,
    "primary-only generation cannot detect a deny-first owner gap");
  assert.equal(verifiedSeoCountsForServing(evidence, Date.now()), null);
  const failClosed = await serve();
  assert.equal(failClosed.status, 503);
  assert.equal(failClosed.headers.get("cache-control"), "no-store");
  assert.doesNotMatch(await failClosed.text(), /sitemaps/books|sitemaps/works/);

  // Failed, uncommitted denials cannot advance the owner epoch or leave
  // a partial event. SQLite rolls back both the deny and the counter.
  assert.throws(() => withSeoOwnerDenialEpoch(legalSql, "withdraw-failed", transactionSync, () => {
    legal.prepare("INSERT INTO legal_denial_events(id,status) VALUES(?,?)")
      .run("withdraw-failed", "denied");
    return { applied: false };
  }), /seo_owner_denial_not_durable/);
  assert.equal(readSeoOwnerDenialEpoch(legalSql), 1);
  assert.equal(legal.prepare("SELECT count(*) n FROM legal_denial_events WHERE id='withdraw-failed'").get().n, 0);

  // A duplicate callback acknowledged by the canonical owner cannot advance
  // a second global epoch for an idempotent operation.
  const replay = withSeoOwnerDenialEpoch(legalSql, "withdraw-1", transactionSync,
    () => ({ applied: true }));
  assert.deepEqual(replay, { applied: true, replayed: true, epoch: 1 });
  assert.equal(readSeoOwnerDenialEpoch(legalSql), 1);

  // D1 reconciliation after the committed legal write invalidates the old
  // snapshot. Until rebuilt, even matching D1 and DO epochs must fail closed.
  primary.prepare(
    "UPDATE cove_seo_primary_fence SET owner_denial_epoch=1,rights_generation=1,withdrawal_generation=1 WHERE slot=1"
  ).run();
  assert.equal(verifiedSeoCountsForServing(await load(), Date.now()), null);
  const now = Date.now();
  primary.prepare(
    `UPDATE cove_seo_count_snapshots SET owner_denial_epoch=1,
      rights_generation=1,withdrawal_generation=1,
      works_count=74,built_at_ms=?,expires_at_ms=? WHERE slot=1`
  ).run(now, now + 25_000);
  assert.equal(verifiedSeoCountsForServing(await load(), Date.now()).works, 74);
  assert.equal((await serve()).status, 200);

  // A new DO withdrawal immediately fails again, without waiting for D1
  // or a TTL. Wrong challenge, wrong cache policy or owner 503 also deny.
  withSeoOwnerDenialEpoch(legalSql, "withdraw-2", transactionSync,
    () => ({ applied: true }));
  assert.equal((await serve()).status, 503);
  unavailable = true;
  await assert.rejects(load, /seo_owner_proof_unavailable/);
  assert.equal((await serve()).status, 503);
  unavailable = false;
  cacheViolation = true;
  await assert.rejects(load, /seo_owner_proof_unavailable/);
  cacheViolation = false;
  badChallenge = true;
  await assert.rejects(load, /seo_owner_proof_invalid/);
  badChallenge = false;
  await assert.rejects(
    () => readFreshSeoOwnerDenialProof(owner, "not-a-secret", ownerVersion),
    /seo_owner_proof_binding_invalid/
  );
  assert.ok(ownerReads > 6);
  assert.ok(primaryReads >= ownerReads - 1);
  console.log("PASS: two-db DO deny-first gap, atomic owner epoch, D1 reconciliation, challenge and no-store failures");
} finally {
  primary.close();
  legal.close();
  rmSync(temp, { recursive: true, force: true });
}
