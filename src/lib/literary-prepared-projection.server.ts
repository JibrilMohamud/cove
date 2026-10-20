import type { CoveEnv } from "../features/fore/api.server";

type D1 = CoveEnv["DB"];
type R2 = NonNullable<CoveEnv["BUCKET"]>;
type PublisherEnv = {
  DB: D1;
  CONTENT_DB?: D1;
  BUCKET?: R2;
  FORE_LITERARY_PREPARED_IMPORT_ENABLED?: string;
};
type Completed = {
  id: string;
  product_id: string;
  edition_id: string;
  source_id: string;
  content_sha256: string;
  result_key: string;
  result_sha256: string;
};

const sha256 = async (bytes: Uint8Array) => {
  const digest = await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes).buffer);
  return [...new Uint8Array(digest)].map((x) => x.toString(16).padStart(2, "0")).join("");
};

/**
 * Imports an audited PRIVATE preparation receipt into a NONPUBLIC
 * operational projection. Its SQL is the final authority on source and
 * territorial grants. This does NOT publish literary_profiles to customers.
 *
 * Cross-D1 is not transactional: this function is replayable; the primary
 * projection key and idempotent upsert are the durable completion receipt.
 */
export async function importIsolatedLiteraryEvidence(
  env: PublisherEnv,
  jobId: string,
): Promise<{ imported?: string; skipped?: string }> {
  if (env.FORE_LITERARY_PREPARED_IMPORT_ENABLED !== "1" || !env.CONTENT_DB || !env.BUCKET)
    throw new Error("literary_prepared_import_disabled");
  if (!/^[0-9a-f]{64}$/.test(jobId)) throw new Error("Invalid prepared job id");

  const identity = await env.CONTENT_DB.prepare(
    "SELECT domain,schema_version," +
      " EXISTS(SELECT 1 FROM sqlite_master WHERE type='table'" +
      " AND name IN ('rights_grants','products','payment_orders')) contaminated" +
      " FROM literary_budget_domain_identity WHERE id=1",
  ).first<{ domain: string; schema_version: number; contaminated: number }>();
  if (
    identity?.domain !== "cove-isolated-literary-budget" ||
    identity.schema_version !== 1 ||
    identity.contaminated
  ) throw new Error("literary_prepared_import_not_isolated");

  const job = await env.CONTENT_DB.prepare(
    "SELECT id,product_id,edition_id,source_id,content_sha256,result_key,result_sha256" +
      " FROM literary_prepare_jobs WHERE id=? AND status='done'",
  ).bind(jobId).first<Completed>();
  if (!job) return { skipped: "not_prepared" };
  const canonicalKey = "literary/isolated-prepared-v1/" + jobId + ".json";
  if (
    job.result_key !== canonicalKey ||
    !/^[0-9a-f]{64}$/.test(job.result_sha256) ||
    !/^[0-9a-f]{64}$/.test(job.content_sha256)
  ) throw new Error("invalid_preparation_receipt");
  const object = await env.BUCKET.get(canonicalKey);
  if (!object || object.size <= 30 || object.size > 100_000)
    throw new Error("missing_private_preparation");
  if (
    object.customMetadata?.sha256 !== job.result_sha256 ||
    object.httpMetadata?.contentType !== "application/json"
  ) throw new Error("invalid_preparation_object_metadata");
  const bytes = new Uint8Array(await object.arrayBuffer());
  if (await sha256(bytes) !== job.result_sha256) throw new Error("tampered_preparation_bytes");
  const manifest = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
  if (
    manifest.version !== 1 ||
    manifest.productId !== job.product_id ||
    manifest.editionId !== job.edition_id ||
    manifest.sourceId !== job.source_id ||
    manifest.sourceSha256 !== job.content_sha256 ||
    !Array.isArray(manifest.selected) ||
    manifest.selected.length < 1
  ) throw new Error("untrusted_preparation_manifest");

  // The public rights authority is queried as part of the actual D1
  // mutation, not merely as a stale preflight in the content Worker.
  const now = new Date().toISOString();
  const published = await env.DB.prepare(
    "INSERT INTO literary_prepared_evidence" +
      "(product_id,edition_id,source_id,source_sha256,evidence_key,evidence_sha256,imported_at)" +
      " SELECT p.id,p.edition_id,c.id,c.content_hash,?,?,?" +
      " FROM products p JOIN gutenberg_source_cache c ON c.id=p.source_external_id" +
      " WHERE p.id=? AND p.edition_id=? AND p.source_name='gutenberg'" +
      " AND p.format='ebook' AND p.storefront_status='active'" +
      " AND c.id=? AND c.content_hash=?" +
      " AND c.ingest_status='active' AND c.epub_status='completed'" +
      " AND c.rights_status='public-domain' AND c.commercial_use_status='approved'" +
      " AND EXISTS(SELECT 1 FROM rights_grants g WHERE g.edition_id=p.edition_id" +
      " AND g.format='ebook' AND g.sales_channel='retail' AND g.status='active'" +
      " AND g.decision='allow' AND g.source='gutenberg-'||c.source_id||'-public-domain'" +
      " AND g.territory_code IN (SELECT value FROM json_each(" +
      " CASE WHEN json_valid(c.rights_territories_json)" +
      " THEN c.rights_territories_json ELSE '[]' END))" +
      " AND (g.starts_at IS NULL OR datetime(g.starts_at)<=datetime('now'))" +
      " AND (g.ends_at IS NULL OR datetime(g.ends_at)>datetime('now')))" +
      " AND NOT EXISTS(SELECT 1 FROM rights_grants deny WHERE deny.edition_id=p.edition_id" +
      " AND deny.format='ebook' AND deny.sales_channel='retail'" +
      " AND deny.status='active' AND deny.decision='deny'" +
      " AND deny.territory_code IN (SELECT value FROM json_each(" +
      " CASE WHEN json_valid(c.rights_territories_json)" +
      " THEN c.rights_territories_json ELSE '[]' END))" +
      " AND (deny.starts_at IS NULL OR datetime(deny.starts_at)<=datetime('now'))" +
      " AND (deny.ends_at IS NULL OR datetime(deny.ends_at)>datetime('now')))" +
      " ON CONFLICT(product_id,source_sha256) DO UPDATE SET" +
      " evidence_key=excluded.evidence_key,evidence_sha256=excluded.evidence_sha256," +
      " imported_at=excluded.imported_at RETURNING product_id",
  ).bind(canonicalKey, job.result_sha256, now, job.product_id, job.edition_id, job.source_id, job.content_sha256)
    .first<{ product_id: string }>();
  if (!published) return { skipped: "rights_or_source_changed" };
  return { imported: published.product_id };
}
