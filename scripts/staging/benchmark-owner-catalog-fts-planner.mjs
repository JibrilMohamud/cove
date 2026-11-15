/* eslint-disable prettier/prettier -- Read-only benchmark of synthetic owner-local FTS5 mechanics. */
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {performance} from 'node:perf_hooks';

/**
 * RESEARCH ONLY: 82,249 synthetic index rows, no primary D1, no legal proof,
 * no Cloudflare Worker, no real customer queries, no rights certification.
 * A successful result must NEVER be substituted for production latency gates.
 */
const PRODUCTS=82_249, PAGE_SIZE=24;
const db=new DatabaseSync(':memory:');
const millis=()=>performance.now();
const round=x=>Math.round(x*100)/100;
const percentile=(a,p)=>{const s=[...a].sort((x,y)=>x-y);return round(s[Math.ceil(p*s.length)-1]);};
const timed=(stmt,args=[],warmup=0,trials=1)=>{
  for(let j=0;j<warmup;j++)stmt.all(...args);
  const durations=[];
  let rows=[];
  for(let j=0;j<trials;j++){
    const begin=millis();rows=stmt.all(...args);durations.push(millis()-begin);
  }
  return {rows, p50:percentile(durations,.5),p95:percentile(durations,.95),
    p99:percentile(durations,.99),max:percentile(durations,1),min:round(Math.min(...durations))};
};
const output={schema:'cove.synthetic-owner-fts5-benchmark.v1',
  legalAuthorizationVerified:false,hostedCloudflare:false,releaseCertified:false,
  products:PRODUCTS,clock:'performance.now',sqliteVersion:db.prepare('SELECT sqlite_version() AS v').get().v,
  cases:[]};
try {
  db.exec(`PRAGMA synchronous=OFF;
    PRAGMA journal_mode=MEMORY;
    CREATE TABLE cove_stage_owner_index_items(
      product_id TEXT NOT NULL, territory TEXT NOT NULL, currency TEXT NOT NULL,
      title TEXT NOT NULL, rank_score INTEGER NOT NULL, format TEXT NOT NULL,
      publisher TEXT NOT NULL, price_minor INTEGER NOT NULL,
      expires_at TEXT NOT NULL,
      PRIMARY KEY(territory,currency,product_id)) WITHOUT ROWID;
    CREATE INDEX cove_stage_owner_index_rank ON cove_stage_owner_index_items(
      territory,currency,rank_score DESC,product_id);
    CREATE INDEX cove_stage_owner_index_price ON cove_stage_owner_index_items(
      territory,currency,price_minor);
    CREATE TABLE cove_stage_owner_index_dimensions(
      product_id TEXT NOT NULL,territory TEXT NOT NULL,currency TEXT NOT NULL,
      kind TEXT NOT NULL,value TEXT NOT NULL,
      PRIMARY KEY(territory,currency,product_id,kind,value)) WITHOUT ROWID;
    CREATE TABLE cove_stage_owner_fts_ids(
      fts_rowid INTEGER PRIMARY KEY AUTOINCREMENT,product_id TEXT NOT NULL UNIQUE);
    CREATE VIRTUAL TABLE cove_stage_owner_fts USING fts5(
      product_id UNINDEXED,title,publisher,format,tokenize='unicode61');
    CREATE VIRTUAL TABLE cove_stage_owner_fts_vocab
      USING fts5vocab(cove_stage_owner_fts,'row');
    CREATE TRIGGER cove_stage_owner_fts_insert AFTER INSERT
      ON cove_stage_owner_index_items BEGIN
      INSERT INTO cove_stage_owner_fts_ids(product_id) VALUES(NEW.product_id);
      INSERT INTO cove_stage_owner_fts(rowid,product_id,title,publisher,format)
        VALUES((SELECT fts_rowid FROM cove_stage_owner_fts_ids
          WHERE product_id=NEW.product_id),NEW.product_id,NEW.title,NEW.publisher,NEW.format);
    END;
    CREATE TRIGGER cove_stage_owner_fts_delete AFTER DELETE
      ON cove_stage_owner_index_items BEGIN
      DELETE FROM cove_stage_owner_fts WHERE rowid=(SELECT fts_rowid
        FROM cove_stage_owner_fts_ids WHERE product_id=OLD.product_id);
      DELETE FROM cove_stage_owner_fts_ids WHERE product_id=OLD.product_id;
    END;`);
  const insert=db.prepare(`INSERT INTO cove_stage_owner_index_items
    (product_id,territory,currency,title,rank_score,format,publisher,price_minor,expires_at)
    VALUES(?,'US','USD',?,?,?,?,?,'9999-12-31T23:59:59.999Z')`);
  const insertDimension=db.prepare(`INSERT INTO cove_stage_owner_index_dimensions
    (product_id,territory,currency,kind,value) VALUES(?,'US','USD',?,?)`);
  const seedStarted=millis();
  db.exec('BEGIN IMMEDIATE');
  try {
    for(let i=0;i<PRODUCTS;i++){
      const id='prd_fixture_'+String(i).padStart(6,'0');
      // Common, medium-cardinality, and unique terms are deliberate.
      const title=`Book ${i} coveTopic${i%31} coveShard${i%4096} uniqueWord${i}`;
      const publisher='Publisher'+i%80;
      const format=i%4===0?'audio':'ebook';
      insert.run(id,title,PRODUCTS-i,format,publisher,(i%25)*100);
      insertDimension.run(id,'categories','Category'+i%24);
      insertDimension.run(id,'languages',i%3===0?'fr':'en');
    }
    db.exec('COMMIT');
  } catch(e){db.exec('ROLLBACK');throw e;}
  output.seedMs=round(millis()-seedStarted);
  const counts=db.prepare(`SELECT
    (SELECT COUNT(*) FROM cove_stage_owner_index_items) indexRows,
    (SELECT COUNT(*) FROM cove_stage_owner_fts) ftsRows,
    (SELECT COUNT(*) FROM cove_stage_owner_fts_ids) mappedRows`).get();
  assert.deepEqual({...counts},{indexRows:PRODUCTS,ftsRows:PRODUCTS,mappedRows:PRODUCTS});
  output.seedCounts={...counts};
  const queryPage=db.prepare(`SELECT i.product_id FROM cove_stage_owner_index_items i
    WHERE i.territory='US' AND i.currency='USD' AND
      i.product_id IN (SELECT product_id FROM cove_stage_owner_fts
        WHERE cove_stage_owner_fts MATCH ?)
    ORDER BY i.rank_score DESC,i.product_id LIMIT ${PAGE_SIZE}`);
  const queryCount=db.prepare(`SELECT COUNT(*) AS n FROM cove_stage_owner_index_items i
    WHERE i.territory='US' AND i.currency='USD' AND
      i.product_id IN (SELECT product_id FROM cove_stage_owner_fts
        WHERE cove_stage_owner_fts MATCH ?)`);
  const queryFacet=db.prepare(`SELECT d.value,COUNT(DISTINCT i.product_id) AS n
    FROM cove_stage_owner_index_items i
    JOIN cove_stage_owner_index_dimensions d ON d.product_id=i.product_id
      AND d.territory=i.territory AND d.currency=i.currency AND d.kind='categories'
    WHERE i.territory='US' AND i.currency='USD' AND
      i.product_id IN (SELECT product_id FROM cove_stage_owner_fts
        WHERE cove_stage_owner_fts MATCH ?)
    GROUP BY d.value ORDER BY n DESC,d.value LIMIT 24`);
  const searchPlans=db.prepare(`EXPLAIN QUERY PLAN SELECT product_id FROM cove_stage_owner_fts
    WHERE cove_stage_owner_fts MATCH ?`).all('"covetopic0"');
  output.ftsPlan=searchPlans.map(x=>x.detail);
  assert.ok(output.ftsPlan.some(x=>/VIRTUAL TABLE INDEX/.test(x)),'Must use FTS5 inverted index');
  const cases=[
    {name:'unique-single-book',query:'"uniqueword12345"',count:1,trials:200},
    {name:'sparse-shard-20-books',query:'"coveshard77"',count:21,trials:120},
    {name:'medium-topic-2654-books',query:'"covetopic0"',count:2654,trials:40},
    {name:'common-book-82249-books',query:'"book"',count:PRODUCTS,trials:8},
    {name:'two-term-AND',query:'"covetopic0" AND "ebook"',count:null,trials:40},
    {name:'empty-match',query:'"notpartofcatalog"',count:0,trials:160},
  ];
  for(const c of cases){
    const count=queryCount.get(c.query).n;
    if(c.count!==null)assert.equal(count,c.count,'FTS count '+c.name);
    const page=timed(queryPage,[c.query],2,c.trials);
    const cnt=timed(queryCount,[c.query],2,Math.max(4,Math.min(c.trials,50)));
    const fac=timed(queryFacet,[c.query],1,Math.max(3,Math.min(c.trials,20)));
    assert.ok(page.rows.length<=PAGE_SIZE);
    assert.equal(fac.rows.reduce((s,x)=>s+x.n,0),count,'single-category facet must equal count');
    output.cases.push({name:c.name,matches:count,trials:c.trials,
      page:{p50:page.p50,p95:page.p95,max:page.max},
      count:{p50:cnt.p50,p95:cnt.p95,max:cnt.max},
      facet:{p50:fac.p50,p95:fac.p95,max:fac.max}});
  }
  // For sparse MATCH, a ranked-index scan can touch thousands of unrelated
  // products. Force the FTS match set first and compare exact page semantics.
  const ftsFirstPage=db.prepare(`WITH matched AS MATERIALIZED (
    SELECT product_id FROM cove_stage_owner_fts
    WHERE cove_stage_owner_fts MATCH ?
    ) SELECT i.product_id FROM matched m
    CROSS JOIN cove_stage_owner_index_items i
    WHERE i.product_id=m.product_id AND i.territory='US' AND i.currency='USD'
    ORDER BY i.rank_score DESC,i.product_id LIMIT ${PAGE_SIZE}`);
  const ftsFirstPlan=db.prepare(`EXPLAIN QUERY PLAN WITH matched AS MATERIALIZED (
    SELECT product_id FROM cove_stage_owner_fts
    WHERE cove_stage_owner_fts MATCH ?
    ) SELECT i.product_id FROM matched m
    CROSS JOIN cove_stage_owner_index_items i
    WHERE i.product_id=m.product_id AND i.territory='US' AND i.currency='USD'
    ORDER BY i.rank_score DESC,i.product_id LIMIT ${PAGE_SIZE}`).all('"covetopic0"');
  output.ftsFirstPlan=ftsFirstPlan.map(x=>x.detail);
  output.pageStrategies=[];
  for(const c of cases){
    const direct=queryPage.all(c.query).map(x=>x.product_id);
    const first=ftsFirstPage.all(c.query).map(x=>x.product_id);
    assert.deepEqual(first,direct,'Both query plans must have IDENTICAL ordered pages for '+c.name);
    const n=c.count===PRODUCTS?10:c.trials;
    const rank=timed(queryPage,[c.query],2,n);
    const matched=timed(ftsFirstPage,[c.query],2,n);
    output.pageStrategies.push({name:c.name,matches:queryCount.get(c.query).n,trials:n,
      rankFirst:{p50:rank.p50,p95:rank.p95,max:rank.max},
      ftsFirst:{p50:matched.p50,p95:matched.p95,max:matched.max}});
  }
  // The candidate owner stage chooses using the FTS5 vocabulary term doc
  // frequency. This is an upper bound for AND intersections; never a rights
  // decision, and it must return the same ordered page as either plan.
  const vocab=db.prepare('SELECT doc FROM cove_stage_owner_fts_vocab WHERE term=?');
  const preferMatched=query=>Math.min(...[...query.matchAll(/"([^"]+)"/g)]
    .map(match=>vocab.get(match[1])?.doc??0))<=128;
  output.selectedPlans=[];
  for(const c of cases){
    const first=preferMatched(c.query);
    const expected=c.name==='unique-single-book'||c.name==='sparse-shard-20-books'||
      c.name==='empty-match';
    assert.equal(first,expected,'Owner FTS5 planner should prefer matches-first only when narrow');
    const selected=first?ftsFirstPage:queryPage;
    const queryRows=selected.all(c.query).map(x=>x.product_id);
    assert.deepEqual(queryRows,queryPage.all(c.query).map(x=>x.product_id));
    const stats=timed(selected,[c.query],2,c.count===PRODUCTS?10:Math.min(80,c.trials));
    output.selectedPlans.push({name:c.name,strategy:first?'fts-first':'rank-first',
      p50:stats.p50,p95:stats.p95,max:stats.max});
  }
  // An array of distinct, uncached exact-search terms measures a different
  // workload than repeatedly querying one popular (cacheable) term.
  const distinctDurations=[];
  for(let i=0;i<250;i++){
    const begin=millis();
    const term='"uniqueword'+((i*313)%PRODUCTS)+'"';
    const rows=queryPage.all(term);
    assert.equal(rows.length,1);
    distinctDurations.push(millis()-begin);
  }
  output.distinctUnique={requests:250,p50:percentile(distinctDurations,.5),
    p95:percentile(distinctDurations,.95),p99:percentile(distinctDurations,.99),
    max:percentile(distinctDurations,1)};
  const target='prd_fixture_012345';
  const unique='"uniqueword12345"';
  assert.equal(queryCount.get(unique).n,1);
  const remove=db.prepare(`DELETE FROM cove_stage_owner_index_items
    WHERE territory='US' AND currency='USD' AND product_id=?`);
  const started=millis();
  db.exec('BEGIN IMMEDIATE');
  try{remove.run(target);db.exec('COMMIT');}catch(e){db.exec('ROLLBACK');throw e;}
  output.singleRevocationMs=round(millis()-started);
  assert.equal(queryCount.get(unique).n,0,'Withdrawing owner-index row must remove FTS entry');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM cove_stage_owner_fts').get().n,PRODUCTS-1);
  output.success=true;
  console.log(JSON.stringify(output,null,2));
} finally {db.close();}