import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { build } from "esbuild";
import JSZip from "jszip";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cove-prepare-domain-"));
const primary = new DatabaseSync(":memory:");
const secondary = new DatabaseSync(":memory:");
function dbHandle(sqlite) {
  return {
    prepare(sql) {
      const stmt = sqlite.prepare(sql);
      return {
        bind(...args) {
          return {
            async first() {
              return stmt.get(...args) ?? null;
            },
            async run() {
              return stmt.run(...args);
            },
          };
        },
        async first() {
          return stmt.get() ?? null;
        },
      };
    },
  };
}
try {
  primary.exec(`
    CREATE TABLE products(id TEXT PRIMARY KEY,edition_id TEXT,source_name TEXT,source_external_id TEXT,format TEXT,storefront_status TEXT);
    CREATE TABLE gutenberg_source_cache(id TEXT PRIMARY KEY,source_id TEXT,ingest_status TEXT,epub_status TEXT,rights_status TEXT,commercial_use_status TEXT,content_hash TEXT,rights_territories_json TEXT);
    CREATE TABLE rights_grants(id TEXT PRIMARY KEY,edition_id TEXT,format TEXT,sales_channel TEXT,status TEXT,decision TEXT,source TEXT,territory_code TEXT,starts_at TEXT,ends_at TEXT);
  `);
  secondary.exec(
    readFileSync("infra/content-budget/0001_ledger.sql", "utf8") +
      readFileSync("infra/content-budget/0002_preparation_queue.sql", "utf8"),
  );
  await build({
    entryPoints: ["src/lib/literary-preparation-domain.server.ts"],
    outfile: path.join(dir, "prep.mjs"),
    bundle: true,
    format: "esm",
    platform: "node",
    logLevel: "silent",
  });
  const { enqueueIsolatedLiteraryPreparation, runIsolatedLiteraryPreparationTick } = await import(
    path.join(dir, "prep.mjs")
  );
  const zip = new JSZip();
  zip.file("mimetype", "application/epub+zip");
  zip.file(
    "META-INF/container.xml",
    '<container><rootfiles><rootfile full-path="book.opf"/></rootfiles></container>',
  );
  zip.file(
    "book.opf",
    '<package><manifest><item id="a" href="chapter.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="a"/></spine></package>',
  );
  zip.file(
    "chapter.xhtml",
    "<html><body><h1>Quiet</h1>" + "The lake was calm. ".repeat(200) + "</body></html>",
  );
  const bytes = await zip.generateAsync({ type: "uint8array" });
  const sha = createHash("sha256").update(bytes).digest("hex");
  const insertProduct = primary.prepare("INSERT INTO products VALUES(?,?,?,?,?,?)");
  const insertSource = primary.prepare(
    "INSERT INTO gutenberg_source_cache VALUES(?,?,?,?,?,?,?,?)",
  );
  const insertGrant = primary.prepare("INSERT INTO rights_grants VALUES(?,?,?,?,?,?,?,?,?,?)");
  insertProduct.run("prod_a", "edition_a", "gutenberg", "pgau_a", "ebook", "active");
  insertSource.run(
    "pgau_a",
    "pg_au",
    "active",
    "completed",
    "public-domain",
    "approved",
    sha,
    '["AU"]',
  );
  insertGrant.run(
    "grant_a",
    "edition_a",
    "ebook",
    "retail",
    "active",
    "allow",
    "gutenberg-pg_au-public-domain",
    "AU",
    null,
    null,
  );
  insertProduct.run("prod_b", "edition_b", "gutenberg", "pgau_b", "ebook", "active");
  insertSource.run(
    "pgau_b",
    "pg_au",
    "active",
    "completed",
    "public-domain",
    "approved",
    sha,
    '["AU"]',
  );
  insertGrant.run(
    "grant_b",
    "edition_b",
    "ebook",
    "retail",
    "active",
    "allow",
    "gutenberg-pg_au-public-domain",
    "AU",
    null,
    null,
  );
  let puts = 0;
  let injectedRevocation = false;
  const stored = new Map();
  stored.set("epubs/pgau_a.epub", bytes);
  stored.set("epubs/pgau_b.epub", bytes);
  const BUCKET = {
    async get(key) {
      const value = stored.get(key);
      if (!value) return null;
      if (key.endsWith("pgau_b.epub") && !injectedRevocation) {
        injectedRevocation = true;
        primary.prepare("UPDATE rights_grants SET status='revoked' WHERE id='grant_b'").run();
      }
      return {
        size: value.byteLength,
        customMetadata: { sha256: sha },
        httpMetadata: { contentType: "application/epub+zip" },
        async arrayBuffer() {
          return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
        },
      };
    },
    async put(key, body, options) {
      puts++;
      assert.ok(key.startsWith("literary/isolated-prepared-v1/"));
      assert.equal(options.httpMetadata.contentType, "application/json");
      assert.equal(createHash("sha256").update(body).digest("hex"), options.customMetadata.sha256);
      stored.set(key, new TextEncoder().encode(body));
    },
  };
  const env = {
    DB: dbHandle(primary),
    CONTENT_DB: dbHandle(secondary),
    BUCKET,
    FORE_CONTENT_PROCESSOR_ENABLED: "1",
    FORE_CONTENT_PREPARE_ENABLED: "1",
    FORE_CONTENT_PROCESSOR_ROLE: "literary-prepare",
  };
  await assert.rejects(
    enqueueIsolatedLiteraryPreparation(
      { ...env, FORE_CONTENT_PREPARE_ENABLED: "0" },
      "prod_a",
      "edition_a",
    ),
    /disabled/,
  );
  assert.equal(
    (await enqueueIsolatedLiteraryPreparation(env, "prod_a", "edition_a")).enqueued.length,
    64,
  );
  await enqueueIsolatedLiteraryPreparation(env, "prod_a", "edition_a");
  assert.equal(secondary.prepare("SELECT COUNT(*) AS n FROM literary_prepare_jobs").get().n, 1);
  const before = primary.prepare("SELECT total_changes() AS n").get().n;
  const finished = await runIsolatedLiteraryPreparationTick(env);
  assert.equal(typeof finished.prepared, "string");
  assert.equal(finished.sections, 1);
  assert.equal(
    primary.prepare("SELECT total_changes() AS n").get().n,
    before,
    "No primary rights/catalog writes",
  );
  assert.equal(secondary.prepare("SELECT status FROM literary_prepare_jobs").get().status, "done");
  assert.equal(puts, 1);
  assert.deepEqual(await runIsolatedLiteraryPreparationTick(env), {
    skipped: "no_preparation_jobs",
  });
  // Change the grant during private-R2 read, before the last rights check.
  await enqueueIsolatedLiteraryPreparation(env, "prod_b", "edition_b");
  const revoked = await runIsolatedLiteraryPreparationTick(env);
  assert.match(revoked.reason, /rights_revoked_during_preparation/);
  assert.equal(
    secondary.prepare("SELECT status FROM literary_prepare_jobs WHERE product_id='prod_b'").get()
      .status,
    "failed",
  );
  assert.equal(puts, 1, "No private prepared output committed following revocation");
  assert.deepEqual(await enqueueIsolatedLiteraryPreparation(env, "prod_b", "edition_b"), {
    skipped: "source_or_rights_ineligible",
  });
  secondary.exec("CREATE TABLE rights_grants(id TEXT PRIMARY KEY)");
  await assert.rejects(
    enqueueIsolatedLiteraryPreparation(env, "prod_a", "edition_a"),
    /binding_not_isolated/,
  );
  assert.equal(secondary.prepare("SELECT COUNT(*) AS n FROM literary_prepare_jobs").get().n, 2);
  console.log(
    "Independent preparation claims, idempotent enqueue, valid EPUB evidence, authoritative grant revocation, no primary writes, and binding identity PASS",
  );
} finally {
  primary.close();
  secondary.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
