/* eslint-disable prettier/prettier -- Informational LOCAL SQLite plan benchmark only. */
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {performance} from 'node:perf_hooks';

// These are deliberately synthetic catalog rows with NO legal publication.
// Correctness is tested separately against the true owner SQL modules.
const PRODUCTS=82_249;
const db=new DatabaseSync(':memory:');
try{
  db.exec(`CREATE TABLE cove_stage_owner_index_items(
    product_id TEXT NOT NULL,territory TEXT NOT NULL,currency TEXT NOT NULL,
    title TEXT NOT NULL,rank_score INTEGER NOT NULL,format TEXT NOT NULL,
    publisher TEXT NOT NULL,price_minor INTEGER NOT NULL,expires_at TEXT NOT NULL,
    PRIMARY KEY(territory,currency,product_id)) WITHOUT ROWID;
    CREATE INDEX cove_stage_owner_index_rank ON cove_stage_owner_index_items(
      territory,currency,rank_score DESC,product_id);
    CREATE INDEX cove_stage_owner_index_price ON cove_stage_owner_index_items(
      territory,currency,price_minor);
    CREATE INDEX cove_stage_owner_index_expiry ON cove_stage_owner_index_items(
      territory,currency,expires_at);
    CREATE TABLE cove_stage_owner_index_facet_counts(
      territory TEXT,currency TEXT,kind TEXT,value TEXT,amount INTEGER,
      PRIMARY KEY(territory,currency,kind,value)) WITHOUT ROWID;
    CREATE TABLE cove_stage_owner_index_totals(territory TEXT,currency TEXT,
      amount INTEGER,PRIMARY KEY(territory,currency)) WITHOUT ROWID;
    CREATE TABLE cove_stage_owner_dirty(product_id TEXT PRIMARY KEY) WITHOUT ROWID;`);
  const ins=db.prepare(`INSERT INTO cove_stage_owner_index_items(
    product_id,territory,currency,title,rank_score,format,publisher,price_minor,expires_at)
    VALUES(?,?,?,?,?,?,?,?,?)`);
  const incr=db.prepare(`INSERT INTO cove_stage_owner_index_facet_counts(
    territory,currency,kind,value,amount) VALUES('US','USD',?,?,1)
    ON CONFLICT(territory,currency,kind,value) DO UPDATE SET amount=amount+1`);
  const start=performance.now();
  db.exec('BEGIN IMMEDIATE');
  for(let n=0;n<PRODUCTS;n++){
    const id='prd_gutenberg_'+String(n+900000000);
    const format=n%4?'ebook':'audio',publisher='Stage Publisher '+(n%30);
    ins.run(id,'US','USD','Synthetic '+n,PRODUCTS-n,format,publisher,0,
      '9999-12-31T23:59:59.999Z');
    // Maintain facet counts at publication time, not per request.
    for(const [kind,value] of [['categories','Category '+(n%80)],
      ['languages',n%3?'en':'fr'],['formats',format],
      ['publishers',publisher],['series','Stage Series '+(n%200)],
      ['availability','available']])incr.run(kind,value);
  }
  db.prepare(`INSERT INTO cove_stage_owner_index_totals(territory,currency,amount)
    VALUES('US','USD',?)`).run(PRODUCTS);
  db.exec('COMMIT');
  const seedMs=performance.now()-start;
  const rank=db.prepare(`SELECT product_id FROM cove_stage_owner_index_items
    WHERE territory='US' AND currency='USD'
    ORDER BY rank_score DESC,product_id ASC LIMIT ? OFFSET ?`);
  const count=db.prepare(`SELECT amount FROM cove_stage_owner_index_totals
    WHERE territory='US' AND currency='USD'`);
  const facet=db.prepare(`SELECT value,amount FROM cove_stage_owner_index_facet_counts
    WHERE territory='US' AND currency='USD' AND kind=?
    ORDER BY amount DESC,value ASC LIMIT ?`);
  const cheapest=db.prepare(`SELECT price_minor FROM cove_stage_owner_index_items
    WHERE territory='US' AND currency='USD' ORDER BY price_minor ASC LIMIT 1`);
  const priciest=db.prepare(`SELECT price_minor FROM cove_stage_owner_index_items
    WHERE territory='US' AND currency='USD' ORDER BY price_minor DESC LIMIT 1`);
  const dirty=db.prepare(`SELECT product_id FROM cove_stage_owner_dirty LIMIT 1`);
  const expired=db.prepare(`SELECT product_id FROM cove_stage_owner_index_items
    WHERE territory='US' AND currency='USD' AND expires_at<=? LIMIT 1`);
  const plan=db.prepare(`EXPLAIN QUERY PLAN SELECT product_id FROM cove_stage_owner_index_items
    WHERE territory='US' AND currency='USD' ORDER BY rank_score DESC,product_id LIMIT 24`).all();
  assert.ok(plan.some(x=>String(x.detail).includes('COVERING INDEX cove_stage_owner_index_rank')),
    'Indexed page query must never become full-population rank sort');
  const names=['categories','languages','formats','publishers','series','availability'];
  const caps=[40,30,20,30,30,2];
  function read(page){
    assert.equal(dirty.all().length,0);
    assert.equal(expired.all(new Date().toISOString()).length,0);
    const total=count.get().amount;
    const ids=rank.all(24,(page-1)*24);
    const f=names.map((name,i)=>facet.all(name,caps[i]));
    const min=cheapest.get()?.price_minor,max=priciest.get()?.price_minor;
    assert.equal(total,PRODUCTS);
    assert.equal(ids.length,24);
    assert.equal(f[5][0].amount,PRODUCTS);
    assert.equal(min,0);assert.equal(max,0);
  }
  for(let n=0;n<10;n++)read(1);
  const durations=[];
  for(let n=0;n<400;n++){
    const t=performance.now();
    read(n%6+1);
    durations.push(performance.now()-t);
  }
  durations.sort((a,b)=>a-b);
  const pct=p=>Number(durations[Math.ceil(durations.length*p)-1].toFixed(3));
  const report={fixtureProducts:PRODUCTS,seedMs:Number(seedMs.toFixed(1)),
    localReads:durations.length,localP50Ms:pct(.5),localP95Ms:pct(.95),
    localP99Ms:pct(.99),localMaxMs:pct(1),indexedRankPlan:plan.map(x=>x.detail),
    releaseCertified:false,scope:'local SQLite index mechanism ONLY, not a hosted Worker or real owner catalog'};
  console.log(JSON.stringify(report));
}finally{db.close();}