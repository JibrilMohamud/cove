/* eslint-disable prettier/prettier -- Reproducible synthetic LOCAL FTS5 scale probe, never customer rights. */
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {build} from 'esbuild';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {performance} from 'node:perf_hooks';

const N=82_249, tmp=mkdtempSync(path.join(tmpdir(),'cove-fts82k-'));
const db=new DatabaseSync(':memory:');
const sql={exec:(query,...args)=>{
  const p=db.prepare(query);
  return {toArray:()=>/^\\s*(SELECT|WITH|PRAGMA)\\b/i.test(query)?
    p.all(...args):(p.run(...args),[])};
}};
const fmt=n=>Math.round(n*100)/100;
const percentile=(values,q)=>{
  const a=[...values].sort((x,y)=>x-y);
  return fmt(a[Math.ceil(a.length*q)-1]);
};
try{
  await build({entryPoints:['src/storefront-strangler/owner-catalog-fts.stage.ts'],
    outfile:path.join(tmp,'fts.mjs'),bundle:true,platform:'node',format:'esm',
    target:'node22',logLevel:'silent'});
  const fts=await import(pathToFileURL(path.join(tmp,'fts.mjs')).href);
  db.exec(`CREATE TABLE cove_stage_owner_index_items(
    product_id TEXT NOT NULL,territory TEXT NOT NULL,currency TEXT NOT NULL,
    title TEXT NOT NULL,rank_score INTEGER NOT NULL,format TEXT NOT NULL,
    publisher TEXT NOT NULL,price_minor INTEGER NOT NULL,expires_at TEXT NOT NULL,
    PRIMARY KEY(territory,currency,product_id)
  ) WITHOUT ROWID`);
  db.exec(`CREATE INDEX idx_cove_stage_fts_volume_rank
    ON cove_stage_owner_index_items(territory,currency,rank_score DESC,product_id)`);
  fts.createStageOwnerFtsSchema(sql);
  assert.throws(()=>fts.assertStageOwnerFtsReady(sql),/unsealed/);
  const insert=db.prepare(`INSERT INTO cove_stage_owner_index_items(
    product_id,territory,currency,title,rank_score,format,publisher,
    price_minor,expires_at) VALUES(?,?,?,?,?,?,?,?,?)`);
  const started=performance.now();
  db.exec('BEGIN IMMEDIATE');
  try{
    for(let i=0;i<N;i++){
      const id='prd_perf_'+String(i).padStart(6,'0');
      const category=i%2===0?'moonlight':'starlight';
      insert.run(id,'US','USD',
        'Cove searchable public stage volume '+i+' '+category,
        N-i,i%3===0?'ebook':'audio',i%5===0?'Stage Press':'Stage Books',
        i%2===0?0:599,'9999-12-31T23:59:59.999Z');
    }
    db.exec('COMMIT');
  }catch(e){db.exec('ROLLBACK');throw e;}
  fts.sealStageOwnerFts(sql);
  fts.assertStageOwnerFtsReady(sql);
  const seedMs=fmt(performance.now()-started);
  const count=db.prepare('SELECT COUNT(*) n FROM cove_stage_owner_fts').get().n;
  assert.equal(count,N);
  const query=db.prepare(`SELECT i.product_id FROM cove_stage_owner_index_items i
    WHERE i.territory='US' AND i.currency='USD'
      AND i.product_id IN (SELECT product_id FROM cove_stage_owner_fts
        WHERE cove_stage_owner_fts MATCH ?)
    ORDER BY i.rank_score DESC,i.product_id ASC LIMIT 24`);
  const lookups=[
    ['selective',fts.stageOwnerLiteralFtsExpression('710'),1],
    ['half_corpus',fts.stageOwnerLiteralFtsExpression('moonlight'),Math.ceil(N/2)],
    ['conjunctive',fts.stageOwnerLiteralFtsExpression('public starlight'),Math.floor(N/2)],
  ];
  const stats=[];
  for(const [name,expression,expectedCount] of lookups){
    const countStmt=db.prepare('SELECT COUNT(*) n FROM cove_stage_owner_fts WHERE cove_stage_owner_fts MATCH ?');
    const actual=countStmt.get(expression).n;
    assert.equal(actual,expectedCount,'Synthetic count must be exact: '+name);
    const results=[];
    for(let i=0;i<31;i++){
      const t=performance.now(),rows=query.all(expression);
      const dur=performance.now()-t;
      assert.equal(rows.length,Math.min(24,expectedCount));
      if(i>0)results.push(dur);
    }
    stats.push({query:name,matchingDocs:actual,samples:results.length,
      p50Ms:percentile(results,.5),p95Ms:percentile(results,.95),
      p99Ms:percentile(results,.99),maxMs:percentile(results,1)});
  }
  const ftsPlan=db.prepare(`EXPLAIN QUERY PLAN SELECT product_id FROM
    cove_stage_owner_fts WHERE cove_stage_owner_fts MATCH ?`)
    .all(fts.stageOwnerLiteralFtsExpression('moonlight'));
  assert.ok(ftsPlan.some(p=>/VIRTUAL TABLE INDEX/i.test(String(p.detail))),
    'FTS5 query must use virtual index');
  const removedId='prd_perf_000710';
  const mutationStart=performance.now();
  db.prepare('DELETE FROM cove_stage_owner_index_items WHERE product_id=? AND territory=? AND currency=?')
    .run(removedId,'US','USD');
  const deleteMs=fmt(performance.now()-mutationStart);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM cove_stage_owner_fts').get().n,N-1);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM cove_stage_owner_fts WHERE cove_stage_owner_fts MATCH ?')
    .get(fts.stageOwnerLiteralFtsExpression('710')).n,0,
    'Deleted authorized row must disappear from FTS in same transaction');
  console.log(JSON.stringify({event:'cove_stage_local_82k_owner_fts_mechanism',
    corpus:N,seedMs,queries:stats,singleDeleteMs:deleteMs,
    exactDelete:true,localSqlite:true,canonicalOwnerEvidence:false,
    hostedCloudflare:false,releaseCertified:false}));
}finally{db.close();rmSync(tmp,{recursive:true,force:true});}
