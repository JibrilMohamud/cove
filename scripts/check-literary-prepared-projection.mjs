import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { transform } from "esbuild";

const source = readFileSync("src/lib/literary-prepared-projection.server.ts", "utf8");
const { code } = await transform(source, { loader: "ts", format: "esm" });
const { importIsolatedLiteraryEvidence } = await import(
  "data:text/javascript;base64," + Buffer.from(code).toString("base64")
);
const primary = new DatabaseSync(":memory:");
const secondary = new DatabaseSync(":memory:");
const sha = (v) => createHash("sha256").update(v).digest("hex");
function wrapped(sqlite) {
  return {
    prepare(sql) {
      const st = sqlite.prepare(sql);
      return {
        bind(...args) {
          return {
            async first() {
              return st.get(...args) ?? null;
            },
            async run() {
              return st.run(...args);
            },
          };
        },
        async first() {
          return st.get() ?? null;
        },
      };
    },
  };
}
try {
  primary.exec(
    "CREATE TABLE products(id TEXT PRIMARY KEY,edition_id TEXT,source_name TEXT,source_external_id TEXT,format TEXT,storefront_status TEXT);" +
      "CREATE TABLE gutenberg_source_cache(id TEXT PRIMARY KEY,source_id TEXT,ingest_status TEXT,epub_status TEXT,rights_status TEXT,commercial_use_status TEXT,content_hash TEXT,rights_territories_json TEXT);" +
      "CREATE TABLE rights_grants(id TEXT PRIMARY KEY,edition_id TEXT,format TEXT,sales_channel TEXT,status TEXT,decision TEXT,source TEXT,territory_code TEXT,starts_at TEXT,ends_at TEXT);" +
      readFileSync("infra/content-budget/0003_prepared_projection_primary.sql", "utf8"),
  );
  secondary.exec(
    readFileSync("infra/content-budget/0001_ledger.sql", "utf8") +
      readFileSync("infra/content-budget/0002_preparation_queue.sql", "utf8"),
  );
  const sourceSha = "a".repeat(64);
  const jobId = "b".repeat(64);
  const key = "literary/isolated-prepared-v1/" + jobId + ".json";
  const manifest = JSON.stringify({
    version: 1,
    productId: "prod_a",
    editionId: "ed_a",
    sourceId: "pgau_a",
    sourceSha256: sourceSha,
    selected: [{ id: "s00001_00000", text: "A lake at dawn." }],
  });
  const bytes = new TextEncoder().encode(manifest);
  const resultHash = sha(bytes);
  primary
    .prepare("INSERT INTO products VALUES(?,?,?,?,?,?)")
    .run("prod_a", "ed_a", "gutenberg", "pgau_a", "ebook", "active");
  primary
    .prepare("INSERT INTO gutenberg_source_cache VALUES(?,?,?,?,?,?,?,?)")
    .run(
      "pgau_a",
      "pg_au",
      "active",
      "completed",
      "public-domain",
      "approved",
      sourceSha,
      '["AU"]',
    );
  primary
    .prepare("INSERT INTO rights_grants VALUES(?,?,?,?,?,?,?,?,?,?)")
    .run(
      "allow_a",
      "ed_a",
      "ebook",
      "retail",
      "active",
      "allow",
      "gutenberg-pg_au-public-domain",
      "AU",
      null,
      null,
    );
  secondary
    .prepare(
      "INSERT INTO literary_prepare_jobs(id,product_id,edition_id,source_id,content_sha256,status,attempts,available_at,result_key,result_sha256,created_at,updated_at)" +
        " VALUES(?,?,?,?,?,'done',1,?,?,?,?,?)",
    )
    .run(
      jobId,
      "prod_a",
      "ed_a",
      "pgau_a",
      sourceSha,
      "2026-10-20",
      key,
      resultHash,
      "2026-10-20",
      "2026-10-20",
    );
  let corruption = false;
  const BUCKET = {
    async get(k) {
      if (k !== key) return null;
      const buffer = corruption ? new TextEncoder().encode(manifest + "tampered") : bytes;
      return {
        size: buffer.byteLength,
        customMetadata: { sha256: resultHash },
        httpMetadata: { contentType: "application/json" },
        async arrayBuffer() {
          return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
        },
      };
    },
  };
  const env = {
    DB: wrapped(primary),
    CONTENT_DB: wrapped(secondary),
    BUCKET,
    FORE_LITERARY_PREPARED_IMPORT_ENABLED: "1",
  };
  await assert.rejects(
    importIsolatedLiteraryEvidence({ ...env, FORE_LITERARY_PREPARED_IMPORT_ENABLED: "0" }, jobId),
    /disabled/,
  );
  assert.deepEqual(await importIsolatedLiteraryEvidence(env, jobId), { imported: "prod_a" });
  assert.deepEqual(await importIsolatedLiteraryEvidence(env, jobId), { imported: "prod_a" });
  assert.equal(primary.prepare("SELECT COUNT(*) AS n FROM literary_prepared_evidence").get().n, 1);
  assert.equal(
    primary.prepare("SELECT evidence_sha256 FROM literary_prepared_evidence").get().evidence_sha256,
    resultHash,
  );

  // An explicit live deny overrides the matching source-specific AU allow.
  primary
    .prepare("INSERT INTO rights_grants VALUES(?,?,?,?,?,?,?,?,?,?)")
    .run("deny_a", "ed_a", "ebook", "retail", "active", "deny", "operator-veto", "AU", null, null);
  assert.deepEqual(await importIsolatedLiteraryEvidence(env, jobId), {
    skipped: "rights_or_source_changed",
  });
  primary.prepare("DELETE FROM rights_grants WHERE id='deny_a'").run();
  primary.prepare("UPDATE rights_grants SET status='revoked' WHERE id='allow_a'").run();
  assert.deepEqual(await importIsolatedLiteraryEvidence(env, jobId), {
    skipped: "rights_or_source_changed",
  });
  primary.prepare("UPDATE rights_grants SET status='active' WHERE id='allow_a'").run();
  primary
    .prepare("UPDATE gutenberg_source_cache SET content_hash=? WHERE id='pgau_a'")
    .run("c".repeat(64));
  assert.deepEqual(await importIsolatedLiteraryEvidence(env, jobId), {
    skipped: "rights_or_source_changed",
  });
  primary
    .prepare("UPDATE gutenberg_source_cache SET content_hash=? WHERE id='pgau_a'")
    .run(sourceSha);
  corruption = true;
  await assert.rejects(importIsolatedLiteraryEvidence(env, jobId), /tampered_preparation_bytes/);
  corruption = false;
  secondary.exec("CREATE TABLE rights_grants(id TEXT PRIMARY KEY)");
  await assert.rejects(importIsolatedLiteraryEvidence(env, jobId), /not_isolated/);
  // No test case altered any customer-serving profile, edition or license.
  assert.equal(primary.prepare("SELECT COUNT(*) AS n FROM literary_prepared_evidence").get().n, 1);
  console.log(
    "One-row import: live allow+deny precedence, source hash, private R2 byte SHA, idempotency and incorrect authority binding PASS",
  );
} finally {
  primary.close();
  secondary.close();
}
