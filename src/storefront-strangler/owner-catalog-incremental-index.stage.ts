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
  sql.exec('UPDATE cove_stage_owner_index_state SET bootstrapped=1 WHERE id=1');
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
  const ready=sql.exec<{bootstrapped:number}>(
    'SELECT bootstrapped FROM cove_stage_owner_index_state WHERE id=1').toArray()[0];
  if(!ready||ready.bootstrapped!==1)throw Error('stage_owner_index_uninitialized');
  if(sql.exec('SELECT product_id FROM cove_stage_owner_dirty LIMIT 1').toArray().length)
    throw Error('stage_owner_index_dirty_unreconciled');
  // O(1) mandatory market veto; a global withdrawal never requires an 82k
  // product fanout and never waits for cached counts to be refreshed.
  if(marketIsWithdrawn(sql,scope.territory))return {
    count:0,pageIds:[],facets:{categories:[],languages:[],formats:[],
      publishers:[],series:[],availability:[],price:null},releaseCertified:false as const,
  };
  const now=new Date().toISOString();
  const expired=sql.exec(`SELECT product_id FROM cove_stage_owner_index_items
    WHERE territory=? AND currency=? AND expires_at<=? LIMIT 1`,
    scope.territory,scope.currency,now).toArray();
  if(expired.length)throw Error('stage_owner_index_expired_unreconciled');
  const count=sql.exec<{amount:number}>(`SELECT amount FROM cove_stage_owner_index_totals
    WHERE territory=? AND currency=?`,scope.territory,scope.currency).toArray()[0]?.amount??0;
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