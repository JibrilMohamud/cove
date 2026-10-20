import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { build } from "esbuild";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "cove-handoff-"));
const primary = new DatabaseSync(":memory:");
const secondary = new DatabaseSync(":memory:");
function wrap(db) {
  return {
    prepare(sql) {
      const stmt = db.prepare(sql);
      return {
        bind(...values) {
          return {
            async first() { return stmt.get(...values) ?? null; },
            async run() { return stmt.run(...values); },
          };
        },
        async first() { return stmt.get() ?? null; },
      };
    },
  };
}
const sha = (text) => createHash("sha256").update(text).digest("hex");
try {
  primary.exec(
    "CREATE TABLE products(id TEXT PRIMARY KEY,edition_id TEXT,source_name TEXT,source_external_id TEXT,format TEXT,storefront_status TEXT);" +
    "CREATE TABLE gutenberg_source_cache(id TEXT PRIMARY KEY,source_id TEXT,ingest_status TEXT,epub_status TEXT,rights_status TEXT,commercial_use_status TEXT,content_hash TEXT,rights_territories_json TEXT);" +
    "CREATE TABLE rights_grants(id TEXT PRIMARY KEY,edition_id TEXT,format TEXT,sales_channel TEXT,status TEXT,decision TEXT,source TEXT,territory_code TEXT,starts_at TEXT,ends_at TEXT);" +
    readFileSync("infra/content-budget/0004_literary_handoff_outbox_primary.sql","utf8"),
  );
  secondary.exec(
    readFileSync("infra/content-budget/0001_ledger.sql","utf8") +
    readFileSync("infra/content-budget/0002_preparation_queue.sql","utf8"),
  );
  await build({
    entryPoints: ["src/lib/literary-prepare-outbox.server.ts"],
    outfile: path.join(root,"handoff.mjs"),
    bundle: true,
    platform: "node",
    format: "esm",
    logLevel: "silent",
  });
  const { seedLiteraryPreparationHandoff, dispatchOneLiteraryPreparationHandoff } =
    await import(path.join(root,"handoff.mjs"));
  const env = {
    DB: wrap(primary), CONTENT_DB: wrap(secondary), BUCKET: {},
    FORE_CONTENT_PROCESSOR_ENABLED: "1",
    FORE_CONTENT_PREPARE_ENABLED: "1",
    FORE_CONTENT_HANDOFF_ENABLED: "1",
    FORE_CONTENT_PROCESSOR_ROLE: "literary-handoff",
  };
  function fixture(suffix, hash = "a".repeat(64)) {
    primary.prepare("INSERT INTO products VALUES(?,?,?,?,?,?)")
      .run("p_"+suffix, "e_"+suffix, "gutenberg", "pgau_"+suffix, "ebook", "active");
    primary.prepare("INSERT INTO gutenberg_source_cache VALUES(?,?,?,?,?,?,?,?)")
      .run("pgau_"+suffix,"pg_au","active","completed","public-domain","approved",hash,'["AU"]');
    primary.prepare("INSERT INTO rights_grants VALUES(?,?,?,?,?,?,?,?,?,?)")
      .run("g_"+suffix,"e_"+suffix,"ebook","retail","active","allow","gutenberg-pg_au-public-domain","AU",null,null);
  }
  fixture("a");
  assert.rejects(seedLiteraryPreparationHandoff(
    { ...env, FORE_CONTENT_HANDOFF_ENABLED: "0" },"p_a","e_a",
  ), /disabled/);
  const first = await seedLiteraryPreparationHandoff(env,"p_a","e_a");
  assert.equal(first.outboxId,sha(["p_a","e_a","pgau_a","a".repeat(64)].join(":")));
  assert.equal(first.duplicate,false);
  assert.equal((await seedLiteraryPreparationHandoff(env,"p_a","e_a")).duplicate,true);
  assert.equal(primary.prepare("SELECT COUNT(*) n FROM literary_prepare_outbox").get().n,1);
  assert.equal(secondary.prepare("SELECT COUNT(*) n FROM literary_prepare_jobs").get().n,0);
  const sent=await dispatchOneLiteraryPreparationHandoff(env);
  assert.equal(sent.delivered,first.outboxId);
  assert.equal(primary.prepare("SELECT status FROM literary_prepare_outbox").get().status,"delivered");
  assert.equal(secondary.prepare("SELECT COUNT(*) n FROM literary_prepare_jobs").get().n,1);
  assert.deepEqual(await dispatchOneLiteraryPreparationHandoff(env),{skipped:"no_handoffs"});

  // ACK lost after independent enqueue: redrive is exactly the same
  // pinned content id, and INSERT OR IGNORE in secondary is harmless.
  primary.prepare("UPDATE literary_prepare_outbox SET status='queued',attempts=0,available_at='2020-01-01' WHERE id=?").run(first.outboxId);
  const replay=await dispatchOneLiteraryPreparationHandoff(env);
  assert.equal(replay.delivered,first.outboxId);
  assert.equal(secondary.prepare("SELECT COUNT(*) n FROM literary_prepare_jobs").get().n,1);

  fixture("denied");
  primary.prepare("INSERT INTO rights_grants VALUES(?,?,?,?,?,?,?,?,?,?)")
    .run("deny", "e_denied", "ebook", "retail", "active","deny","manual","AU",null,null);
  assert.deepEqual(await seedLiteraryPreparationHandoff(env,"p_denied","e_denied"), {
    skipped:"source_or_rights_ineligible",
  });
  primary.prepare("DELETE FROM rights_grants WHERE id='deny'").run();
  const accepted=await seedLiteraryPreparationHandoff(env,"p_denied","e_denied");
  primary.prepare("UPDATE rights_grants SET status='revoked' WHERE id='g_denied'").run();
  const cancelled=await dispatchOneLiteraryPreparationHandoff(env);
  assert.equal(cancelled.cancelled,accepted.outboxId);
  assert.equal(secondary.prepare("SELECT COUNT(*) n FROM literary_prepare_jobs").get().n,1);

  fixture("changed");
  const pinned=await seedLiteraryPreparationHandoff(env,"p_changed","e_changed");
  primary.prepare("UPDATE gutenberg_source_cache SET content_hash=? WHERE id='pgau_changed'")
    .run("b".repeat(64));
  const stale=await dispatchOneLiteraryPreparationHandoff(env);
  assert.equal(stale.cancelled,pinned.outboxId);
  assert.equal(stale.reason,"source_changed");
  assert.equal(secondary.prepare("SELECT COUNT(*) n FROM literary_prepare_jobs").get().n,1);

  // Exhausted expired leases are terminalized and cannot run forever.
  fixture("expired");
  const exp=await seedLiteraryPreparationHandoff(env,"p_expired","e_expired");
  primary.prepare(
    "UPDATE literary_prepare_outbox SET status='running',attempts=4,lease_token='old'," +
    "lease_until='2020-01-01' WHERE id=?",
  ).run(exp.outboxId);
  await dispatchOneLiteraryPreparationHandoff(env);
  assert.equal(primary.prepare("SELECT status FROM literary_prepare_outbox WHERE id=?").get(exp.outboxId).status,"failed");

  await assert.rejects(
    dispatchOneLiteraryPreparationHandoff({ ...env, CONTENT_DB: env.DB }),
    /disabled/,
  );
  secondary.exec("CREATE TABLE products(id TEXT PRIMARY KEY)");
  fixture("contaminated");
  await seedLiteraryPreparationHandoff(env,"p_contaminated","e_contaminated");
  const failed=await dispatchOneLiteraryPreparationHandoff(env);
  assert.equal(failed.failed !== undefined,true);
  assert.match(failed.reason,/binding_not_isolated/);
  assert.equal(secondary.prepare("SELECT COUNT(*) n FROM literary_prepare_jobs").get().n,1);
  console.log("Durable one-at-a-time two-D1 outbox: source/rights fencing, ACK retry, replay idempotency, revocation, changed SHA and binding containment PASS");
} finally {
  primary.close();secondary.close();
  fs.rmSync(root,{recursive:true,force:true});
}
