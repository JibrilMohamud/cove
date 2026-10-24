import type { CoveEnv } from "../features/fore/api.server";
import { enqueueIsolatedLiteraryPreparation } from "./literary-preparation-domain.server";

type D1 = CoveEnv["DB"];
export type HandoffEnv = {
  DB: D1;
  CONTENT_DB?: D1;
  BUCKET?: CoveEnv["BUCKET"];
  FORE_CONTENT_PROCESSOR_ENABLED?: string;
  FORE_CONTENT_PREPARE_ENABLED?: string;
  FORE_CONTENT_PROCESSOR_ROLE?: string;
  FORE_CONTENT_HANDOFF_ENABLED?: string;
  LITERARY_PREPARE_QUEUE?: {
    send(body: { schema: "cove.literary.prepare.v1"; jobId: string }): Promise<void>;
  };
};
type Source = { source_id: string; content_hash: string };
type Handoff = {
  id: string;
  product_id: string;
  edition_id: string;
  source_id: string;
  source_sha256: string;
  attempts: number;
};

export const literarySourceRightsPredicate =
  " FROM products p JOIN gutenberg_source_cache c ON c.id=p.source_external_id" +
  " WHERE p.id=? AND p.edition_id=? AND p.source_name='gutenberg'" +
  " AND p.format='ebook' AND p.storefront_status='active'" +
  " AND c.ingest_status='active' AND c.epub_status='completed'" +
  " AND c.rights_status='public-domain' AND c.commercial_use_status='approved'" +
  " AND length(c.content_hash)=64" +
  " AND EXISTS(SELECT 1 FROM rights_grants g WHERE g.edition_id=p.edition_id" +
  " AND g.format='ebook' AND g.sales_channel='retail' AND g.status='active'" +
  " AND g.decision='allow' AND g.source='gutenberg-'||c.source_id||'-public-domain'" +
  " AND g.territory_code IN (SELECT value FROM json_each(" +
  " CASE WHEN json_valid(c.rights_territories_json)" +
  " THEN c.rights_territories_json ELSE '[]' END))" +
  " AND (g.starts_at IS NULL OR datetime(g.starts_at)<=datetime('now'))" +
  " AND (g.ends_at IS NULL OR datetime(g.ends_at)>datetime('now')))" +
  " AND NOT EXISTS(SELECT 1 FROM rights_grants deny" +
  " WHERE deny.edition_id=p.edition_id AND deny.format='ebook'" +
  " AND deny.sales_channel='retail' AND deny.status='active'" +
  " AND deny.decision='deny' AND deny.territory_code IN" +
  " (SELECT value FROM json_each(CASE WHEN json_valid(c.rights_territories_json)" +
  " THEN c.rights_territories_json ELSE '[]' END))" +
  " AND (deny.starts_at IS NULL OR datetime(deny.starts_at)<=datetime('now'))" +
  " AND (deny.ends_at IS NULL OR datetime(deny.ends_at)>datetime('now')))";
const digest = async (text: string) => {
  const h = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, "0")).join("");
};
function assertEnabled(env: HandoffEnv) {
  if (
    env.FORE_CONTENT_PROCESSOR_ENABLED !== "1" ||
    env.FORE_CONTENT_PREPARE_ENABLED !== "1" ||
    env.FORE_CONTENT_HANDOFF_ENABLED !== "1" ||
    env.FORE_CONTENT_PROCESSOR_ROLE !== "literary-handoff" ||
    !env.CONTENT_DB ||
    env.CONTENT_DB === env.DB
  )
    throw Error("literary_prepare_handoff_disabled");
}

/** An explicit priority-book intent, committed to primary D1 only. */
export async function seedLiteraryPreparationHandoff(
  env: HandoffEnv,
  productId: string,
  editionId: string,
) {
  assertEnabled(env);
  if (!/^[\w:-]{1,150}$/.test(productId) || !/^[\w:-]{1,150}$/.test(editionId))
    throw Error("Invalid outbox book");
  const source = await env.DB.prepare(
    "SELECT c.id source_id,c.content_hash" + literarySourceRightsPredicate + " LIMIT 1",
  )
    .bind(productId, editionId)
    .first<Source>();
  if (!source) return { skipped: "source_or_rights_ineligible" };
  const id = await digest([productId, editionId, source.source_id, source.content_hash].join(":"));
  const now = new Date().toISOString();
  // Rights are checked AGAIN inside this INSERT; preflight is not authority.
  const row = await env.DB.prepare(
    "INSERT OR IGNORE INTO literary_prepare_outbox" +
      "(id,product_id,edition_id,source_id,source_sha256,available_at,created_at,updated_at)" +
      " SELECT ?,p.id,p.edition_id,c.id,c.content_hash,?,?,?" +
      literarySourceRightsPredicate +
      " AND c.id=? AND c.content_hash=? RETURNING id",
  )
    .bind(id, now, now, now, productId, editionId, source.source_id, source.content_hash)
    .first<{ id: string }>();
  if (row) return { outboxId: id, duplicate: false };
  const prior = await env.DB.prepare("SELECT id FROM literary_prepare_outbox WHERE id=?")
    .bind(id)
    .first();
  return prior ? { outboxId: id, duplicate: true } : { skipped: "rights_changed" };
}

/** Max one at-least-once handoff per tick; no whole-catalog scans. */
export async function dispatchOneLiteraryPreparationHandoff(env: HandoffEnv) {
  assertEnabled(env);
  const token = crypto.randomUUID();
  const now = new Date().toISOString();
  const until = new Date(Date.now() + 120_000).toISOString();
  await env.DB.prepare(
    "UPDATE literary_prepare_outbox SET status='failed',lease_token='',lease_until=''," +
      "last_error='expired_final_attempt',updated_at=?" +
      " WHERE status='running' AND lease_until<? AND attempts>=4",
  )
    .bind(now, now)
    .run();
  const job = await env.DB.prepare(
    "UPDATE literary_prepare_outbox SET status='running',lease_token=?," +
      "lease_until=?,attempts=attempts+1,updated_at=?" +
      " WHERE id=(SELECT id FROM literary_prepare_outbox WHERE" +
      " ((status='queued' AND available_at<=?) OR" +
      " (status='running' AND lease_until<?)) AND attempts<4" +
      " ORDER BY available_at,id LIMIT 1)" +
      " RETURNING id,product_id,edition_id,source_id,source_sha256,attempts",
  )
    .bind(token, until, now, now, now)
    .first<Handoff>();
  if (!job) return { skipped: "no_handoffs" };
  try {
    const result = await enqueueIsolatedLiteraryPreparation(env, job.product_id, job.edition_id, {
      sourceId: job.source_id,
      contentHash: job.source_sha256,
    });
    if ("skipped" in result) {
      await env.DB.prepare(
        "UPDATE literary_prepare_outbox SET status='cancelled',last_error=?," +
          "lease_token='',lease_until='',updated_at=?" +
          " WHERE id=? AND lease_token=? AND status='running' AND lease_until>?",
      )
        .bind(result.skipped, new Date().toISOString(), job.id, token, new Date().toISOString())
        .run();
      return { cancelled: job.id, reason: result.skipped };
    }
    const expected = await digest(
      [job.product_id, job.edition_id, job.source_id, job.source_sha256].join(":"),
    );
    if (result.enqueued !== expected || job.id !== expected)
      throw Error("isolated_job_receipt_mismatch");
    // ACK only after the durable secondary claim AND optional queue send.
    // A lost send/ACK is replayable with the identical content-addressed ID.
    if (env.LITERARY_PREPARE_QUEUE)
      await env.LITERARY_PREPARE_QUEUE.send({
        schema: "cove.literary.prepare.v1",
        jobId: expected,
      });
    const ack = await env.DB.prepare(
      "UPDATE literary_prepare_outbox SET status='delivered'," +
        "delivered_job_id=?,lease_token='',lease_until='',updated_at=?" +
        " WHERE id=? AND lease_token=? AND status='running' AND lease_until>?" +
        " RETURNING id",
    )
      .bind(result.enqueued, new Date().toISOString(), job.id, token, new Date().toISOString())
      .first();
    if (!ack) throw Error("handoff_ack_lease_lost");
    return { delivered: job.id };
  } catch (error) {
    const reason = String(error).slice(0, 90);
    await env.DB.prepare(
      "UPDATE literary_prepare_outbox SET status=?,available_at=?," +
        "lease_token='',lease_until='',last_error=?,updated_at=?" +
        " WHERE id=? AND lease_token=? AND status='running'",
    )
      .bind(
        job.attempts < 4 ? "queued" : "failed",
        new Date(Date.now() + Math.min(3600000, 60000 * 2 ** job.attempts)).toISOString(),
        reason,
        new Date().toISOString(),
        job.id,
        token,
      )
      .run();
    return { failed: job.id, reason };
  }
}
