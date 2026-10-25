/* eslint-disable prettier/prettier -- Bounded isolated SQL fences and adversarial publication proofs are deliberately kept adjacent. */
import {
  normalizeCatalogIndexRow, catalogIndexWrite,
  type RawCatalogIndexRow,
} from "./catalog-index-core";

type Statement = {
  bind(...v: unknown[]): Statement;
  first<T>(): Promise<T | null>;
  all<T>(): Promise<{ results: T[] }>;
  run(): Promise<{ meta?: { changes?: number } }>;
};
type DB = { prepare(sql: string): Statement };
type Source = DB & { withSession(constraint: "first-unconstrained"): DB };
export type CatalogCaptureEnv = {
  SOURCE_DB: Source;
  CATALOG_INDEX_DB: DB;
  COVE_CATALOG_INDEX_CAPTURE_ENABLED?: string;
};
const LEASE_MS = 90_000;
const BATCH_SIZE = 16;
const SELECTION = "id,title,summary,authors_json,subjects_json,bookshelves_json,languages_json,rights_status,commercial_use_status,ingest_status,copyright,updated_at";

async function assertIsolated(env: CatalogCaptureEnv) {
  if (env.COVE_CATALOG_INDEX_CAPTURE_ENABLED !== "1")
    throw Error("catalog_index_capture_disabled");
  if (env.SOURCE_DB === env.CATALOG_INDEX_DB)
    throw Error("catalog_index_primary_binding_forbidden");
  const state = await env.CATALOG_INDEX_DB.prepare(
    "SELECT domain,EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name IN ('rights_grants','orders','entitlements','products','gutenberg_source_cache')) contaminated FROM catalog_index_identity WHERE id=1"
  ).first<{ domain: string; contaminated: number }>();
  if (state?.domain !== "cove-independent-catalog-index" || state.contaminated)
    throw Error("catalog_index_domain_not_isolated");
}
async function writeRows(db: DB, rows: RawCatalogIndexRow[], changes: Array<{ id: string; seq: number; operation?: string }>) {
  const byId = new Map(rows.map((row) => [row.id, row]));
  for (const change of changes) {
    const row = change.operation === "delete" ? null : byId.get(change.id) || null;
    const doc = normalizeCatalogIndexRow(row, change.id, change.seq);
    const write = catalogIndexWrite(doc);
    await db.prepare(write.sql).bind(...write.binds).run();
  }
}
async function renew(db: DB, owner: string) {
  const now = Date.now();
  const lease = await db.prepare(
    "UPDATE catalog_index_capture SET lease_until=? WHERE id=1 AND owner=? AND lease_until>? RETURNING id",
  ).bind(now + LEASE_MS, owner, now).first<{ id: number }>();
  if (!lease) throw Error("catalog_index_capture_lease_lost");
}
function readOnlySource(source: Source): DB {
  // Fixed SELECTs below: a capture worker cannot publish rights, normalize
  // canonical tables or mutate customer-owned D1.
  return source.withSession("first-unconstrained");
}
export async function captureIsolatedCatalogIndex(env: CatalogCaptureEnv) {
  await assertIsolated(env);
  const owner = crypto.randomUUID(), started = Date.now();
  const claim = await env.CATALOG_INDEX_DB.prepare(
    "UPDATE catalog_index_capture SET owner=?,lease_until=? WHERE id=1 AND lease_until<=? RETURNING backfill_cursor,backfill_done,feed_cursor"
  ).bind(owner, started + LEASE_MS, started)
    .first<{ backfill_cursor: string; backfill_done: number; feed_cursor: number }>();
  if (!claim) return { busy: true };
  try {
    const source = readOnlySource(env.SOURCE_DB);
    if (!claim.backfill_done) {
      const items = await source.prepare(
        "SELECT " + SELECTION + " FROM gutenberg_source_cache WHERE id>? ORDER BY id LIMIT ?"
      ).bind(claim.backfill_cursor, BATCH_SIZE).all<RawCatalogIndexRow>();
      await renew(env.CATALOG_INDEX_DB, owner);
      await writeRows(env.CATALOG_INDEX_DB, items.results,
        items.results.map((row) => ({ id: row.id, seq: 0 })));
      const cursor = items.results.at(-1)?.id || claim.backfill_cursor;
      const done = items.results.length < BATCH_SIZE ? 1 : 0;
      const ack = await env.CATALOG_INDEX_DB.prepare(
        "UPDATE catalog_index_capture SET backfill_cursor=?,backfill_done=? WHERE id=1 AND owner=? AND lease_until>? RETURNING id"
      ).bind(cursor, done, owner, Date.now()).first<{ id: number }>();
      if (!ack) throw Error("catalog_index_capture_lease_lost");
      return { lane: "backfill", indexed: items.results.length, complete: !!done };
    }
    const events = await source.prepare(
      "SELECT seq,cache_id id,operation FROM catalog_index_changefeed WHERE seq>? ORDER BY seq LIMIT ?"
    ).bind(claim.feed_cursor, BATCH_SIZE)
      .all<{ seq: number; id: string; operation: "upsert" | "delete" }>();
    if (!events.results.length) return { lane: "feed", indexed: 0, cursor: claim.feed_cursor };
    const ids = [...new Set(events.results.filter((x) => x.operation === "upsert").map((x) => x.id))];
    const rows = ids.length ? (await source.prepare(
      "SELECT " + SELECTION + " FROM gutenberg_source_cache WHERE id IN (" +
        ids.map(() => "?").join(",") + ")"
    ).bind(...ids).all<RawCatalogIndexRow>()).results : [];
    await renew(env.CATALOG_INDEX_DB, owner);
    await writeRows(env.CATALOG_INDEX_DB, rows, events.results);
    const last = events.results.at(-1)!.seq;
    const ack = await env.CATALOG_INDEX_DB.prepare(
      "UPDATE catalog_index_capture SET feed_cursor=? WHERE id=1 AND owner=? AND lease_until>? AND feed_cursor<? RETURNING id"
    ).bind(last, owner, Date.now(), last).first<{ id: number }>();
    if (!ack) throw Error("catalog_index_capture_lease_lost");
    return { lane: "feed", indexed: events.results.length, cursor: last };
  } finally {
    await env.CATALOG_INDEX_DB.prepare(
      "UPDATE catalog_index_capture SET owner='',lease_until=0 WHERE id=1 AND owner=?"
    ).bind(owner).run();
  }
}
