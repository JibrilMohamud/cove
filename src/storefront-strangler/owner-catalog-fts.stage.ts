/* eslint-disable prettier/prettier -- Audited stage-only owner FTS5 projection. */
import type {AuthoritySql} from './legal-authority-core';

/**
 * ONLY authorized owner-index rows may be added to FTS5. Content and rights
 * share the same SQLite transaction, including removal by contract/source
 * withdrawal and time-based expiry. These tables are NOT a grant store.
 * Existing owner indices require explicit backfill + seal; migration must
 * never silently activate an empty FTS index.
 */
export function createStageOwnerFtsSchema(sql:AuthoritySql){
  sql.exec(`CREATE TABLE IF NOT EXISTS cove_stage_owner_fts_ids(
    fts_rowid INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id TEXT NOT NULL UNIQUE
  )`);
  sql.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS cove_stage_owner_fts
    USING fts5(product_id UNINDEXED,title,publisher,format,tokenize='unicode61')`);
  // Read-only inverted-index document frequencies. On 82k rows this lets
  // owner SQLite avoid an expensive rank-index walk for rare keywords.
  sql.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS cove_stage_owner_fts_vocab
    USING fts5vocab(cove_stage_owner_fts,'row')`);
  sql.exec(`CREATE TABLE IF NOT EXISTS cove_stage_owner_fts_ready(
    id INTEGER PRIMARY KEY CHECK(id=1),ready INTEGER NOT NULL CHECK(ready IN (0,1))
  )`);
  sql.exec(`INSERT OR IGNORE INTO cove_stage_owner_fts_ready(id,ready) VALUES(1,0)`);
  sql.exec(`CREATE TRIGGER IF NOT EXISTS cove_stage_owner_fts_insert
    AFTER INSERT ON cove_stage_owner_index_items BEGIN
      INSERT INTO cove_stage_owner_fts_ids(product_id) VALUES(NEW.product_id);
      INSERT INTO cove_stage_owner_fts(rowid,product_id,title,publisher,format)
      VALUES((SELECT fts_rowid FROM cove_stage_owner_fts_ids
        WHERE product_id=NEW.product_id),NEW.product_id,
        NEW.title,NEW.publisher,NEW.format);
    END`);
  sql.exec(`CREATE TRIGGER IF NOT EXISTS cove_stage_owner_fts_delete
    AFTER DELETE ON cove_stage_owner_index_items BEGIN
      DELETE FROM cove_stage_owner_fts WHERE rowid=(
        SELECT fts_rowid FROM cove_stage_owner_fts_ids WHERE product_id=OLD.product_id);
      DELETE FROM cove_stage_owner_fts_ids WHERE product_id=OLD.product_id;
    END`);
  sql.exec(`CREATE TRIGGER IF NOT EXISTS cove_stage_owner_fts_update
    AFTER UPDATE ON cove_stage_owner_index_items BEGIN
      UPDATE cove_stage_owner_fts SET product_id=NEW.product_id,
        title=NEW.title,publisher=NEW.publisher,format=NEW.format
      WHERE rowid=(SELECT fts_rowid FROM cove_stage_owner_fts_ids
        WHERE product_id=OLD.product_id);
      UPDATE cove_stage_owner_fts_ids SET product_id=NEW.product_id
      WHERE product_id=OLD.product_id;
    END`);
}
export function sealStageOwnerFts(sql:AuthoritySql){
  const counts=sql.exec<{products:number;keys:number;fts:number}>(`SELECT
    (SELECT COUNT(*) FROM cove_stage_owner_index_items) products,
    (SELECT COUNT(*) FROM cove_stage_owner_fts_ids) keys,
    (SELECT COUNT(*) FROM cove_stage_owner_fts) fts`).toArray()[0];
  if(!counts||counts.products!==counts.keys||counts.products!==counts.fts)
    throw Error('stage_owner_fts_partial_index_rejected');
  // Equal counts are NOT sufficient: 82k identifiers could be shuffled or
  // content altered while the totals still agree. Seal only when all
  // authorized product IDs, FTS row mappings, and searchable text are exact.
  const missing=sql.exec(`SELECT 1 FROM cove_stage_owner_index_items i
    WHERE NOT EXISTS(SELECT 1 FROM cove_stage_owner_fts_ids m
      WHERE m.product_id=i.product_id) LIMIT 1`).toArray();
  const orphaned=sql.exec(`SELECT 1 FROM cove_stage_owner_fts_ids m
    WHERE NOT EXISTS(SELECT 1 FROM cove_stage_owner_index_items i
      WHERE i.territory='US' AND i.currency='USD'
        AND i.product_id=m.product_id) LIMIT 1`).toArray();
  const mismatch=sql.exec(`SELECT 1 FROM cove_stage_owner_fts_ids m
    JOIN cove_stage_owner_fts f ON f.rowid=m.fts_rowid
    JOIN cove_stage_owner_index_items i ON
      i.territory='US' AND i.currency='USD' AND i.product_id=m.product_id
    WHERE f.product_id<>m.product_id OR f.title<>i.title
      OR f.format<>i.format OR f.publisher<>i.publisher LIMIT 1`).toArray();
  if(missing.length||orphaned.length||mismatch.length)
    throw Error('stage_owner_fts_partial_index_rejected');
  sql.exec('UPDATE cove_stage_owner_fts_ready SET ready=1 WHERE id=1');
}
export function assertStageOwnerFtsReady(sql:AuthoritySql){
  const ready=sql.exec<{ready:number}>(`SELECT ready FROM cove_stage_owner_fts_ready
    WHERE id=1`).toArray()[0];
  if(ready?.ready!==1)throw Error('stage_owner_fts_unsealed');
}
/** Deliberately conservative FTS grammar; unsupported syntax never falls
 * back to a broad, potentially overinclusive search or unsafe raw MATCH.
 * Full production synonyms/relevance/typo logic is NOT implemented here.
 */
export function stageOwnerLiteralFtsExpression(raw:string|undefined){
  if(raw===undefined||raw==='')return '';
  if(typeof raw!=='string')throw Error('stage_owner_fts_invalid_query');
  const normalized=raw.trim().normalize('NFKC').toLocaleLowerCase('en-US');
  if(!normalized||normalized.length>120||
    !/^[\p{L}\p{N}\s]+$/u.test(normalized))
    throw Error('stage_owner_fts_invalid_query');
  const tokens=normalized.split(/\s+/);
  if(tokens.length>8||tokens.some(t=>t.length>35))
    throw Error('stage_owner_fts_invalid_query');
  return tokens.map(t=>'"'+t+'"').join(' AND ');
}

/**
 * Upper bound for an AND-combined literal FTS query. The smallest single
 * token document frequency is >= intersection size, so selecting FTS-first
 * from this bound is conservative and CANNOT change search authorization.
 * Only page query planning uses it; count/facets remain identical.
 *
 * A missing word means zero matches, not permission to serve all books.
 */
/**
 * Exact all-documents fast path for ubiquitous literal terms. An AND query
 * matches every authorized index document iff each quoted term has a document
 * frequency equal to the current owner-index count. The FTS table is sealed,
 * and callers must have checked dirty state, proof expiry and market veto.
 *
 * Only a logical query simplification: no authorization may be inferred
 * from FTS or from a cache. If a token frequency is missing or inconsistent,
 * the caller must execute the ordinary FTS predicate.
 */
export function stageOwnerFtsCoversAll(sql:AuthoritySql,expression:string,total:number){
  if(!expression||!Number.isSafeInteger(total)||total<1)return false;
  const tokens=[...expression.matchAll(/"([^"]+)"/g)].map(m=>m[1]);
  if(!tokens.length||tokens.length>8)return false;
  return tokens.every(token=>{
    const row=sql.exec<{doc:number}>(`SELECT doc FROM cove_stage_owner_fts_vocab
      WHERE term=?`,token).toArray()[0];
    return row?.doc===total;
  });
}

export function stageOwnerFtsPreferMatchesFirst(sql:AuthoritySql,expression:string){
  if(!expression)return false;
  const tokens=[...expression.matchAll(/"([^"]+)"/g)].map(m=>m[1]);
  if(!tokens.length||tokens.length>8)
    throw Error('stage_owner_fts_unreviewed_expression');
  let upperBound=Number.POSITIVE_INFINITY;
  for(const token of tokens){
    const row=sql.exec<{doc:number}>(`SELECT doc FROM cove_stage_owner_fts_vocab
      WHERE term=?`,token).toArray()[0];
    const documents=row?.doc??0;
    if(!Number.isSafeInteger(documents)||documents<0)
      throw Error('stage_owner_fts_untrusted_frequency');
    upperBound=Math.min(upperBound,documents);
  }
  // Conservative stage cutover threshold, measured on an 82,249-row
  // synthetic fixture. Hosted real-corpus planner calibration is required.
  return upperBound<=128;
}
