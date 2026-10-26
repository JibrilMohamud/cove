/* eslint-disable prettier/prettier -- The exact source-and-revision SQL fence is a security boundary. */
import type { CatalogPreparedMetadata } from "./catalog-normalization-core";
import { normalizeCatalogIndexRow } from "./catalog-index-core";

type Statement = {
  bind(...args: unknown[]): Statement;
  all<T>(): Promise<{ results: T[] }>;
};
type DB = {
  prepare(sql: string): Statement;
  batch(statements: Statement[]): Promise<Array<{ meta?: { changes?: number } }>>;
};
export type CanonicalPublisherEnv = {
  PRIMARY_DB: DB;
  CATALOG_INDEX_DB: DB;
  COVE_CATALOG_NORMALIZATION_PUBLISH_ENABLED?: string;
  COVE_CATALOG_PUBLICATION_PRIMARY_ID?: string;
};
const QA_PRIMARY = "5e3a6b69-6f3d-4b19-b837-01f7aa56ce87";
export function fencedCanonicalMetadataStatements(db: DB, doc: CatalogPreparedMetadata) {
  if (doc.schema !== "cove.catalog.normalized.v1" ||
      !/^(?:[0-9]{1,10}|(?:pgca|pgau|pgeu)_[a-z0-9_]{1,90})$/.test(doc.sourceId) ||
      !Number.isSafeInteger(doc.revision) || doc.revision < 1 ||
      doc.visible !== 1 ||
      typeof doc.title !== "string" || doc.title.length > 512 ||
      typeof doc.description !== "string" || doc.description.length > 5000 ||
      (doc.sourceTitle !== null && (typeof doc.sourceTitle !== "string" || doc.sourceTitle.length > 8192)) ||
      (doc.sourceSummary !== null && (typeof doc.sourceSummary !== "string" || doc.sourceSummary.length > 120000)))
    throw Error("catalog_invalid_publication");
  // Defense in depth: the isolated side is not allowed to substitute display
  // text unrelated to the primary's raw source, even if it supplies a matching
  // version and a correct legal-state snapshot. Recompute deterministically.
  const projected = normalizeCatalogIndexRow({
    id: doc.sourceId, title: doc.sourceTitle, summary: doc.sourceSummary,
    authors_json: "[]",subjects_json: "[]",bookshelves_json: "[]",
    languages_json: "[]",rights_status: "public-domain",
    commercial_use_status: "approved",ingest_status: "active",
    copyright: 0,updated_at: null,
  },doc.sourceId,doc.revision);
  if (!projected.title || projected.title !== doc.title ||
      projected.description !== doc.description)
    throw Error("catalog_invalid_prepared_metadata");
  const id = doc.sourceId;
  // Equality on raw primary-source fields, exact feed revision, and current
  // rights state is evaluated *inside* this D1 transaction. An event after
  // preparation, expired rights or withdrawn source makes this a no-op.
  // In particular, this operation cannot INSERT/UPDATE rights_grants.
  const guarded = `EXISTS (
    SELECT 1 FROM gutenberg_source_cache c
    WHERE c.id=? AND c.title IS ? AND c.summary IS ?
      AND c.copyright=0 AND c.ingest_status='active'
      AND c.rights_status='public-domain'
      AND c.commercial_use_status='approved'
  ) AND EXISTS(SELECT 1 FROM catalog_index_changefeed f
    WHERE f.seq=? AND f.cache_id=? AND f.operation='upsert')
    AND NOT EXISTS(SELECT 1 FROM catalog_index_changefeed newer
      WHERE newer.seq>? AND newer.cache_id=?)`;
  const guardArgs=[id,doc.sourceTitle,doc.sourceSummary,doc.revision,id,doc.revision,id];
  const receipt=db.prepare(`INSERT INTO catalog_canonical_publication_receipts
      (source_id,revision,title,updated_at)
      SELECT ?,?,?,datetime('now') WHERE ${guarded}
      ON CONFLICT(source_id) DO UPDATE SET revision=excluded.revision,
        title=excluded.title,updated_at=excluded.updated_at
      WHERE excluded.revision>catalog_canonical_publication_receipts.revision`)
    .bind(id,doc.revision,doc.title,...guardArgs);
  const verify=`EXISTS (SELECT 1 FROM catalog_canonical_publication_receipts r
    WHERE r.source_id=? AND r.revision=? AND r.title=?) AND ${guarded}`;
  const allowArgs=[id,doc.revision,doc.title,...guardArgs];
  const work=db.prepare(`UPDATE works SET title=?,description=?,updated_at=datetime('now')
    WHERE id=? AND ${verify}`)
    .bind(doc.title,doc.description,"wrk_gutenberg_"+id,...allowArgs);
  const edition=db.prepare(`UPDATE editions SET title=?,description=?,updated_at=datetime('now')
    WHERE id=? AND ${verify}`)
    .bind(doc.title,doc.description,"ed_gutenberg_"+id,...allowArgs);
  return [receipt,work,edition];
}
export async function publishFencedCanonicalMetadata(env: CanonicalPublisherEnv, ids: string[]) {
  if (env.COVE_CATALOG_NORMALIZATION_PUBLISH_ENABLED !== "1" ||
      env.COVE_CATALOG_PUBLICATION_PRIMARY_ID !== QA_PRIMARY ||
      env.PRIMARY_DB === (env.CATALOG_INDEX_DB as unknown))
    throw Error("catalog_publication_disabled_or_unsafe_binding");
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > 8 ||
      ids.some((x) => !/^(?:[0-9]{1,10}|(?:pgca|pgau|pgeu)_[a-z0-9_]{1,90})$/.test(x)) ||
      new Set(ids).size !== ids.length)
    throw Error("catalog_invalid_publication_ids");
  const result=await env.CATALOG_INDEX_DB.prepare(
    "SELECT source_id,revision,visible,source_title,source_summary,title,description FROM catalog_normalized_preparations WHERE source_id IN (" +
      ids.map(() => "?").join(",") + ")"
  ).bind(...ids).all<{
    source_id: string; revision: number; visible: number; source_title: string|null;
    source_summary: string|null; title: string; description: string;
  }>();
  const byId=new Map(result.results.map((r) => [r.source_id,r]));
  const ready:{ id:string; writes:Statement[] }[]=[];
  const skipped=new Map<string,string>();
  for (const id of ids) {
    const row=byId.get(id);
    if (!row || row.visible!==1) {
      skipped.set(id,"missing_or_withdrawn");
      continue;
    }
    const doc:CatalogPreparedMetadata={
      schema:"cove.catalog.normalized.v1",sourceId:id,revision:row.revision,
      visible:row.visible,sourceTitle:row.source_title,sourceSummary:row.source_summary,
      title:row.title,description:row.description,
    };
    // Prevalidate *all* untrusted isolated data before any canonical mutation.
    // Every document still has its own exact-source, feed/revision and legal
    // guards inside the primary transaction.
    ready.push({id,writes:fencedCanonicalMetadataStatements(env.PRIMARY_DB,doc)});
  }
  const changed=new Map<string,boolean>();
  if (ready.length) {
    // Up to eight documents x (receipt, work, edition) = 24 bounded SQL
    // statements. One primary service roundtrip and one all-or-nothing D1
    // transaction, rather than eight transactions competing with storefront
    // authorization. A retry is safe: unchanged receipt revisions do nothing.
    const writes=await env.PRIMARY_DB.batch(ready.flatMap((r)=>r.writes));
    if (writes.length!==ready.length*3)
      throw Error("catalog_incomplete_publication_receipt");
    for (let i=0;i<ready.length;i++)
      changed.set(ready[i].id,Number(writes[i*3]?.meta?.changes || 0)===1);
  }
  return {published:ids.map((id)=>skipped.has(id)
    ? {id,applied:false,reason:skipped.get(id)}
    : {id,applied:changed.get(id)===true})};
}
