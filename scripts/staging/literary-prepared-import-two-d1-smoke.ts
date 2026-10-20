import { importIsolatedLiteraryEvidence } from "../../src/lib/literary-prepared-projection.server";
import type { CoveEnv } from "../../src/features/fore/api.server";

type Env = {
  DB: CoveEnv["DB"];
  CONTENT_DB: CoveEnv["DB"];
  BUCKET: NonNullable<CoveEnv["BUCKET"]>;
  SMOKE_TOKEN?: string;
};
const product = "prod_prep_import_smoke_20261020";
const edition = "ed_prep_import_smoke_20261020";
const source = "pgau_prep_import_smoke_20261020";
const allow = "allow_prep_import_smoke_20261020";
const deny = "deny_prep_import_smoke_20261020";
const jobId = "d".repeat(64);
const sourceHash = "a".repeat(64);
const resultKey = "literary/isolated-prepared-v1/" + jobId + ".json";
const sha = async (bytes: Uint8Array) =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map((v) => v.toString(16).padStart(2, "0"))
    .join("");

export default {
  async fetch(request: Request, env: Env) {
    if (
      request.method !== "POST" ||
      new URL(request.url).pathname !== "/__isolated-import-smoke" ||
      !env.SMOKE_TOKEN ||
      env.SMOKE_TOKEN.length < 48 ||
      request.headers.get("x-smoke-token") !== env.SMOKE_TOKEN
    ) return new Response("Not found", { status: 404 });
    try {
      const bytes = new TextEncoder().encode(
        JSON.stringify({
          version: 1, productId: product, editionId: edition,
          sourceId: source, sourceSha256: sourceHash,
          selected: [{ id: "s00000", text: "A staged sunrise." }],
        }),
      );
      const fingerprint = await sha(bytes);
      await env.DB.prepare("INSERT OR IGNORE INTO editions(id) VALUES(?)").bind(edition).run();
      await env.DB.prepare(
        "INSERT OR REPLACE INTO gutenberg_source_cache(id,source_id,ingest_status,epub_status,rights_status,commercial_use_status,content_hash,formats_json,rights_territories_json) VALUES(?,'pg_au','active','completed','public-domain','approved',?,'{}','[\"AU\"]')",
      ).bind(source, sourceHash).run();
      await env.DB.prepare(
        "INSERT OR REPLACE INTO products(id,edition_id,source_name,source_external_id,format,storefront_status) VALUES(?,?,'gutenberg',?,'ebook','active')",
      ).bind(product, edition, source).run();
      await env.DB.prepare(
        "INSERT OR REPLACE INTO rights_grants(id,edition_id,territory_code,format,sales_channel,status,decision,source) VALUES(?,?,'AU','ebook','retail','active','allow','gutenberg-pg_au-public-domain')",
      ).bind(allow, edition).run();
      await env.CONTENT_DB.prepare(
        "INSERT OR REPLACE INTO literary_prepare_jobs(id,product_id,edition_id,source_id,content_sha256,status,attempts,available_at,result_key,result_sha256,created_at,updated_at) VALUES(?,?,?,?,?,'done',1,?,?,?,?,?)",
      ).bind(jobId, product, edition, source, sourceHash, "2026-10-20", resultKey, fingerprint, "2026-10-20", "2026-10-20").run();
      await env.BUCKET.put(resultKey, bytes, {
        httpMetadata: { contentType: "application/json" },
        customMetadata: { sha256: fingerprint },
      });
      const config = { ...env, FORE_LITERARY_PREPARED_IMPORT_ENABLED: "1" };
      const imported = await importIsolatedLiteraryEvidence(config, jobId);
      const repeated = await importIsolatedLiteraryEvidence(config, jobId);
      const row = await env.DB.prepare(
        "SELECT source_sha256,evidence_sha256 FROM literary_prepared_evidence WHERE product_id=?",
      ).bind(product).first<{ source_sha256: string; evidence_sha256: string }>();
      await env.DB.prepare(
        "INSERT OR REPLACE INTO rights_grants(id,edition_id,territory_code,format,sales_channel,status,decision,source) VALUES(?,?,'AU','ebook','retail','active','deny','operator-veto')",
      ).bind(deny, edition).run();
      const denied = await importIsolatedLiteraryEvidence(config, jobId);
      await env.DB.prepare("DELETE FROM rights_grants WHERE id=?").bind(deny).run();
      await env.DB.prepare("UPDATE rights_grants SET status='revoked' WHERE id=?")
        .bind(allow).run();
      const revoked = await importIsolatedLiteraryEvidence(config, jobId);
      const pass =
        imported.imported === product &&
        repeated.imported === product &&
        row?.source_sha256 === sourceHash &&
        row?.evidence_sha256 === fingerprint &&
        denied.skipped === "rights_or_source_changed" &&
        revoked.skipped === "rights_or_source_changed";
      return Response.json({
        pass, imported: imported.imported === product,
        activeDenyBlocked: denied.skipped === "rights_or_source_changed",
        revokedBlocked: revoked.skipped === "rights_or_source_changed",
      }, { status: pass ? 200 : 409 });
    } catch (e) {
      return Response.json({ pass: false, reason: String(e).slice(0, 160) }, { status: 422 });
    } finally {
      await env.BUCKET.delete(resultKey).catch(() => {});
      await env.CONTENT_DB.prepare("DELETE FROM literary_prepare_jobs WHERE id=?")
        .bind(jobId).run().catch(() => {});
      await env.DB.prepare("DELETE FROM literary_prepared_evidence WHERE product_id=?")
        .bind(product).run().catch(() => {});
      await env.DB.prepare("DELETE FROM rights_grants WHERE id=?")
        .bind(deny).run().catch(() => {});
      await env.DB.prepare("DELETE FROM rights_grants WHERE id=?")
        .bind(allow).run().catch(() => {});
      await env.DB.prepare("DELETE FROM products WHERE id=?")
        .bind(product).run().catch(() => {});
      await env.DB.prepare("DELETE FROM gutenberg_source_cache WHERE id=?")
        .bind(source).run().catch(() => {});
      await env.DB.prepare("DELETE FROM editions WHERE id=?")
        .bind(edition).run().catch(() => {});
    }
  },
};
