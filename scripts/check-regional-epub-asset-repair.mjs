import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { build } from "esbuild";
import { localBindings } from "./local-api.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "cove-regional-epub-repair-"));
try {
  fs.cpSync("drizzle", path.join(root, "drizzle"), { recursive: true });
  await build({
    entryPoints: [
      "src/features/fore/regional-epub-asset-repair.server.ts",
      "src/features/fore/catalog-model.server.ts",
    ],
    bundle: true,
    platform: "node",
    format: "esm",
    outdir: root,
    outExtension: { ".js": ".mjs" },
    logLevel: "silent",
  });
  const { repairRegionalEpubAssets } = await import(
    path.join(root, "regional-epub-asset-repair.server.mjs")
  );
  const { commercialCatalogStatements } = await import(path.join(root, "catalog-model.server.mjs"));
  const env = localBindings(root);
  const at = "2026-10-20T00:00:00.000Z";
  const hash = "a".repeat(64);
  await env.DB.prepare(
    "INSERT OR IGNORE INTO territories(code,name) VALUES('AU','Australia')",
  ).run();
  async function seed(id, options = {}) {
    const status = options.status ?? "completed";
    const rights = options.rights ?? "approved";
    const formats = JSON.stringify({ "text/html": "https://example.invalid/" + id + ".html" });
    await env.DB.prepare(
      "INSERT INTO gutenberg_source_cache(" +
        "id,title,authors_json,summary,subjects_json,bookshelves_json,languages_json,formats_json," +
        "download_count,copyright,source_url,source_updated_at,first_ingested_at,updated_at," +
        "last_seen_at,ingest_status,epub_status,source_id,source_item_id,source_project," +
        "rights_status,rights_territories_json,rights_evidence_url,commercial_use_status,content_hash)" +
        " VALUES(?,?,'[]','','[]','[]','[\"en\"]',?,0,0,?,?,?,?,?," +
        "'active',?,'pg_au',?,'Project Gutenberg Australia','public-domain','[\"AU\"]',?, ?,?)",
    )
      .bind(
        id,
        "Verified regional source " + id,
        formats,
        "https://example.invalid/" + id,
        at,
        at,
        at,
        at,
        status,
        id,
        "https://example.invalid/rights/" + id,
        rights,
        hash,
      )
      .run();
    const work = "wrk_gutenberg_" + id;
    const edition = "ed_gutenberg_" + id;
    await env.DB.prepare("INSERT INTO works(id,title,created_at,updated_at) VALUES(?,?,?,?)")
      .bind(work, id, at, at)
      .run();
    await env.DB.prepare(
      "INSERT INTO editions(id,work_id,title,created_at,updated_at) VALUES(?,?,?,?,?)",
    )
      .bind(edition, work, id, at, at)
      .run();
    await env.DB.prepare(
      "INSERT INTO products(id,edition_id,sku,format,storefront_status,source_name,source_external_id,created_at,updated_at)" +
        " VALUES(?,?,?,'ebook','active','gutenberg',?,?,?)",
    )
      .bind("prd_gutenberg_" + id, edition, "sku_" + id, id, at, at)
      .run();
    // Keep the real database's source-evidence triggers enabled in tests.
    // A synthetic grant is valid only with matching approved AU evidence.
    const evidenceId = "evidence_" + id;
    await env.DB.prepare(
      "INSERT INTO gutenberg_rights_evidence(id,source_id,cache_id,source_item_id," +
        "determination,territory_code,evidence_url,evidence_type,evidence_hash," +
        "parser_version,status,checked_at,created_at)" +
        " VALUES(?,'pg_au',?,?,'public-domain','AU',?,'operator-review',?," +
        "'test-fixture-v1','approved',?,?)",
    )
      .bind(evidenceId, id, id, "https://example.invalid/rights/" + id, hash, at, at)
      .run();
    await env.DB.prepare(
      "INSERT INTO rights_grants(id,edition_id,territory_code,format,license_type,created_at," +
        "source,sales_channel,status,decision,source_evidence_id)" +
        " VALUES(?,?,'AU','ebook','public-domain',?," +
        "'gutenberg-pg_au-public-domain','retail',?,'allow',?)",
    )
      .bind("rg_test_" + id, edition, at, options.grantStatus ?? "active", evidenceId)
      .run();
    return edition;
  }

  const a = await seed("pgau_9100001");
  const b = await seed("pgau_9100002");
  const c = await seed("pgau_9100003");
  await seed("pgau_9100004", { rights: "pending" });
  const revoked = await seed("pgau_9100006", { grantStatus: "revoked" });
  const envWithR2 = {
    ...env,
    BUCKET: {
      async head(key) {
        if (key.endsWith("9100002.epub")) return null;
        if (key.endsWith("9100003.epub")) {
          await env.DB.prepare("UPDATE rights_grants SET status='revoked' WHERE edition_id=?")
            .bind(c)
            .run();
        }
        return {
          size: 123,
          customMetadata: { sha256: hash },
          httpMetadata: { contentType: "application/epub+zip" },
        };
      },
    },
  };

  const result = await repairRegionalEpubAssets(envWithR2, { limit: 8 });
  assert.equal(
    result.scanned,
    3,
    "pending source approval or revoked grants are never repair candidates",
  );
  assert.equal(result.repaired, 1, "verified completed regional EPUB is restored");
  assert.equal(result.missingOrMismatched, 1, "missing R2 object must fail closed");
  assert.equal(result.conflicts, 1, "live grant revocation between HEAD and write blocks repair");
  assert.equal(result.nextAfter, "pgau_9100003");
  assert.equal(
    (
      await env.DB.prepare(
        "SELECT commercial_use_status FROM gutenberg_source_cache WHERE id='pgau_9100003'",
      ).first()
    ).commercial_use_status,
    "approved",
    "active source approval alone must not defeat separate live-grant revocation",
  );
  const asset = await env.DB.prepare(
    "SELECT v.object_key,v.sha256 FROM digital_assets d JOIN asset_versions v" +
      " ON d.current_version_id=v.id WHERE d.edition_id=?",
  )
    .bind(a)
    .first();
  assert.equal(asset.object_key, "epubs/pgau_9100001.epub");
  assert.equal(asset.sha256, hash);
  for (const id of [b, c, revoked, "ed_gutenberg_pgau_9100004"]) {
    assert.equal(
      (
        await env.DB.prepare("SELECT COUNT(*) n FROM digital_assets WHERE edition_id=?")
          .bind(id)
          .first()
      ).n,
      0,
      "unverified object or revoked rights must not gain an asset",
    );
  }
  const again = await repairRegionalEpubAssets(envWithR2, { after: result.nextAfter });
  assert.equal(again.scanned, 0, "cursor prevents replaying previously scanned failures");
  assert.equal(
    (await repairRegionalEpubAssets(envWithR2, { limit: 8 })).repaired,
    0,
    "a completed repair is idempotent",
  );
  await assert.rejects(
    repairRegionalEpubAssets(envWithR2, { after: "broken'; DROP TABLE products" }),
    /Invalid regional asset repair cursor/,
  );

  // New completions from a canonicalized HTML source must normalize a reader
  // asset immediately, even without an upstream application/epub+zip format.
  const fresh = await seed("pgau_9100005");
  await env.DB.batch(commercialCatalogStatements(env.DB, "pgau_9100005", at));
  const current = await env.DB.prepare(
    "SELECT v.object_key,v.source_url FROM digital_assets d JOIN asset_versions v" +
      " ON v.id=d.current_version_id WHERE d.edition_id=? AND d.kind='epub'",
  )
    .bind(fresh)
    .first();
  assert.equal(current?.object_key, "epubs/pgau_9100005.epub");
  assert.equal(current?.source_url, "https://example.invalid/pgau_9100005.html");
  const workerSource = fs.readFileSync("src/persistence-backend.worker.ts", "utf8");
  const endpoint = workerSource.slice(
    workerSource.indexOf('if (path === "/__cove/ingestion/repair-regional-epubs"'),
    workerSource.indexOf('if (path === "/__cove/ingestion/audio-admission"'),
  );
  assert.match(endpoint, /FORE_REGIONAL_EPUB_REPAIR_ENABLED !== "1"/);
  assert.match(endpoint, /await admitCatalogBatch\(/);
  assert.ok(
    endpoint.indexOf("await admitCatalogBatch(") <
      endpoint.indexOf("await repairRegionalEpubAssets("),
    "D1 admission must run before any backfill mutation",
  );
  console.log("Regional EPUB normalization, R2 repair, withdrawal, and cursor gates passed.");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
