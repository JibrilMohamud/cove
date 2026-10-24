import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { build } from "esbuild";

const dir = mkdtempSync(path.join(tmpdir(), "cove-isolated-lit-infer-"));
const primary = new DatabaseSync(":memory:");
const content = new DatabaseSync(":memory:");
const sha = (v) => createHash("sha256").update(v).digest("hex");
function db(sqlite) {
  return {
    prepare(sql) {
      const p = sqlite.prepare(sql);
      return {
        bind(...values) {
          return {
            async first() {
              return p.get(...values) ?? null;
            },
            async run() {
              return p.run(...values);
            },
            async all() {
              return { results: p.all(...values) };
            },
          };
        },
        async first() {
          return p.get() ?? null;
        },
        async run() {
          return p.run();
        },
        async all() {
          return { results: p.all() };
        },
      };
    },
    async batch(stmts) {
      return Promise.all(stmts.map((x) => x.run()));
    },
  };
}
const blobs = new Map();
let tamper = false,
  aiCalls = 0,
  simulateCollision = true,
  primaryWrites = 0;
const originalPrimaryPrepare = primary.prepare.bind(primary);
try {
  primary.exec(
    "CREATE TABLE cove_runtime_config(key TEXT PRIMARY KEY,value TEXT);" +
      "INSERT INTO cove_runtime_config VALUES('literary_budget_domain','isolated');" +
      "CREATE TABLE products(id TEXT PRIMARY KEY,edition_id TEXT,source_name TEXT,source_external_id TEXT,format TEXT,storefront_status TEXT);" +
      "CREATE TABLE gutenberg_source_cache(id TEXT PRIMARY KEY,source_id TEXT,ingest_status TEXT,epub_status TEXT,rights_status TEXT,commercial_use_status TEXT,content_hash TEXT,rights_territories_json TEXT);" +
      "CREATE TABLE rights_grants(id TEXT PRIMARY KEY,edition_id TEXT,format TEXT,sales_channel TEXT,status TEXT,decision TEXT,source TEXT,territory_code TEXT,starts_at TEXT,ends_at TEXT);" +
      "CREATE TABLE literary_profiles(product_id TEXT PRIMARY KEY,fingerprint TEXT,revision INTEGER NOT NULL DEFAULT 0,profile_json TEXT,status TEXT,coverage TEXT,policy_version TEXT,updated_at TEXT);" +
      readFileSync("infra/content-budget/0004_literary_handoff_outbox_primary.sql", "utf8"),
  );
  content.exec(
    readFileSync("infra/content-budget/0001_ledger.sql", "utf8") +
      readFileSync("infra/content-budget/0002_preparation_queue.sql", "utf8") +
      readFileSync("infra/content-budget/0005_literary_output_settlement_receipts.sql", "utf8") +
      readFileSync("infra/content-budget/0006_isolated_inference.sql", "utf8") +
      readFileSync("infra/content-budget/0007_inference_seed_frontier.sql", "utf8"),
  );
  await build({
    entryPoints: ["src/lib/literary-isolated-inference.server.ts"],
    outfile: path.join(dir, "inference.mjs"),
    bundle: true,
    platform: "node",
    format: "esm",
    logLevel: "silent",
  });
  await build({
    entryPoints: ["src/features/fore/literary-profile.ts"],
    outfile: path.join(dir, "profile.mjs"),
    bundle: true,
    platform: "node",
    format: "esm",
    logLevel: "silent",
  });
  const {
    seedOneIsolatedLiteraryInference,
    runIsolatedLiteraryInferenceTick,
    publishIsolatedLiteraryInference,
  } = await import(path.join(dir, "inference.mjs"));
  const { emptyLiteraryProfile, PROFILE_POLICY } = await import(path.join(dir, "profile.mjs"));
  const sourceHash = "a".repeat(64),
    fingerprint = "b".repeat(64),
    prepareId = "c".repeat(64);
  const prepKey = "literary/isolated-prepared-v1/" + prepareId + ".json";
  const prep = JSON.stringify({
    version: 1,
    productId: "p_a",
    editionId: "e_a",
    sourceId: "pg_a",
    sourceSha256: sourceHash,
    totalSections: 1,
    truncated: false,
    selected: [
      {
        id: "s_a",
        spineIndex: 0,
        href: "chapter.xhtml",
        locator: [0, 200],
        text: "A silent lake and a reflective quiet morning. ".repeat(35),
      },
    ],
  });
  const r2put = (key, body, options) => {
    const data = new TextEncoder().encode(body);
    blobs.set(key, {
      data,
      metadata: options.customMetadata,
      contentType: options.httpMetadata.contentType,
    });
  };
  r2put(prepKey, prep, {
    customMetadata: { sha256: sha(prep) },
    httpMetadata: { contentType: "application/json" },
  });
  const BUCKET = {
    async get(key) {
      const x = blobs.get(key);
      if (!x) return null;
      const bytes =
        tamper && key.startsWith("literary/isolated-inference-v1/")
          ? new TextEncoder().encode(new TextDecoder().decode(x.data) + "tampered")
          : x.data;
      return {
        size: bytes.byteLength,
        customMetadata: x.metadata,
        httpMetadata: { contentType: x.contentType },
        async arrayBuffer() {
          return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
        },
      };
    },
    async head(key) {
      const x = blobs.get(key);
      return x
        ? {
            size: x.data.byteLength,
            customMetadata: x.metadata,
            httpMetadata: { contentType: x.contentType },
          }
        : null;
    },
    async put(key, body, options) {
      assert.match(key, /^literary\/isolated-inference-v1\/[0-9a-f]{64}\.json$/);
      assert.equal(options.customMetadata.sha256, sha(body));
      assert.deepEqual(options.onlyIf, { etagDoesNotMatch: "*" });
      if (simulateCollision) {
        // Another lease owner commits a different, still valid JSON encoding
        // between HEAD and PUT. The late writer must adopt this exact SHA.
        simulateCollision = false;
        const competing = JSON.stringify(JSON.parse(body), null, 2);
        assert.notEqual(sha(competing), sha(body));
        r2put(key, competing, {
          ...options,
          customMetadata: { sha256: sha(competing) },
        });
        return null;
      }
      if (blobs.has(key)) return null;
      r2put(key, body, options);
      return { key };
    },
  };
  primary
    .prepare("INSERT INTO products VALUES('p_a','e_a','gutenberg','pg_a','ebook','active')")
    .run();
  primary
    .prepare("INSERT INTO gutenberg_source_cache VALUES(?,?,?,?,?,?,?,?)")
    .run("pg_a", "pg", "active", "completed", "public-domain", "approved", sourceHash, '["AU"]');
  primary
    .prepare("INSERT INTO rights_grants VALUES(?,?,?,?,?,?,?,?,?,?)")
    .run(
      "allow",
      "e_a",
      "ebook",
      "retail",
      "active",
      "allow",
      "gutenberg-pg-public-domain",
      "AU",
      null,
      null,
    );
  primary
    .prepare("INSERT INTO literary_profiles VALUES(?,?,?,?,?,?,?,?)")
    .run("p_a", fingerprint, 0, "{}", "provisional", "metadata", PROFILE_POLICY, "2026-10-23");
  const now = new Date().toISOString(),
    day = now.slice(0, 10);
  content
    .prepare("INSERT INTO literary_budget_cutover VALUES(?,?,?,?,?,?,?)")
    .run(day, "active", 0, 0, now, now, "fixture-approved-no-production");
  content
    .prepare(
      "INSERT INTO literary_prepare_jobs(id,product_id,edition_id,source_id,content_sha256," +
        "status,attempts,available_at,result_key,result_sha256,created_at,updated_at)" +
        " VALUES(?,?,?,?,?,'done',1,?,?,?,?,?)",
    )
    .run(prepareId, "p_a", "e_a", "pg_a", sourceHash, now, prepKey, sha(prep), now, now);
  const env = {
    DB: db(primary),
    CONTENT_DB: db(content),
    BUCKET,
    FORE_CONTENT_PROCESSOR_ENABLED: "1",
    FORE_CONTENT_PREPARE_ENABLED: "1",
    FORE_CONTENT_INFERENCE_ENABLED: "1",
    FORE_CONTENT_PROCESSOR_ROLE: "literary-infer",
    FORE_CONTENT_BUDGET_MODE: "isolated",
    FORE_LITERARY_INFERENCE_PUBLISH_ENABLED: "1",
    AI: {
      async run() {
        aiCalls++;
        assert.equal(
          primary.prepare("SELECT status FROM literary_profiles").get().status,
          "provisional",
        );
        return { response: JSON.stringify(emptyLiteraryProfile()) };
      },
    },
  };
  await assert.rejects(
    seedOneIsolatedLiteraryInference({ ...env, FORE_CONTENT_INFERENCE_ENABLED: "0" }),
    /disabled/,
  );
  assert.deepEqual(
    await runIsolatedLiteraryInferenceTick({ ...env, FORE_CONTENT_INFERENCE_ENABLED: "0" }).catch(
      (e) => ({ error: e.message }),
    ),
    { error: "isolated_literary_inference_disabled" },
  );
  // The oldest completed job is stale; it cannot starve a newer valid book.
  content
    .prepare(
      "INSERT INTO literary_prepare_jobs(id,product_id,edition_id,source_id,content_sha256," +
        "status,attempts,available_at,result_key,result_sha256,created_at,updated_at)" +
        " VALUES(?,?,?,?,?,'done',1,?,?,?,?,?)",
    )
    .run(
      "d".repeat(64),
      "p_stale",
      "e_stale",
      "pg_stale",
      sourceHash,
      "2020-01-01",
      "literary/isolated-prepared-v1/" + "d".repeat(64) + ".json",
      sha(prep),
      "2020-01-01",
      "2020-01-01",
    );
  const before = primary.prepare("SELECT total_changes() n").get().n;
  assert.deepEqual(
    await seedOneIsolatedLiteraryInference(env),
    {
      skipped: "source_or_rights_changed",
    },
    "Stale rights must not block independent queue advancement",
  );
  const seeded = await seedOneIsolatedLiteraryInference(env);
  assert.match(seeded.enqueued, /^[0-9a-f]{64}$/);
  assert.equal(content.prepare("SELECT COUNT(*) n FROM literary_inference_jobs").get().n, 1);
  assert.equal(
    primary.prepare("SELECT total_changes() n").get().n,
    before,
    "Seed and inference claims must never write source/rights/reader DB",
  );
  const got = await runIsolatedLiteraryInferenceTick(env);
  assert.equal(got.inferred, seeded.enqueued);
  assert.equal(aiCalls, 1);
  assert.equal(simulateCollision, false, "An R2 create-if-absent collision must be exercised");
  const inferenceReceipt = content
    .prepare("SELECT result_key,result_sha256 FROM literary_inference_jobs WHERE id=?")
    .get(seeded.enqueued);
  const acceptedBytes = blobs.get(inferenceReceipt.result_key).data;
  assert.equal(inferenceReceipt.result_sha256, sha(acceptedBytes));
  assert.equal(
    inferenceReceipt.result_sha256,
    blobs.get(inferenceReceipt.result_key).metadata.sha256,
    "The secondary receipt must refer to the winner, not the losing inference result",
  );
  const lateWrite = await BUCKET.put(inferenceReceipt.result_key, "late overwritten data", {
    onlyIf: { etagDoesNotMatch: "*" },
    httpMetadata: { contentType: "application/json" },
    customMetadata: { sha256: sha("late overwritten data") },
  });
  assert.equal(lateWrite, null, "A late lease owner must not replace the committed R2 bytes");
  assert.equal(sha(blobs.get(inferenceReceipt.result_key).data), inferenceReceipt.result_sha256);
  assert.equal(primary.prepare("SELECT total_changes() n").get().n, before);
  const quota = content.prepare("SELECT calls,reserved_units FROM literary_profile_budget").get();
  assert.equal(quota.calls, 1);
  assert.ok(quota.reserved_units > 0);
  assert.equal(primary.prepare("SELECT status FROM literary_profiles").get().status, "provisional");
  assert.deepEqual(
    await publishIsolatedLiteraryInference(
      { ...env, FORE_LITERARY_INFERENCE_PUBLISH_ENABLED: "0" },
      seeded.enqueued,
    ).catch((e) => ({ error: e.message })),
    { error: "literary_inference_publication_disabled" },
  );
  assert.deepEqual(await publishIsolatedLiteraryInference(env, seeded.enqueued), {
    skipped: "canonical_owner_not_isolated",
  });
  assert.equal(primary.prepare("SELECT status FROM literary_profiles").get().status, "provisional");
  primary
    .prepare("INSERT INTO cove_runtime_config VALUES('literary_processing_owner','isolated')")
    .run();
  // The current explicit same-territory deny must defeat a valid source-specific allow.
  primary
    .prepare("INSERT INTO rights_grants VALUES(?,?,?,?,?,?,?,?,?,?)")
    .run("deny", "e_a", "ebook", "retail", "active", "deny", "manual", "AU", null, null);
  assert.deepEqual(await publishIsolatedLiteraryInference(env, seeded.enqueued), {
    skipped: "rights_source_or_version_changed",
  });
  primary.prepare("UPDATE rights_grants SET status='revoked' WHERE id='deny'").run();
  const job = content.prepare("SELECT result_key FROM literary_inference_jobs").get();
  tamper = true;
  await assert.rejects(
    publishIsolatedLiteraryInference(env, seeded.enqueued),
    /artifact_sha_mismatch/,
  );
  tamper = false;
  primary
    .prepare("UPDATE gutenberg_source_cache SET content_hash=? WHERE id='pg_a'")
    .run("f".repeat(64));
  assert.deepEqual(await publishIsolatedLiteraryInference(env, seeded.enqueued), {
    skipped: "rights_source_or_version_changed",
  });
  primary
    .prepare("UPDATE gutenberg_source_cache SET content_hash=? WHERE id='pg_a'")
    .run(sourceHash);
  // If canonical ownership is rolled back after a publisher precheck but
  // before its single authoritative UPDATE, the SQL predicate must deny it.
  const racePublisher = {
    ...env,
    DB: {
      prepare(sql) {
        const prepared = env.DB.prepare(sql);
        if (!sql.startsWith("UPDATE literary_profiles SET")) return prepared;
        return {
          bind(...args) {
            const bound = prepared.bind(...args);
            return {
              async first() {
                primary.prepare("UPDATE cove_runtime_config SET value='legacy'").run();
                return bound.first();
              },
            };
          },
        };
      },
    },
  };
  assert.deepEqual(await publishIsolatedLiteraryInference(racePublisher, seeded.enqueued), {
    skipped: "rights_source_or_version_changed",
  });
  assert.equal(primary.prepare("SELECT status FROM literary_profiles").get().status, "provisional");
  primary.prepare("UPDATE cove_runtime_config SET value='isolated'").run();
  assert.deepEqual(await publishIsolatedLiteraryInference(env, seeded.enqueued), {
    published: "p_a",
  });
  assert.equal(primary.prepare("SELECT status FROM literary_profiles").get().status, "analyzed");
  assert.equal(primary.prepare("SELECT revision FROM literary_profiles").get().revision, 1);
  assert.deepEqual(
    await publishIsolatedLiteraryInference(env, seeded.enqueued),
    {
      skipped: "rights_source_or_version_changed",
    },
    "A repeated publisher must never increment revision twice",
  );
  assert.equal(primary.prepare("SELECT revision FROM literary_profiles").get().revision, 1);
  assert.equal(
    primary.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name='literary_profile_jobs'").get()
      .n,
    0,
    "No legacy primary job table should be required or created",
  );
  assert.equal(content.prepare("SELECT COUNT(*) n FROM literary_inference_jobs").get().n, 1);
  // Binding a secondary to the rights database must fail closed.
  content.exec("CREATE TABLE rights_grants(id TEXT PRIMARY KEY)");
  await assert.rejects(seedOneIsolatedLiteraryInference(env), /binding_not_isolated/);
  await assert.rejects(publishIsolatedLiteraryInference(env, seeded.enqueued), /not_isolated/);
  console.log(
    "LITERARY_ISOLATED_INFERENCE_PASS dual SQLite domains, write-once R2 collision/lost-lease recovery, primary zero inference writes, independent quota, live source+rights final gating, tampered R2, exact-once canonical revision and binding containment",
  );
} finally {
  primary.close();
  content.close();
  rmSync(dir, { recursive: true, force: true });
}
