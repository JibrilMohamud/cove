/* eslint-disable prettier/prettier -- Stage-only owner SQL index; NOT production authorization. */
/**
 * Materialized, strongly-consistent OWNER-LOCAL projection for the default
 * public US/USD rank-sorted catalog. This proof intentionally rejects every
 * other query/filter/sort; it cannot be used to claim full storefront parity.
 *
 * ALL legal writes and reconciliation MUST be performed in one owner SQLite
 * transaction. Triggers create a durable dirty-product queue for every
 * entitlement, legal/source, contract, proof, and metadata transition.
 * Reading while ANY dirty row exists fails closed, never returning stale
 * counts/facets or paid offers. A market tombstone is an O(1) read veto.
 *
 * This is NOT authoritative rights publication. The verified offer and
 * current source proof have to be written by the canonical owner first.
 */
import type {AuthoritySql} from './legal-authority-core';
import {readAuthorizedPresentations} from './legal-authority-core';
import {readCommercialStorefront} from './commercial-storefront-authority';
import {marketIsWithdrawn} from './market-authority-core';
import {createStageOwnerFtsSchema,sealStageOwnerFts,assertStageOwnerFtsReady,
  stageOwnerLiteralFtsExpression,stageOwnerFtsPreferMatchesFirst,
  stageOwnerFtsCoversAll} from './owner-catalog-fts.stage';

const GOOD_ID=/^prd_[a-zA-Z0-9_-]{3,120}$/;
const DEFAULT={territory:'US',currency:'USD',sort:'rank'} as const;
const KINDS=['categories','languages','formats','publishers','series','availability'] as const;
const CAPS={categories:40,languages:30,formats:20,publishers:30,series:30,availability:2} as const;
const LEGAL_TABLES=[
  'cove_authorized_offer_proofs','cove_commercial_authority',
  'cove_commercial_scope_proofs','cove_commercial_storefront_proofs',
  'cove_stage_owner_catalog','cove_stage_owner_catalog_category',
  'cove_stage_owner_catalog_language','cove_stage_owner_catalog_series',
] as const;

export function createStageOwnerIncrementalIndex(sql:AuthoritySql){
  sql.exec(`CREATE TABLE IF NOT EXISTS cove_stage_owner_index_state(
    id INTEGER PRIMARY KEY CHECK(id=1), bootstrapped INTEGER NOT NULL DEFAULT 0
  )`);
  sql.exec(`INSERT OR IGNORE INTO cove_stage_owner_index_state(id,bootstrapped) VALUES(1,0)`);
  sql.exec(`CREATE TABLE IF NOT EXISTS cove_stage_owner_dirty(
    product_id TEXT PRIMARY KEY
  ) WITHOUT ROWID`);
  sql.exec(`CREATE TABLE IF NOT EXISTS cove_stage_owner_index_items(
    product_id TEXT NOT NULL,territory TEXT NOT NULL,currency TEXT NOT NULL,
    title TEXT NOT NULL,rank_score INTEGER NOT NULL,
    format TEXT NOT NULL,publisher TEXT NOT NULL,
    price_minor INTEGER NOT NULL CHECK(price_minor>=0),
    expires_at TEXT NOT NULL,
    PRIMARY KEY(territory,currency,product_id)
  ) WITHOUT ROWID`);
  sql.exec(`CREATE INDEX IF NOT EXISTS cove_stage_owner_index_rank ON
    cove_stage_owner_index_items(territory,currency,rank_score DESC,product_id)`);
  sql.exec(`CREATE INDEX IF NOT EXISTS cove_stage_owner_index_price ON
    cove_stage_owner_index_items(territory,currency,price_minor)`);
  sql.exec(`CREATE INDEX IF NOT EXISTS cove_stage_owner_index_expiry ON
    cove_stage_owner_index_items(territory,currency,expires_at)`);
  sql.exec(`CREATE TABLE IF NOT EXISTS cove_stage_owner_index_dimensions(
    product_id TEXT NOT NULL,territory TEXT NOT NULL,currency TEXT NOT NULL,
    kind TEXT NOT NULL,value TEXT NOT NULL,
    PRIMARY KEY(territory,currency,product_id,kind,value)
  ) WITHOUT ROWID`);
  // The dimension PK is product-first, ideal for reconciliation but
  // pathological for cold, distinct filtered queries. This inverted index
  // selects a small disjunctive posting list BEFORE the expensive per-facet
  // scan. It stores no permission separate from the canonical owner items.
  sql.exec(`CREATE INDEX IF NOT EXISTS cove_stage_owner_index_dimension_inverted ON
    cove_stage_owner_index_dimensions(territory,currency,kind,value,product_id)`);
  sql.exec(`CREATE TABLE IF NOT EXISTS cove_stage_owner_index_facet_counts(
    territory TEXT NOT NULL,currency TEXT NOT NULL,
    kind TEXT NOT NULL,value TEXT NOT NULL,
    amount INTEGER NOT NULL CHECK(amount>0),
    PRIMARY KEY(territory,currency,kind,value)
  ) WITHOUT ROWID`);
  sql.exec(`CREATE TABLE IF NOT EXISTS cove_stage_owner_index_totals(
    territory TEXT NOT NULL,currency TEXT NOT NULL,
    amount INTEGER NOT NULL CHECK(amount>=0),
    PRIMARY KEY(territory,currency)
  ) WITHOUT ROWID`);
  // Filter snapshots are readable only at the EXACT committed owner-index
  // epoch. Index-row changes bump the epoch in the same SQLite transaction
  // that acknowledges the canonical legal mutation.
  sql.exec(`CREATE TABLE IF NOT EXISTS cove_stage_owner_index_epoch(
    id INTEGER PRIMARY KEY CHECK(id=1),epoch INTEGER NOT NULL CHECK(epoch>=0)
  )`);
  sql.exec('INSERT OR IGNORE INTO cove_stage_owner_index_epoch(id,epoch) VALUES(1,0)');
  sql.exec(`CREATE TABLE IF NOT EXISTS cove_stage_owner_index_query_cache(
    scope_key TEXT PRIMARY KEY,epoch INTEGER NOT NULL,
    expires_at TEXT NOT NULL,body TEXT NOT NULL
  ) WITHOUT ROWID`);
  for(const verb of ['INSERT','UPDATE','DELETE'] as const){
    sql.exec(`CREATE TRIGGER IF NOT EXISTS cove_stage_owner_index_epoch_${verb.toLowerCase()}
      AFTER ${verb} ON cove_stage_owner_index_items BEGIN
      UPDATE cove_stage_owner_index_epoch SET epoch=epoch+1 WHERE id=1;
      END`);
  }
  // Direct changes to dimension rows can alter facets without modifying an
  // owner item. Fence every prebuilt bitmap against them too: a drifted
  // dimension epoch must never be served as a current snapshot.
  for(const verb of ['INSERT','UPDATE','DELETE'] as const){
    sql.exec(`CREATE TRIGGER IF NOT EXISTS cove_stage_owner_dimension_epoch_${verb.toLowerCase()}
      AFTER ${verb} ON cove_stage_owner_index_dimensions BEGIN
      UPDATE cove_stage_owner_index_epoch SET epoch=epoch+1 WHERE id=1;
      END`);
  }
  // An owner-local, durable mutation journal is necessary for removal-only
  // bitmap deltas. Epochs alone say WHAT changed, not whether it was a safe
  // withdrawal or an unreviewed positive grant/metadata edit. Journal flags
  // accumulate inside the SAME legal-owner SQLite transaction; callers may
  // only clear them after sealing a full new bitmap or accepting a strictly
  // removal-only overlay. This is a stage-only experiment.
  sql.exec(\`CREATE TABLE IF NOT EXISTS cove_stage_owner_bitmap_change_log(
    product_id TEXT PRIMARY KEY,
    item_deleted INTEGER NOT NULL DEFAULT 0,
    item_written INTEGER NOT NULL DEFAULT 0,
    dimension_deleted INTEGER NOT NULL DEFAULT 0,
    dimension_written INTEGER NOT NULL DEFAULT 0
  ) WITHOUT ROWID\`);
  const recordBitmapChange=(table:string,verb:'INSERT'|'UPDATE'|'DELETE',
    oldOrNew:'OLD'|'NEW',flag:string)=>{
    const id=oldOrNew+'.product_id';
    sql.exec(\`CREATE TRIGGER IF NOT EXISTS cove_stage_owner_bm_\${table}_\${verb.toLowerCase()}_\${oldOrNew.toLowerCase()}
      AFTER \${verb} ON cove_stage_owner_index_\${table} BEGIN
      INSERT INTO cove_stage_owner_bitmap_change_log(product_id,\${flag})
        VALUES(\${id},1)
        ON CONFLICT(product_id) DO UPDATE SET \${flag}=1;
      END\`);
  };
  for(const [table,deleted,inserted] of [
    ['items','item_deleted','item_written'],
    ['dimensions','dimension_deleted','dimension_written'],
  ] as const){
    recordBitmapChange(table,'DELETE','OLD',deleted);
    recordBitmapChange(table,'INSERT','NEW',inserted);
    recordBitmapChange(table,'UPDATE','OLD',inserted);
    recordBitmapChange(table,'UPDATE','NEW',inserted);
  }
  // Raw edits to aggregate counts can cause result drift without changing
  // item/dimension rows. Advance the epoch so no old snapshot can serve; the
  // removal-only writer refuses such unmatched changes.
  for(const table of ['facet_counts','totals'] as const){
    for(const verb of ['INSERT','UPDATE','DELETE'] as const){
      sql.exec(\`CREATE TRIGGER IF NOT EXISTS cove_stage_owner_bm_\${table}_epoch_\${verb.toLowerCase()}
        AFTER \${verb} ON cove_stage_owner_index_\${table} BEGIN
        UPDATE cove_stage_owner_index_epoch SET epoch=epoch+1 WHERE id=1;
        END\`);
    }
  }
  // Every legal/material change must enqueue the affected product(s), even
  // when a caller forgets to refresh. Missing reconciliation blocks ALL
  // indexed reads instead of silently exposing an old paid authorization.
  for(const [i,table] of LEGAL_TABLES.entries()){
    for(const verb of ['INSERT','UPDATE','DELETE'] as const){
      const suffix=verb==='DELETE'?'OLD':'NEW';
      sql.exec(`CREATE TRIGGER IF NOT EXISTS cove_stage_owner_idx_${i}_${verb.toLowerCase()}
        AFTER ${verb} ON ${table} BEGIN
        INSERT OR IGNORE INTO cove_stage_owner_dirty(product_id)
          VALUES(${suffix}.product_id);
        END`);
      if(verb==='UPDATE')sql.exec(`CREATE TRIGGER IF NOT EXISTS cove_stage_owner_idx_${i}_update_old
        AFTER UPDATE ON ${table} BEGIN
        INSERT OR IGNORE INTO cove_stage_owner_dirty(product_id) VALUES(OLD.product_id);
        END`);
    }
  }
  // A global or scoped free-source fence has no product_id column. Enqueue
  // every product whose stored positive offer proof references that source.
  for(const verb of ['INSERT','UPDATE','DELETE'] as const){
    for(const side of verb==='UPDATE'?['OLD','NEW']:[verb==='DELETE'?'OLD':'NEW']){
      sql.exec(`CREATE TRIGGER IF NOT EXISTS cove_stage_owner_idx_free_fence_${verb.toLowerCase()}_${side.toLowerCase()}
        AFTER ${verb} ON cove_legal_fences BEGIN
        INSERT OR IGNORE INTO cove_stage_owner_dirty(product_id)
        SELECT product_id FROM cove_authorized_offer_proofs
        WHERE source_id=${side}.source_id;
        END`);
    }
  }
  // A contract/grant denial can affect MANY books. Reverse indexes bound
  // the fanout; dirty rows are created in the owner transaction, with reads
  // denied until the entire queue has been reconciled.
  sql.exec(`CREATE INDEX IF NOT EXISTS cove_stage_owner_idx_grant_fanout ON
    cove_commercial_storefront_proofs(grant_id,product_id)`);
  sql.exec(`CREATE INDEX IF NOT EXISTS cove_stage_owner_idx_contract_fanout ON
    cove_commercial_storefront_proofs(contract_id,product_id)`);
  for(const verb of ['INSERT','UPDATE','DELETE'] as const){
    for(const side of verb==='UPDATE'?['OLD','NEW']:[verb==='DELETE'?'OLD':'NEW']){
      sql.exec(`CREATE TRIGGER IF NOT EXISTS cove_stage_owner_idx_subject_${verb.toLowerCase()}_${side.toLowerCase()}
        AFTER ${verb} ON cove_commercial_subject_denials BEGIN
        INSERT OR IGNORE INTO cove_stage_owner_dirty(product_id)
        SELECT product_id FROM cove_commercial_storefront_proofs
        WHERE (${side}.subject_kind='grant' AND grant_id=${side}.subject_id)
           OR (${side}.subject_kind='contract' AND contract_id=${side}.subject_id);
        END`);
    }
  }
  createStageOwnerFtsSchema(sql);
}

function changeFacet(sql:AuthoritySql,kind:string,value:string,delta:1|-1){
  const [territory,currency]=[DEFAULT.territory,DEFAULT.currency];
  if(delta===1){
    sql.exec(`INSERT INTO cove_stage_owner_index_facet_counts(
      territory,currency,kind,value,amount) VALUES(?,?,?,?,1)
      ON CONFLICT(territory,currency,kind,value) DO UPDATE SET amount=amount+1`,
      territory,currency,kind,value);
  }else{
    const old=sql.exec<{amount:number}>(`SELECT amount FROM cove_stage_owner_index_facet_counts
      WHERE territory=? AND currency=? AND kind=? AND value=?`,
      territory,currency,kind,value).toArray()[0];
    if(!old||old.amount<=0)throw Error('stage_owner_index_invalid_counter');
    if(old.amount===1)sql.exec(`DELETE FROM cove_stage_owner_index_facet_counts
      WHERE territory=? AND currency=? AND kind=? AND value=?`,territory,currency,kind,value);
    else sql.exec(`UPDATE cove_stage_owner_index_facet_counts SET amount=amount-1
      WHERE territory=? AND currency=? AND kind=? AND value=?`,territory,currency,kind,value);
  }
}
function updateTotal(sql:AuthoritySql,delta:1|-1){
  sql.exec(`INSERT OR IGNORE INTO cove_stage_owner_index_totals(territory,currency,amount)
    VALUES(?,?,0)`,DEFAULT.territory,DEFAULT.currency);
  const total=sql.exec<{amount:number}>(`SELECT amount FROM cove_stage_owner_index_totals
    WHERE territory=? AND currency=?`,DEFAULT.territory,DEFAULT.currency).toArray()[0]?.amount;
  if(!Number.isSafeInteger(total)||(total as number)+delta<0)
    throw Error('stage_owner_index_invalid_total');
  sql.exec(`UPDATE cove_stage_owner_index_totals SET amount=amount+?
    WHERE territory=? AND currency=?`,delta,DEFAULT.territory,DEFAULT.currency);
}
function removeProduct(sql:AuthoritySql,id:string){
  const rows=sql.exec<{kind:string;value:string}>(`SELECT kind,value FROM
    cove_stage_owner_index_dimensions WHERE territory=? AND currency=? AND product_id=?`,
    DEFAULT.territory,DEFAULT.currency,id).toArray();
  for(const row of rows)changeFacet(sql,row.kind,row.value,-1);
  sql.exec(`DELETE FROM cove_stage_owner_index_dimensions
    WHERE territory=? AND currency=? AND product_id=?`,DEFAULT.territory,DEFAULT.currency,id);
  const old=sql.exec<{product_id:string}>(`SELECT product_id FROM
    cove_stage_owner_index_items WHERE territory=? AND currency=? AND product_id=?`,
    DEFAULT.territory,DEFAULT.currency,id).toArray()[0];
  if(old){
    sql.exec(`DELETE FROM cove_stage_owner_index_items
      WHERE territory=? AND currency=? AND product_id=?`,DEFAULT.territory,DEFAULT.currency,id);
    updateTotal(sql,-1);
  }else if(rows.length)throw Error('stage_owner_index_orphaned_facets');
}
function addProduct(sql:AuthoritySql,id:string,offerJson:string,expiresAt:string){
  const meta=sql.exec<{title:string;rank_score:number;format:string;publisher:string}>(
    `SELECT title,rank_score,format,publisher FROM cove_stage_owner_catalog
    WHERE product_id=?`,id).toArray()[0];
  if(!meta)return; // Metadata without canonical positive owner permission cannot appear.
  const price=JSON.parse(offerJson)?.amountMinor;
  if(!Number.isSafeInteger(price)||price<0)
    throw Error('stage_owner_index_invalid_verified_offer');
  sql.exec(`INSERT INTO cove_stage_owner_index_items(
    product_id,territory,currency,title,rank_score,format,publisher,price_minor,expires_at
    ) VALUES(?,?,?,?,?,?,?,?,?)`,id,DEFAULT.territory,DEFAULT.currency,meta.title,
    meta.rank_score,meta.format,meta.publisher,price,expiresAt);
  updateTotal(sql,1);
  const keys:[string,string][]=[['formats',meta.format],['publishers',meta.publisher],
    ['availability','available']];
  for(const kind of ['category','language','series'] as const){
    const rows=sql.exec<{value:string}>(`SELECT value FROM cove_stage_owner_catalog_${kind}
      WHERE product_id=?`,id).toArray();
    const normalized=kind==='category'?'categories':kind==='language'?'languages':'series';
    for(const row of rows)keys.push([normalized,row.value]);
  }
  for(const [kind,value] of keys){
    sql.exec(`INSERT INTO cove_stage_owner_index_dimensions(
      product_id,territory,currency,kind,value) VALUES(?,?,?,?,?)`,id,
      DEFAULT.territory,DEFAULT.currency,kind,value);
    changeFacet(sql,kind,value,1);
  }
}

/** Call inside owner transactionSync, after actual owner writes are committed
 * to the same SQLite transaction but BEFORE acknowledging that operation.
 * No arbitrary `allowed` boolean or offer data is accepted from the caller.
 * At most 25 dirty products per transaction step. Any remaining dirt blocks
 * every index read; a separate bounded worker can drain large grant fanouts.
 */
export function reconcileStageOwnerDirty(sql:AuthoritySql,limit=25){
  if(!Number.isSafeInteger(limit)||limit<1||limit>25)
    throw Error('stage_owner_index_invalid_batch');
  const dirty=sql.exec<{product_id:string}>(`SELECT product_id FROM
    cove_stage_owner_dirty ORDER BY product_id LIMIT ?`,limit).toArray();
  const ids=dirty.map(x=>x.product_id);
  if(ids.some(x=>!GOOD_ID.test(x)))throw Error('stage_owner_index_invalid_dirty_product');
  const freeIds=ids.filter(x=>x.startsWith('prd_gutenberg_'));
  const paidIds=ids.filter(x=>!x.startsWith('prd_gutenberg_'));
  const free=new Map(readAuthorizedPresentations(sql,freeIds,DEFAULT.territory,DEFAULT.currency)
    .map(x=>[x.product_id,x.offer_json]));
  const paid=new Map(readCommercialStorefront(sql,paidIds,DEFAULT.territory,DEFAULT.currency)
    .map(x=>[x.product_id,x.offer_json]));
  for(const id of ids){
    removeProduct(sql,id);
    if(!marketIsWithdrawn(sql,DEFAULT.territory)){
      if(free.has(id))addProduct(sql,id,free.get(id)!, '9999-12-31T23:59:59.999Z');
      else if(paid.has(id)){
        const exp=sql.exec<{valid_until:string}>(`SELECT MIN(p.valid_until,legal.valid_until) valid_until
          FROM cove_commercial_storefront_proofs p
          JOIN cove_commercial_scope_proofs legal ON legal.product_id=p.product_id
            AND legal.territory=p.territory AND legal.channel='retail'
            AND legal.epoch=p.rights_epoch
          WHERE p.product_id=? AND p.territory=? AND p.currency=?`,
          id,DEFAULT.territory,DEFAULT.currency).toArray()[0]?.valid_until;
        if(!exp||Date.parse(exp)<=Date.now())throw Error('stage_owner_index_paid_lease_unverified');
        addProduct(sql,id,paid.get(id)!,exp);
      }
    }
    sql.exec('DELETE FROM cove_stage_owner_dirty WHERE product_id=?',id);
  }
  const remaining=sql.exec<{n:number}>(`SELECT COUNT(*) n FROM cove_stage_owner_dirty`).toArray()[0]?.n;
  return {processed:ids.length,remaining:remaining??0};
}
/**
 * Refresh ONLY owner-local paid leases that have actually expired. The
 * expiry covering index bounds the scan; real authorization is recalculated
 * through readCommercialStorefront(), not guessed from the cached offer.
 *
 * A caller MUST invoke this inside the owner Durable Object transactionSync
 * before returning a page, count or facet. If the current lease population
 * cannot be reconciled, the unchanged public read guard will fail closed.
 * Never extend a lease here: future positives require a new canonical proof.
 */
export function refreshStageOwnerExpired(sql:AuthoritySql,limit=25){
  if(!Number.isSafeInteger(limit)||limit<1||limit>25)
    throw Error('stage_owner_index_invalid_expiry_batch');
  const now=new Date().toISOString();
  const expired=sql.exec<{product_id:string}>(`SELECT product_id FROM
    cove_stage_owner_index_items INDEXED BY cove_stage_owner_index_expiry
    WHERE territory=? AND currency=? AND expires_at<=?
    ORDER BY expires_at,product_id LIMIT ?`,
    DEFAULT.territory,DEFAULT.currency,now,limit).toArray();
  if(!expired.length)return {processed:0,remaining:0};
  for(const row of expired){
    if(!GOOD_ID.test(row.product_id))throw Error('stage_owner_index_invalid_expired_product');
    sql.exec('INSERT OR IGNORE INTO cove_stage_owner_dirty(product_id) VALUES(?)',row.product_id);
  }
  // The genuine owner SQL reader rejects expired paid leases. Every removed
  // product decrements its own dimensions, aggregate counts and index epoch.
  return reconcileStageOwnerDirty(sql,limit);
}
/** Stage bootstrapping must start from complete, verified authoritative owner
 * metadata/proofs. Call once inside owner transaction, after backfilling the
 * whole population. Never mark ready with a partial migration. */
export function bootstrapStageOwnerIndex(sql:AuthoritySql){
  const ready=sql.exec<{bootstrapped:number}>(
    'SELECT bootstrapped FROM cove_stage_owner_index_state WHERE id=1').toArray()[0];
  if(!ready||ready.bootstrapped!==0)throw Error('stage_owner_index_already_bootstrapped');
  sql.exec(`INSERT OR IGNORE INTO cove_stage_owner_dirty(product_id)
    SELECT product_id FROM cove_stage_owner_catalog`);
  let loops=0;
  while(true){
    const result=reconcileStageOwnerDirty(sql);
    if(result.remaining===0)break;
    if(++loops>20_000)throw Error('stage_owner_index_unbounded_bootstrap');
  }
  // A partially migrated FTS table must never look like a complete index.
  sealStageOwnerFts(sql);
  sql.exec('UPDATE cove_stage_owner_index_state SET bootstrapped=1 WHERE id=1');
}

/** The exact minimal synchronous owner guard. Avoid serializing a page,
 * aggregates or facets merely to prove the owner-index bitmap is current.
 * This is stage-only and deliberately never treats a presentation as a grant.
 */
export function guardStageOwnerIndexRead(sql:AuthoritySql,scope:{
  territory:string;currency:string;
}){
  if(!scope||scope.territory!==DEFAULT.territory||
    scope.currency!==DEFAULT.currency)
    throw Error('stage_owner_index_unreviewed_scope');
  const ready=sql.exec<{bootstrapped:number}>(
    'SELECT bootstrapped FROM cove_stage_owner_index_state WHERE id=1').toArray()[0];
  if(!ready||ready.bootstrapped!==1)throw Error('stage_owner_index_uninitialized');
  if(sql.exec('SELECT product_id FROM cove_stage_owner_dirty LIMIT 1').toArray().length)
    throw Error('stage_owner_index_dirty_unreconciled');
  // Market tombstone is a synchronous owner-local veto even when no index
  // item, bitmap bit or price changes; never consult stale positive snapshots.
  const withdrawn=marketIsWithdrawn(sql,scope.territory);
  if(!withdrawn){
    const now=new Date().toISOString();
    const expired=sql.exec(`SELECT product_id FROM cove_stage_owner_index_items
      WHERE territory=? AND currency=? AND expires_at<=? LIMIT 1`,
      scope.territory,scope.currency,now).toArray();
    if(expired.length)throw Error('stage_owner_index_expired_unreconciled');
  }
  const epoch=sql.exec<{epoch:number}>(
    'SELECT epoch FROM cove_stage_owner_index_epoch WHERE id=1').toArray()[0]?.epoch;
  if(!Number.isSafeInteger(epoch)||epoch<0)
    throw Error('stage_owner_index_invalid_epoch');
  const count=withdrawn?0:(sql.exec<{amount:number}>(`SELECT amount FROM
    cove_stage_owner_index_totals WHERE territory=? AND currency=?`,
    scope.territory,scope.currency).toArray()[0]?.amount??0);
  if(!Number.isSafeInteger(count)||count<0)
    throw Error('stage_owner_index_invalid_count');
  return {withdrawn,count,epoch};
}

export function readStageOwnerIncrementalIndex(sql:AuthoritySql,scope:{
  territory:string;currency:string;sort:string;page:number;limit:number;query?:string;
}){
  if(!scope||scope.territory!==DEFAULT.territory||scope.currency!==DEFAULT.currency||
    scope.sort!==DEFAULT.sort||!Number.isSafeInteger(scope.page)||scope.page<1||
    scope.page>500||!Number.isSafeInteger(scope.limit)||scope.limit<1||scope.limit>25||
    (scope.query!==undefined&&scope.query!=='')||Object.keys(scope).some(x=>
      !['territory','currency','sort','page','limit','query'].includes(x)))
    throw Error('stage_owner_index_unreviewed_scope');
  const current=guardStageOwnerIndexRead(sql,scope);
  if(current.withdrawn)return {
    count:0,pageIds:[],facets:{categories:[],languages:[],formats:[],
      publishers:[],series:[],availability:[],price:null},releaseCertified:false as const,
  };
  const count=current.count;
  const pageIds=sql.exec<{product_id:string}>(`SELECT product_id FROM cove_stage_owner_index_items
    WHERE territory=? AND currency=? ORDER BY rank_score DESC,product_id LIMIT ? OFFSET ?`,
    scope.territory,scope.currency,scope.limit,(scope.page-1)*scope.limit).toArray()
    .map(x=>x.product_id);
  const facets={} as Record<typeof KINDS[number],Array<{value:string;count:number}>>;
  for(const kind of KINDS){
    facets[kind]=sql.exec<{value:string;amount:number}>(`SELECT value,amount FROM
      cove_stage_owner_index_facet_counts
      WHERE territory=? AND currency=? AND kind=?
      ORDER BY amount DESC,value LIMIT ?`,scope.territory,scope.currency,kind,CAPS[kind])
      .toArray().map(x=>({value:x.value,count:x.amount}));
  }
  const prices=sql.exec<{min_price:number|null;max_price:number|null}>(
    `SELECT (SELECT price_minor FROM cove_stage_owner_index_items
       WHERE territory=? AND currency=? ORDER BY price_minor ASC LIMIT 1) min_price,
      (SELECT price_minor FROM cove_stage_owner_index_items
       WHERE territory=? AND currency=? ORDER BY price_minor DESC LIMIT 1) max_price`,
    scope.territory,scope.currency,scope.territory,scope.currency).toArray()[0];
  return {count,pageIds,facets:{...facets,price:prices?.min_price==null||prices.max_price==null?
    null:{currency:scope.currency,min:prices.min_price,max:prices.max_price}},
    releaseCertified:false as const};
}

/**
 * Indexed AUTHORITATIVE-SET filtered reference: supports five disjunctive
 * facets and price on the reviewed US/USD rank-only search scope. Each facet
 * ignores its own filter (OR within a facet, AND between facets), matching
 * the existing production catalog facet-selection contract. It never scans
 * D1's expensive retail rights view: only owner-confirmed index rows.
 *
 * This is NOT full SearchInput support: title FTS, taxonomy, date/release,
 * author, reviews, other sorts/territories, subscriptions and user-specific
 * filters MUST be added and differential-tested before any production use.
 */
const FILTER_FIELDS=['categories','languages','formats','publishers','series'] as const;
type FilterField=typeof FILTER_FIELDS[number];
type FilteredInput={territory:string;currency:string;sort:string;page:number;limit:number;
  query?:string;categories?:string[];languages?:string[];formats?:string[];
  publishers?:string[];series?:string[];minPrice?:number;maxPrice?:number};
function validatedFilters(input:FilteredInput){
  const allowed=new Set(['territory','currency','sort','page','limit','query',
    ...FILTER_FIELDS,'minPrice','maxPrice']);
  if(!input||Object.keys(input).some(k=>!allowed.has(k)))
    throw Error('stage_owner_filtered_unreviewed_scope');
  stageOwnerLiteralFtsExpression(input.query);
  const filters={} as Record<FilterField,string[]>;
  for(const field of FILTER_FIELDS){
    const raw=input[field]??[];
    if(!Array.isArray(raw)||raw.length>12||raw.some(v=>
      typeof v!=='string'||v.length<1||v.length>160))
      throw Error('stage_owner_filtered_invalid_facet');
    filters[field]=[...new Set(raw)].sort();
  }
  for(const price of ['minPrice','maxPrice'] as const){
    const value=input[price];
    if(value!==undefined&&(!Number.isSafeInteger(value)||value<0||value>1_000_000_000))
      throw Error('stage_owner_filtered_invalid_price');
  }
  if(input.minPrice!==undefined&&input.maxPrice!==undefined&&
    input.minPrice>input.maxPrice)throw Error('stage_owner_filtered_inverted_price');
  return filters;
}
function scopedIndexWhere(input:FilteredInput,filters:Record<FilterField,string[]>,
  omit?:FilterField|'price',skipFts=false){
  const parts=['i.territory=?','i.currency=?'];
  const args:(string|number)[]=[input.territory,input.currency];
  const fts=stageOwnerLiteralFtsExpression(input.query);
  if(fts&&!skipFts){
    parts.push(`i.product_id IN (SELECT product_id FROM cove_stage_owner_fts
      WHERE cove_stage_owner_fts MATCH ?)`);
    args.push(fts);
  }
  for(const kind of FILTER_FIELDS){
    if(kind===omit||!filters[kind].length)continue;
    const values=filters[kind];
    parts.push(`EXISTS(SELECT 1 FROM cove_stage_owner_index_dimensions dim
      WHERE dim.territory=i.territory AND dim.currency=i.currency
        AND dim.product_id=i.product_id AND dim.kind=?
        AND dim.value IN (${values.map(()=>'?').join(',')}))`);
    args.push(kind,...values);
  }
  if(omit!=='price'){
    if(input.minPrice!==undefined){parts.push('i.price_minor>=?');args.push(input.minPrice);}
    if(input.maxPrice!==undefined){parts.push('i.price_minor<=?');args.push(input.maxPrice);}
  }
  return {clause:parts.join(' AND '),args};
}
/** Stage-only cost-based SELECT driver. Never changes the owner decision: every
 * row still comes from the already authorized, expiry/dirty/market-guarded
 * cove_stage_owner_index_items, with identical disjunctive predicates.
 * Each facet excludes its own input before choosing a seed.
 */
function selectiveOwnerFilteredScan(sql:AuthoritySql,input:FilteredInput,
  filters:Record<FilterField,string[]>,omit?:FilterField|'price'){
  const fts=stageOwnerLiteralFtsExpression(input.query);
  if(fts&&stageOwnerFtsPreferMatchesFirst(sql,fts)){
    const predicate=scopedIndexWhere(input,filters,omit,true);
    return {from:`(SELECT product_id FROM cove_stage_owner_fts
        WHERE cove_stage_owner_fts MATCH ?) seed
        CROSS JOIN cove_stage_owner_index_items i`,
      clause:`i.product_id=seed.product_id AND ${predicate.clause}`,
      args:[fts,...predicate.args]};
  }
  let best:{field:FilterField;values:string[];n:number}|null=null;
  for(const field of FILTER_FIELDS){
    if(omit===field||!filters[field].length)continue;
    const values=filters[field];
    const count=sql.exec<{n:number}>(`SELECT COUNT(*) n
      FROM cove_stage_owner_index_dimensions
      INDEXED BY cove_stage_owner_index_dimension_inverted
      WHERE territory=? AND currency=? AND kind=?
        AND value IN (${values.map(()=>'?').join(',')})`,
      input.territory,input.currency,field,...values).toArray()[0]?.n;
    if(!Number.isSafeInteger(count)||count<0)
      throw Error('stage_owner_filtered_invalid_posting_count');
    if(!best||count<best.n)best={field,values,n:count};
  }
  const predicate=scopedIndexWhere(input,filters,omit);
  if(best&&best.n<=4096){
    return {from:`(SELECT DISTINCT product_id
        FROM cove_stage_owner_index_dimensions
        INDEXED BY cove_stage_owner_index_dimension_inverted
        WHERE territory=? AND currency=? AND kind=?
          AND value IN (${best.values.map(()=>'?').join(',')})) seed
        CROSS JOIN cove_stage_owner_index_items i`,
      clause:`i.product_id=seed.product_id AND ${predicate.clause}`,
      args:[input.territory,input.currency,best.field,
        ...best.values,...predicate.args]};
  }
  return {from:'cove_stage_owner_index_items i',
    clause:predicate.clause,args:predicate.args};
}
export function readStageOwnerFilteredIndex(sql:AuthoritySql,input:FilteredInput){
  const filters=validatedFilters(input);
  const ftsExpression=stageOwnerLiteralFtsExpression(input.query);
  const bare={territory:input.territory,currency:input.currency,sort:input.sort,
    page:input.page,limit:input.limit,query:''};
  // The default path verifies initialization, dirty queue, lease freshness
  // and market tombstone before any facet or page read is allowed.
  const defaultPage=readStageOwnerIncrementalIndex(sql,bare);
  if(ftsExpression)assertStageOwnerFtsReady(sql);
  // Exact (not estimated) all-documents FTS coverage: a ubiquitous term
  // does not change the eligible population, even after source/contract
  // withdrawal. Do not use this unless the index passed legal/expiry fences.
  const universalFts=!!ftsExpression &&
    stageOwnerFtsCoversAll(sql,ftsExpression,defaultPage.count);
  if(defaultPage.count===0 ||
    ((!ftsExpression||universalFts)&&FILTER_FIELDS.every(x=>!filters[x].length)&&
      input.minPrice===undefined&&input.maxPrice===undefined))return defaultPage;
  const scopedInput=universalFts?{...input,query:''}:input;
  const epoch=sql.exec<{epoch:number}>(
    'SELECT epoch FROM cove_stage_owner_index_epoch WHERE id=1').toArray()[0]?.epoch;
  if(!Number.isSafeInteger(epoch))throw Error('stage_owner_filter_cache_unfenced');
  const cacheKey=JSON.stringify([input.territory,input.currency,input.sort,input.page,
    input.limit,ftsExpression,FILTER_FIELDS.map(f=>filters[f]),
    input.minPrice??null,input.maxPrice??null]);
  const now=new Date().toISOString();
  const hit=sql.exec<{body:string}>(`SELECT body FROM cove_stage_owner_index_query_cache
    WHERE scope_key=? AND epoch=? AND expires_at>?`,cacheKey,epoch!,now).toArray()[0];
  if(hit){
    const parsed=JSON.parse(hit.body);
    if(parsed?.releaseCertified!==false||!Number.isSafeInteger(parsed.count)||
      !Array.isArray(parsed.pageIds)||!parsed.facets)
      throw Error('stage_owner_filter_cache_corrupt');
    return parsed as ReturnType<typeof readStageOwnerIncrementalIndex>;
  }
  const countScan=selectiveOwnerFilteredScan(sql,scopedInput,filters);
  const count=sql.exec<{total:number}>(`SELECT COUNT(*) total FROM
    ${countScan.from} WHERE ${countScan.clause}`,...countScan.args).toArray()[0]?.total;
  if(!Number.isSafeInteger(count))throw Error('stage_owner_filtered_invalid_count');
  // FTS5 inverted-list cardinality, not total product count, chooses the
  // plan. A narrow match MUST lead the join: SQLite can otherwise iterate
  // thousands of ranked rows to find one matching document. CROSS JOIN
  // fixes the order; rank-index-first remains faster for broad keywords.
  const matchFirst=!!ftsExpression&&!universalFts &&
    stageOwnerFtsPreferMatchesFirst(sql,ftsExpression);
  const pageIds=matchFirst?(()=>{
    const narrowed=scopedIndexWhere(scopedInput,filters,undefined,true);
    return sql.exec<{product_id:string}>(`WITH matched AS MATERIALIZED (
      SELECT product_id FROM cove_stage_owner_fts
      WHERE cove_stage_owner_fts MATCH ?
    ) SELECT i.product_id FROM matched m
      CROSS JOIN cove_stage_owner_index_items i
      WHERE i.product_id=m.product_id AND ${narrowed.clause}
      ORDER BY i.rank_score DESC,i.product_id ASC LIMIT ? OFFSET ?`,
      ftsExpression,...narrowed.args,input.limit,(input.page-1)*input.limit)
      .toArray().map(x=>x.product_id);
  })():(()=>{
    const pageScan=selectiveOwnerFilteredScan(sql,scopedInput,filters);
    return sql.exec<{product_id:string}>(`SELECT i.product_id FROM
      ${pageScan.from} WHERE ${pageScan.clause}
      ORDER BY i.rank_score DESC,i.product_id ASC LIMIT ? OFFSET ?`,
      ...pageScan.args,input.limit,(input.page-1)*input.limit)
      .toArray().map(x=>x.product_id);
  })();
  const facets={} as Record<FilterField,Array<{value:string;count:number}>>;
  for(const kind of FILTER_FIELDS){
    const facetScan=selectiveOwnerFilteredScan(sql,scopedInput,filters,kind);
    const rows=sql.exec<{value:string;num:number}>(`SELECT dim.value value,
      COUNT(DISTINCT i.product_id) num FROM ${facetScan.from}
      JOIN cove_stage_owner_index_dimensions dim ON
        dim.territory=i.territory AND dim.currency=i.currency
        AND dim.product_id=i.product_id
      WHERE ${facetScan.clause} AND dim.kind=?
      GROUP BY dim.value ORDER BY num DESC,dim.value ASC LIMIT ?`,
      ...facetScan.args,kind,CAPS[kind]).toArray();
    facets[kind]=rows.map(x=>({value:x.value,count:x.num}));
  }
  const priceScan=selectiveOwnerFilteredScan(sql,scopedInput,filters,'price');
  const price=sql.exec<{minimum:number|null;maximum:number|null}>(`SELECT
    MIN(i.price_minor) minimum,MAX(i.price_minor) maximum FROM
    ${priceScan.from} WHERE ${priceScan.clause}`,
    ...priceScan.args).toArray()[0];
  const result={count,pageIds,facets:{...facets,
    availability:count?[{value:'available',count}]:[],
    price:price?.minimum==null||price.maximum==null?null:
      {currency:input.currency,min:price.minimum,max:price.maximum}},
    releaseCertified:false as const};
  // Cache writes do not grant any legal state: the calculation was checked
  // against the owner-local index above, without async or a database replica.
  // Readers verify dirty state, market and expiry BEFORE consulting this row.
  sql.exec(`INSERT INTO cove_stage_owner_index_query_cache(
    scope_key,epoch,expires_at,body) VALUES(?,?,?,?)
    ON CONFLICT(scope_key) DO UPDATE SET epoch=excluded.epoch,
    expires_at=excluded.expires_at,body=excluded.body`,
    cacheKey,epoch!,new Date(Date.now()+30_000).toISOString(),JSON.stringify(result));
  sql.exec(`DELETE FROM cove_stage_owner_index_query_cache
    WHERE epoch<>? OR expires_at<=?`,epoch!,now);
  return result;
}