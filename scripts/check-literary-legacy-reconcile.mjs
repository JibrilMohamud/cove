import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const dir = mkdtempSync(path.join(tmpdir(), "cove-legacy-reconcile-"));
const primary = new DatabaseSync(":memory:");
const secondary = new DatabaseSync(":memory:");
let failSecondaryBatch = false;
function d1(sqlite, independent = false) {
  return {
    prepare(sql) {
      const statement = sqlite.prepare(sql);
      const bind = (...values) => ({
        async first() {
          return statement.get(...values) ?? null;
        },
        async run() {
          return statement.run(...values);
        },
        async all() {
          return { results: statement.all(...values) };
        },
      });
      return { bind, ...bind() };
    },
    async batch(statements) {
      if (independent && failSecondaryBatch) {
        failSecondaryBatch = false;
        throw Error("simulated_lost_secondary_ack");
      }
      sqlite.exec("BEGIN IMMEDIATE");
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        sqlite.exec("COMMIT");
        return results;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
  };
}
try {
  primary.exec(`
    CREATE TABLE cove_runtime_config(key TEXT PRIMARY KEY,value TEXT);
    INSERT INTO cove_runtime_config VALUES('literary_processing_owner','draining');
    CREATE TABLE literary_profile_state(id INTEGER PRIMARY KEY,lease_until TEXT DEFAULT '');
    INSERT INTO literary_profile_state VALUES(1,'');
    CREATE TABLE products(id TEXT PRIMARY KEY,edition_id TEXT);
    CREATE TABLE literary_profiles(product_id TEXT PRIMARY KEY,fingerprint TEXT,status TEXT);
    CREATE TABLE literary_profile_jobs(
      id TEXT PRIMARY KEY,product_id TEXT,fingerprint TEXT,status TEXT,
      lease_until TEXT DEFAULT ''
    );
    INSERT INTO products VALUES('p_a','e_a'),('p_b','e_b');
    INSERT INTO literary_profiles VALUES('p_a','sha_a','provisional'),('p_b','sha_b','provisional');
    INSERT INTO literary_profile_jobs VALUES('job_a','p_a','sha_a','queued','');
    INSERT INTO literary_profile_jobs VALUES('job_b','p_b','sha_b','failed','');
  `);
  secondary.exec(
    readFileSync("infra/content-budget/0001_ledger.sql", "utf8") +
      readFileSync("infra/content-budget/0008_legacy_reconcile_frontier.sql", "utf8"),
  );
  await build({
    entryPoints: ["src/lib/literary-legacy-reconcile.server.ts"],
    outfile: path.join(dir, "reconcile.mjs"),
    bundle: true,
    format: "esm",
    platform: "node",
    logLevel: "silent",
  });
  const { reconcileOneLegacyLiteraryJob } = await import(
    pathToFileURL(path.join(dir, "reconcile.mjs")).href
  );
  const env = {
    DB: d1(primary),
    CONTENT_DB: d1(secondary, true),
    FORE_CONTENT_PROCESSOR_ENABLED: "1",
    FORE_CONTENT_PREPARE_ENABLED: "1",
    FORE_CONTENT_HANDOFF_ENABLED: "1",
    FORE_CONTENT_PROCESSOR_ROLE: "literary-handoff",
    FORE_LITERARY_DRAIN_RECONCILE_ENABLED: "1",
  };
  let seeds = 0;
  const intents = new Set();
  const seed = async (_, productId, editionId) => {
    seeds++;
    assert.equal(editionId, productId === "p_a" ? "e_a" : "e_b");
    if (productId === "p_b") return { skipped: "source_or_rights_ineligible" };
    const receipt = "outbox_a";
    intents.add(receipt);
    return { outboxId: receipt, duplicate: seeds > 1 };
  };
  const cursor = () =>
    secondary.prepare("SELECT status,after_job_id FROM literary_legacy_reconcile_frontier").get();
  const count = () =>
    secondary.prepare("SELECT COUNT(*) n FROM literary_legacy_reconcile_receipts").get().n;
  assert.deepEqual(await reconcileOneLegacyLiteraryJob(
    { ...env, FORE_LITERARY_DRAIN_RECONCILE_ENABLED: "0" }, seed,
  ), { skipped: "legacy_reconciliation_disabled" });
  assert.deepEqual(await reconcileOneLegacyLiteraryJob(env, seed), {
    skipped: "legacy_reconciliation_not_armed",
  });
  secondary.prepare(
    "UPDATE literary_legacy_reconcile_frontier SET status='armed' WHERE id=1",
  ).run();
  primary.prepare("UPDATE literary_profile_state SET lease_until='2099-01-01'").run();
  assert.deepEqual(await reconcileOneLegacyLiteraryJob(env, seed), {
    skipped: "legacy_leases_not_drained",
  });
  primary.prepare("UPDATE literary_profile_state SET lease_until=''").run();
  primary.prepare("UPDATE literary_profile_jobs SET status='running',lease_until='2099-01-01' WHERE id='job_a'").run();
  assert.deepEqual(await reconcileOneLegacyLiteraryJob(env, seed), {
    skipped: "legacy_leases_not_drained",
  });
  primary.prepare("UPDATE literary_profile_jobs SET status='queued',lease_until='' WHERE id='job_a'").run();
  failSecondaryBatch = true;
  await assert.rejects(reconcileOneLegacyLiteraryJob(env, seed), /simulated_lost_secondary_ack/);
  assert.equal(cursor().after_job_id, "");
  assert.equal(count(), 0);
  assert.equal(intents.size, 1, "Primary outbox intent persists through lost ACK");
  assert.deepEqual(await reconcileOneLegacyLiteraryJob(env, seed), {
    reconciled: "job_a", disposition: "seeded", outboxId: "outbox_a",
  });
  assert.equal(seeds, 2, "Lost ACK replays same canonical outbox intent");
  assert.equal(intents.size, 1);
  assert.equal(cursor().after_job_id, "job_a");
  assert.deepEqual(await reconcileOneLegacyLiteraryJob(env, seed), {
    reconciled: "job_b", disposition: "held", reason: "source_or_rights_ineligible",
  });
  assert.equal(count(), 2);
  assert.deepEqual(await reconcileOneLegacyLiteraryJob(env, seed), { complete: true });
  assert.equal(cursor().status, "complete");
  assert.equal(
    secondary.prepare("SELECT disposition FROM literary_legacy_reconcile_receipts WHERE legacy_job_id='job_b'").get().disposition,
    "held",
  );
  primary.prepare("UPDATE cove_runtime_config SET value='isolated'").run();
  assert.deepEqual(await reconcileOneLegacyLiteraryJob(env, seed), {
    skipped: "legacy_owner_not_draining",
  });
  secondary.exec("CREATE TABLE rights_grants(id TEXT PRIMARY KEY)");
  secondary.prepare("UPDATE literary_legacy_reconcile_frontier SET status='armed'").run();
  primary.prepare("UPDATE cove_runtime_config SET value='draining'").run();
  await assert.rejects(reconcileOneLegacyLiteraryJob(env, seed), /binding_not_isolated/);
  console.log(
    "LITERARY_LEGACY_RECONCILE_PASS two physical SQLite D1s, explicit arming, live lease drain, lost ACK replay, rights holds, bounded cursor and contaminated secondary denial",
  );
} finally {
  primary.close();
  secondary.close();
  rmSync(dir, { recursive: true, force: true });
}
