import { extractLiterarySections } from "../features/fore/literary-extract.server";
import type { CoveEnv } from "../features/fore/api.server";

type D1 = CoveEnv["DB"];
type Bucket = NonNullable<CoveEnv["BUCKET"]>;
export type PreparationEnv = {
  DB: D1;
  CONTENT_DB?: D1;
  BUCKET?: Bucket;
  FORE_CONTENT_PROCESSOR_ENABLED?: string;
  FORE_CONTENT_PROCESSOR_ROLE?: string;
  FORE_CONTENT_PREPARE_ENABLED?: string;
  FORE_CONTENT_HANDOFF_ENABLED?: string;
  FORE_CONTENT_INFERENCE_ENABLED?: string;
};
type EligibleSource = {
  product_id: string;
  edition_id: string;
  source_id: string;
  content_hash: string;
};
type PreparationJob = {
  id: string;
  product_id: string;
  edition_id: string;
  source_id: string;
  content_sha256: string;
  attempts: number;
};
const sourceSql = `SELECT p.id product_id,p.edition_id,c.id source_id,
  c.content_hash
  FROM products p
  JOIN gutenberg_source_cache c
    ON c.id=p.source_external_id AND p.source_name='gutenberg'
  WHERE p.id=? AND p.edition_id=? AND p.format='ebook'
    AND p.storefront_status='active'
    AND c.ingest_status='active' AND c.epub_status='completed'
    AND c.rights_status='public-domain'
    AND c.commercial_use_status='approved'
    AND length(c.content_hash)=64
    AND EXISTS (
      SELECT 1 FROM rights_grants g
      WHERE g.edition_id=p.edition_id
        AND g.format='ebook' AND g.sales_channel='retail'
        AND g.status='active' AND g.decision='allow'
        AND g.source='gutenberg-'||c.source_id||'-public-domain'
        AND g.territory_code IN (
          SELECT value FROM json_each(CASE WHEN json_valid(c.rights_territories_json)
          THEN c.rights_territories_json ELSE '[]' END)
        )
        AND (g.starts_at IS NULL OR datetime(g.starts_at)<=datetime('now'))
        AND (g.ends_at IS NULL OR datetime(g.ends_at)>datetime('now'))
    )
    AND NOT EXISTS (
      SELECT 1 FROM rights_grants deny
      WHERE deny.edition_id=p.edition_id AND deny.format='ebook'
        AND deny.sales_channel='retail' AND deny.status='active'
        AND deny.decision='deny'
        AND deny.territory_code IN (
          SELECT value FROM json_each(CASE WHEN json_valid(c.rights_territories_json)
          THEN c.rights_territories_json ELSE '[]' END)
        )
        AND (deny.starts_at IS NULL OR datetime(deny.starts_at)<=datetime('now'))
        AND (deny.ends_at IS NULL OR datetime(deny.ends_at)>datetime('now'))
    ) LIMIT 1`;

const digest = async (bytes: Uint8Array | string) => {
  const material = typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes;
  // Create an owned ArrayBuffer: R2 byte arrays can be backed by
  // ArrayBufferLike, which SubtleCrypto's strict BufferSource excludes.
  const hash = await crypto.subtle.digest("SHA-256", Uint8Array.from(material).buffer);
  return [...new Uint8Array(hash)].map((x) => x.toString(16).padStart(2, "0")).join("");
};
export async function requireIsolatedDomain(env: PreparationEnv): Promise<D1> {
  if (
    env.FORE_CONTENT_PROCESSOR_ENABLED !== "1" ||
    env.FORE_CONTENT_PREPARE_ENABLED !== "1" ||
    (env.FORE_CONTENT_PROCESSOR_ROLE !== "literary-prepare" &&
      !(
        (env.FORE_CONTENT_PROCESSOR_ROLE === "literary-handoff" &&
          env.FORE_CONTENT_HANDOFF_ENABLED === "1") ||
        (env.FORE_CONTENT_PROCESSOR_ROLE === "literary-infer" &&
          env.FORE_CONTENT_INFERENCE_ENABLED === "1")
      )) ||
    !env.CONTENT_DB ||
    env.CONTENT_DB === env.DB
  )
    throw new Error("literary_prepare_disabled");
  // This domain is not permitted to hold products, customer orders or rights
  // authority. Check identity and schema on every processing tick.
  const identity = await env.CONTENT_DB.prepare(
    "SELECT i.domain,i.schema_version," +
      " EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND" +
      " name IN ('rights_grants','products','payment_orders')) contaminated" +
      " FROM literary_budget_domain_identity i WHERE i.id=1",
  ).first<{ domain: string; schema_version: number; contaminated: number }>();
  if (
    identity?.domain !== "cove-isolated-literary-budget" ||
    identity.schema_version !== 1 ||
    identity.contaminated
  )
    throw new Error("literary_prepare_binding_not_isolated");
  if (!env.BUCKET) throw new Error("literary_prepare_private_r2_required");
  return env.CONTENT_DB;
}
async function eligible(env: PreparationEnv, productId: string, editionId: string) {
  return env.DB.prepare(sourceSql).bind(productId, editionId).first<EligibleSource>();
}

/** Operator-only seed. Does not write primary D1; never publishes a profile. */
export async function enqueueIsolatedLiteraryPreparation(
  env: PreparationEnv,
  productId: string,
  editionId: string,
  expected?: { sourceId: string; contentHash: string },
) {
  const queue = await requireIsolatedDomain(env);
  if (!/^[\w:-]{1,150}$/.test(productId) || !/^[\w:-]{1,150}$/.test(editionId))
    throw new Error("Invalid preparation product");
  const book = await eligible(env, productId, editionId);
  if (!book) return { skipped: "source_or_rights_ineligible" };
  // A late-changing edition may not silently switch an outbox intent to
  // another EPUB; independent queue keys are pinned to the primary event.
  if (
    expected &&
    (book.source_id !== expected.sourceId || book.content_hash !== expected.contentHash)
  )
    return { skipped: "source_changed" };
  const id = await digest(
    [book.product_id, book.edition_id, book.source_id, book.content_hash].join(":"),
  );
  const now = new Date().toISOString();
  await queue
    .prepare(
      "INSERT OR IGNORE INTO literary_prepare_jobs" +
        "(id,product_id,edition_id,source_id,content_sha256,available_at,created_at,updated_at)" +
        " VALUES(?,?,?,?,?,?,?,?)",
    )
    .bind(id, productId, editionId, book.source_id, book.content_hash, now, now, now)
    .run();
  return { enqueued: id };
}

/** One leased metadata/evidence preparation per tick. No primary D1 writes. */
export async function runIsolatedLiteraryPreparationTick(env: PreparationEnv, expectedId?: string) {
  if (expectedId !== undefined && !/^[a-f0-9]{64}$/.test(expectedId))
    throw new Error("invalid_preparation_notification");
  if (env.FORE_CONTENT_PROCESSOR_ROLE !== "literary-prepare")
    throw new Error("literary_prepare_execution_role_required");
  const queue = await requireIsolatedDomain(env);
  const token = crypto.randomUUID();
  const now = new Date().toISOString();
  const lease = new Date(Date.now() + 120_000).toISOString();
  // Expired claims that consumed every attempt must not remain running
  // forever. This is an independent CONTENT_DB-only maintenance write.
  await queue
    .prepare(
      "UPDATE literary_prepare_jobs SET status='failed'," +
        " last_error='lease_expired_max_attempts',lease_until='',lease_token='',updated_at=?" +
        " WHERE status='running' AND lease_until<? AND attempts>=3",
    )
    .bind(now, now)
    .run();
  const job = await queue
    .prepare(
      "UPDATE literary_prepare_jobs" +
        " SET status='running',lease_token=?,lease_until=?,attempts=attempts+1,updated_at=?" +
        " WHERE id=(SELECT id FROM literary_prepare_jobs" +
        " WHERE ((status='queued' AND available_at<=?) OR" +
        " (status='running' AND lease_until<?))" +
        " AND attempts<3 AND (? IS NULL OR id=?) ORDER BY available_at,id LIMIT 1)" +
        " RETURNING id,product_id,edition_id,source_id,content_sha256,attempts",
    )
    .bind(token, lease, now, now, now, expectedId ?? null, expectedId ?? null)
    .first<PreparationJob>();
  if (!job) {
    if (expectedId) {
      const pending = await queue
        .prepare("SELECT status,available_at,lease_until FROM literary_prepare_jobs WHERE id=?")
        .bind(expectedId)
        .first<{ status: string; available_at: string; lease_until: string }>();
      if (pending && ["queued", "running"].includes(pending.status)) {
        const due = Date.parse(
          pending.status === "running" ? pending.lease_until : pending.available_at,
        );
        return {
          skipped: "preparation_not_ready",
          retryAfterSeconds: Math.max(
            1,
            Math.min(3600, Math.ceil((due - Date.now()) / 1000) || 60),
          ),
        };
      }
    }
    return { skipped: "no_preparation_jobs" };
  }
  try {
    const current = await eligible(env, job.product_id, job.edition_id);
    if (
      !current ||
      current.source_id !== job.source_id ||
      current.content_hash !== job.content_sha256
    )
      throw new Error("rights_or_source_changed");
    const key = "epubs/" + job.source_id + ".epub";
    const object = await env.BUCKET!.get(key);
    if (
      !object ||
      object.size < 100 ||
      object.size > 16 * 1024 * 1024 ||
      object.httpMetadata?.contentType !== "application/epub+zip" ||
      object.customMetadata?.sha256 !== job.content_sha256
    )
      throw new Error("missing_or_unverified_epub");
    const bytes = new Uint8Array(await object.arrayBuffer());
    if ((await digest(bytes)) !== job.content_sha256) throw new Error("epub_bytes_sha_mismatch");
    const extraction = await extractLiterarySections(bytes);
    if (!extraction.sections.length) throw new Error("no_valid_literary_sections");
    const sectionIndices = [
      ...new Set([0, Math.floor(extraction.sections.length / 2), extraction.sections.length - 1]),
    ];
    const output = JSON.stringify({
      version: 1,
      productId: job.product_id,
      editionId: job.edition_id,
      sourceId: job.source_id,
      sourceSha256: job.content_sha256,
      totalSections: extraction.sections.length,
      truncated: extraction.truncated,
      selected: sectionIndices.map((n) => {
        const x = extraction.sections[n];
        return {
          id: x.id,
          spineIndex: x.spineIndex,
          href: x.href,
          locator: [x.charStart, x.charEnd],
          text: x.text.slice(0, 4000),
        };
      }),
    });
    // The result is PRIVATE supporting evidence; it is never a playback,
    // public catalog or reader delivery asset.
    const resultKey = "literary/isolated-prepared-v1/" + job.id + ".json";
    const resultHash = await digest(output);
    // Recheck authoritative primary rights immediately before writing evidence.
    const fresh = await eligible(env, job.product_id, job.edition_id);
    if (!fresh || fresh.source_id !== job.source_id || fresh.content_hash !== job.content_sha256)
      throw new Error("rights_revoked_during_preparation");
    await env.BUCKET!.put(resultKey, output, {
      httpMetadata: { contentType: "application/json" },
      customMetadata: { sha256: resultHash },
    });
    const result = await queue
      .prepare(
        "UPDATE literary_prepare_jobs" +
          " SET status='done',result_key=?,result_sha256=?,lease_until='',lease_token='',updated_at=?" +
          " WHERE id=? AND lease_token=? AND status='running' AND lease_until>?" +
          " RETURNING id",
      )
      .bind(
        resultKey,
        resultHash,
        new Date().toISOString(),
        job.id,
        token,
        new Date().toISOString(),
      )
      .first();
    if (!result) throw new Error("literary_prepare_lease_lost");
    return { prepared: job.id, sections: extraction.sections.length };
  } catch (err) {
    const reason = String(err).slice(0, 100);
    const retry =
      !/rights_|source_changed|epub_bytes_sha_mismatch/.test(reason) && job.attempts < 3;
    await queue
      .prepare(
        "UPDATE literary_prepare_jobs SET status=?,available_at=?," +
          "lease_until='',lease_token='',last_error=?,updated_at=?" +
          " WHERE id=? AND lease_token=? AND status='running'",
      )
      .bind(
        retry ? "queued" : "failed",
        new Date(Date.now() + Math.min(3_600_000, 60_000 * 2 ** job.attempts)).toISOString(),
        reason,
        new Date().toISOString(),
        job.id,
        token,
      )
      .run();
    return {
      failed: job.id,
      reason,
      retryAfterSeconds: retry ? Math.min(3600, 60 * 2 ** job.attempts) : null,
    };
  }
}
