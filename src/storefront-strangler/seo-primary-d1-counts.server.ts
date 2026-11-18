/**
 * STAGING-ONLY D1 adapter for SEO counts. No production import/call site.
 * Requires separately verified owner authority and physical writer exclusion.
 * See scripts/staging/seo-primary-count-fence.prototype.sql for its schema.
 */
import {SEO_COUNT_GENERATION_KEYS, SEO_COUNT_KINDS, SEO_COUNT_PROJECTION_SCHEMA,
  verifiedSeoCounts, type SeoCounts, type SeoCountProjectionEvidence
} from "../features/fore/seo-count-projection";
import type {SeoCountBuildPort} from "../features/fore/seo-count-projection-producer";

export const SEO_PRIMARY_ID="4bd657ac-8789-403e-a28c-93aba8d0a989";
type Statement={bind(...values:unknown[]):Statement;first<T=unknown>():Promise<T|null>};
export type SeoPrimaryDb={withSession(constraint:"first-primary"):{prepare(sql:string):Statement}};
export type VerifiedSeoOwner={
  primaryId:string;ownerVersion:string;ownerEnabled:true;exclusiveWriter:true;authorizing:true
};
const epochColumns=["catalog_generation","rights_generation","withdrawal_generation",
  "taxonomy_generation","contributor_generation"] as const;
const countColumns=["books_count","works_count","editions_count","authors_count","categories_count"] as const;
type Row=Record<string,unknown>;

const selectFence="SELECT owner_version,catalog_generation,rights_generation,withdrawal_generation,taxonomy_generation,contributor_generation,dirty,pending_withdrawals,pending_writes FROM cove_seo_primary_fence WHERE slot=1";
const selectEvidence=`SELECT f.owner_version,f.catalog_generation,f.rights_generation,f.withdrawal_generation,
  f.taxonomy_generation,f.contributor_generation,f.dirty,f.pending_withdrawals,f.pending_writes,
  s.owner_version AS snapshot_owner_version,s.catalog_generation AS snapshot_catalog_generation,
  s.rights_generation AS snapshot_rights_generation,
  s.withdrawal_generation AS snapshot_withdrawal_generation,
  s.taxonomy_generation AS snapshot_taxonomy_generation,
  s.contributor_generation AS snapshot_contributor_generation,
  s.built_at_ms,s.expires_at_ms,s.books_count,s.works_count,s.editions_count,
  s.authors_count,s.categories_count FROM cove_seo_primary_fence f
  LEFT JOIN cove_seo_count_snapshots s ON s.slot=f.slot WHERE f.slot=1`;
export const SEO_PRIMARY_ATOMIC_PUBLISH_SQL=`
INSERT INTO cove_seo_count_snapshots(
  slot,owner_version,catalog_generation,rights_generation,withdrawal_generation,
  taxonomy_generation,contributor_generation,built_at_ms,expires_at_ms,
  books_count,works_count,editions_count,authors_count,categories_count)
SELECT 1,f.owner_version,f.catalog_generation,f.rights_generation,f.withdrawal_generation,
  f.taxonomy_generation,f.contributor_generation,?,?,?,?,?,?,?
FROM cove_seo_primary_fence f
WHERE f.slot=1 AND f.owner_version=? AND f.dirty=0
  AND f.pending_withdrawals=0 AND f.pending_writes=0
  AND f.catalog_generation=? AND f.rights_generation=? AND f.withdrawal_generation=?
  AND f.taxonomy_generation=? AND f.contributor_generation=?
ON CONFLICT(slot) DO UPDATE SET
  owner_version=excluded.owner_version,catalog_generation=excluded.catalog_generation,
  rights_generation=excluded.rights_generation,withdrawal_generation=excluded.withdrawal_generation,
  taxonomy_generation=excluded.taxonomy_generation,contributor_generation=excluded.contributor_generation,
  built_at_ms=excluded.built_at_ms,expires_at_ms=excluded.expires_at_ms,
  books_count=excluded.books_count,works_count=excluded.works_count,
  editions_count=excluded.editions_count,authors_count=excluded.authors_count,
  categories_count=excluded.categories_count
WHERE excluded.built_at_ms>cove_seo_count_snapshots.built_at_ms
RETURNING slot
`;

function trustedOwner(witness:VerifiedSeoOwner):string{
  if(witness?.primaryId!==SEO_PRIMARY_ID||witness.ownerEnabled!==true||
    witness.exclusiveWriter!==true||witness.authorizing!==true||
    typeof witness.ownerVersion!=="string"||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(witness.ownerVersion))
    throw Error("seo_owner_not_certified");
  // A caller-supplied boolean cannot prove real owner authority; the private
  // caller must obtain this witness from an independently reviewed authority.
  return witness.ownerVersion;
}
function primary(db:SeoPrimaryDb){
  if(!db||typeof db.withSession!=="function")throw Error("seo_primary_session_unavailable");
  return db.withSession("first-primary");
}
function epoch(value:unknown):string{
  if(!Number.isSafeInteger(value)||(value as number)<0)throw Error("seo_epoch_invalid");
  return String(value);
}
function fenceFrom(row:Row|null,owner:string){
  if(!row||row.owner_version!==owner)throw Error("seo_primary_owner_version_mismatch");
  return {
    ownerVersion:owner,
    ...Object.fromEntries(SEO_COUNT_GENERATION_KEYS.slice(1).map((key,i)=>[key,epoch(row[epochColumns[i]])])),
    ownerEnabled:true,exclusiveWriter:true,primaryD1:true,
    dirty:row.dirty!==0,pendingWithdrawals:row.pending_withdrawals,pendingWrites:row.pending_writes,
  };
}
export async function readSeoPrimaryFence(db:SeoPrimaryDb,witness:VerifiedSeoOwner){
  const owner=trustedOwner(witness);
  return fenceFrom(await primary(db).prepare(selectFence).first<Row>(),owner);
}
export async function readSeoCountEvidence(db:SeoPrimaryDb,witness:VerifiedSeoOwner):
  Promise<SeoCountProjectionEvidence>{
  const owner=trustedOwner(witness);
  // Same primary SELECT captures fence and snapshot consistently, rather than
  // a replica read or independent query that races the withdrawal.
  const row=await primary(db).prepare(selectEvidence).first<Row>();
  const fence=fenceFrom(row,owner);
  if(!row||row.snapshot_owner_version!==owner||row.built_at_ms===null)
    return {snapshot:null,fence};
  const snapshot={
    schema:SEO_COUNT_PROJECTION_SCHEMA,ownerVersion:owner,
    ...Object.fromEntries(SEO_COUNT_GENERATION_KEYS.slice(1).map((key,i)=>[
      key,epoch(row["snapshot_"+epochColumns[i]])
    ])),
    createdAtMs:row.built_at_ms,expiresAtMs:row.expires_at_ms,
    counts:Object.fromEntries(SEO_COUNT_KINDS.map((key,i)=>[key,row[countColumns[i]]])),
  };
  return {snapshot,fence};
}
export async function publishSeoCountCas(
  db:SeoPrimaryDb,witness:VerifiedSeoOwner,expectedFence:unknown,snapshot:unknown
):Promise<boolean>{
  const owner=trustedOwner(witness);
  if(!expectedFence||typeof expectedFence!=="object"||!snapshot||typeof snapshot!=="object")
    return false;
  const before=expectedFence as Record<string,unknown>;
  const doc=snapshot as Record<string,unknown>;
  if(before.ownerVersion!==owner||doc.ownerVersion!==owner)return false;
  if(!verifiedSeoCounts({snapshot:doc,fence:before},Number(doc.createdAtMs)))return false;
  const epochs=SEO_COUNT_GENERATION_KEYS.slice(1).map(key=>{
    const value=before[key];
    if(typeof value!=="string"||!/^(0|[1-9][0-9]*)$/.test(value)||
      !Number.isSafeInteger(Number(value)))throw Error("seo_publish_epoch_invalid");
    return Number(value);
  });
  const counts=doc.counts as SeoCounts;
  // One SQLite statement does the version comparison and snapshot write.
  const result=await primary(db).prepare(SEO_PRIMARY_ATOMIC_PUBLISH_SQL).bind(
    doc.createdAtMs,doc.expiresAtMs,
    ...SEO_COUNT_KINDS.map(kind=>counts[kind]),owner,...epochs
  ).first<{slot:number}>();
  return result?.slot===1;
}
export function seoCountPrimaryBuildPort(
  db:SeoPrimaryDb,witness:VerifiedSeoOwner,
  countAuthoritative:SeoCountBuildPort["countAuthoritative"],
  nowMs?:()=>number
):SeoCountBuildPort{
  trustedOwner(witness);
  return {
    readPrimaryFence:()=>readSeoPrimaryFence(db,witness),
    countAuthoritative,
    compareAndPublish:(fence,snapshot)=>publishSeoCountCas(db,witness,fence,snapshot),
    nowMs,
  };
}
