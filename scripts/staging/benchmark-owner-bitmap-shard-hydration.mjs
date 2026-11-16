/* eslint-disable prettier/prettier -- Ephemeral 82k synthetic cold-start mechanism benchmark. */
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {performance} from 'node:perf_hooks';
import {build} from 'esbuild';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

// NEVER production catalog, actual grants, hosted Workers, or a release gate.
// Explicit fake authorized-set fixture exists ONLY to time the exact sharded
// store's serialization, SQL persistence and cold DO-style hydration.
const PRODUCT_COUNT=82_249;
const root=mkdtempSync(path.join(tmpdir(),'cove-stage-bitmap-cold-'));
const db=new DatabaseSync(':memory:');
const sql={exec:(statement,...args)=>{
  const stmt=db.prepare(statement);
  const rows=/^\s*(SELECT|WITH|PRAGMA)\b/i.test(statement)?stmt.all(...args):
    (stmt.run(...args),[]);
  return {toArray:()=>rows};
}};
const tx=fn=>{db.exec('BEGIN IMMEDIATE');try{const result=fn();db.exec('COMMIT');return result;}
  catch(error){db.exec('ROLLBACK');throw error;}};
try{
  await build({entryPoints:['src/storefront-strangler/owner-catalog-bitmap-store.stage.ts'],
    outfile:path.join(root,'bitmap-store.mjs'),bundle:true,platform:'node',
    format:'esm',target:'node22',logLevel:'silent'});
  const store=await import(pathToFileURL(path.join(root,'bitmap-store.mjs')).href);
  db.exec(`CREATE TABLE cove_stage_owner_index_state(id INTEGER PRIMARY KEY,
    bootstrapped INTEGER NOT NULL);
    INSERT INTO cove_stage_owner_index_state VALUES(1,1);
    CREATE TABLE cove_stage_owner_dirty(product_id TEXT PRIMARY KEY);
    CREATE TABLE cove_stage_owner_bitmap_change_log(
      product_id TEXT PRIMARY KEY,
      item_deleted INTEGER NOT NULL DEFAULT 0,
      item_written INTEGER NOT NULL DEFAULT 0,
      dimension_deleted INTEGER NOT NULL DEFAULT 0,
      dimension_written INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE cove_stage_owner_index_epoch(id INTEGER PRIMARY KEY,epoch INTEGER);
    INSERT INTO cove_stage_owner_index_epoch VALUES(1,7);
    CREATE TABLE cove_stage_owner_index_totals(
      territory TEXT,currency TEXT,amount INTEGER,
      PRIMARY KEY(territory,currency));
    INSERT INTO cove_stage_owner_index_totals VALUES('US','USD',${PRODUCT_COUNT});
    CREATE TABLE cove_market_withdrawals(
      territory TEXT PRIMARY KEY,operation_id TEXT,withdrawn_at TEXT);
    CREATE TABLE cove_stage_owner_index_items(
      product_id TEXT PRIMARY KEY,territory TEXT,currency TEXT,expires_at TEXT);
    CREATE TABLE cove_stage_owner_index_dimensions(
      product_id TEXT,territory TEXT,currency TEXT,kind TEXT,value TEXT,
      PRIMARY KEY(product_id,territory,currency,kind,value));
    CREATE INDEX idx_stage_expires ON cove_stage_owner_index_items(
      territory,currency,expires_at);`);
  const rows=[], fields=['categories','languages','formats','publishers','series'];
  const words=Math.ceil(PRODUCT_COUNT/32),postings=new Map(fields.map(f=>[f,new Map()]));
  const add=(field,value,i)=>{
    let bits=postings.get(field).get(value);
    if(!bits){bits=new Uint32Array(words);postings.get(field).set(value,bits);}
    bits[i>>>5]|=1<<(i&31);
  };
  const seed=performance.now();
  const insert=db.prepare(`INSERT INTO cove_stage_owner_index_items
    (product_id,territory,currency,expires_at) VALUES(?,'US','USD',?)`);
  db.exec('BEGIN IMMEDIATE');
  try{
    for(let i=0;i<PRODUCT_COUNT;i++){
      const id='prd_stage_synthetic_'+String(i).padStart(6,'0');
      const score=PRODUCT_COUNT-i,price=(i%170)*25;
      rows.push({product_id:id,rank_score:score,price_minor:price});
      insert.run(id,'9999-12-31T23:59:59.999Z');
      add('categories','Category'+i%96,i);
      add('publishers','Publisher'+i%42,i);
      add('languages',i%3===0?'fr':'en',i);
      add('formats',i%4===0?'audio':'ebook',i);
      add('series','Series'+i%120,i);
    }
    db.exec('COMMIT');
  }catch(error){db.exec('ROLLBACK');throw error;}
  const allBits=new Uint32Array(words);allBits.fill(0xffffffff);
  if(PRODUCT_COUNT%32)allBits[words-1]=0xffffffff>>>(32-(PRODUCT_COUNT%32));
  const snapshot={ownerEpoch:7,count:PRODUCT_COUNT,rows,postings,allBits,
    approximateBitmapBytes:[...postings.values()].reduce((n,m)=>
      n+[...m.values()].reduce((v,b)=>v+b.byteLength,0),allBits.byteLength)};
  const seedMs=+(performance.now()-seed).toFixed(2);
  const written=tx(()=>store.persistStageOwnerBitmap(sql,snapshot));
  const hydratedAt=performance.now();
  const recovered=store.hydrateStageOwnerBitmap(sql);
  const hydrateMs=+(performance.now()-hydratedAt).toFixed(3);
  assert.equal(recovered.count,PRODUCT_COUNT);
  assert.equal(recovered.ownerEpoch,7);
  assert.equal(recovered.rows.length,PRODUCT_COUNT);
  assert.equal(recovered.rows[0].product_id,rows[0].product_id);
  assert.equal(recovered.rows.at(-1).product_id,rows.at(-1).product_id);
  assert.equal(recovered.postings.get('categories').size,96);
  assert.equal(recovered.postings.get('series').size,120);
  assert.deepEqual(recovered.postings.get('categories').get('Category17'),
    postings.get('categories').get('Category17'),
    'Persisted and restored category bitmap must retain every exact bit');
  assert.deepEqual(recovered.postings.get('publishers').get('Publisher31'),
    postings.get('publishers').get('Publisher31'));
  assert.equal(written.products,PRODUCT_COUNT);
  const largest=db.prepare(`SELECT MAX(length(encoded_chunk)) n FROM
    cove_stage_owner_bitmap_shards`).get().n;
  assert.ok(written.chunks>1,'Realistic catalog must shard across many rows');
  assert.ok(largest<524_288,'Each text row must be far below Cloudflare 8MiB limit');
  // Simulate 64 OWNER-INDEX REMOVALS only; no positive rights are created
  // or inferred. This is an offline shape/performance experiment, NOT a
  // substitute for real legal-owner transaction or D1 correctness evidence.
  const sealBefore=db.prepare('SELECT checksum,byte_length,chunk_count FROM cove_stage_owner_bitmap_seal').get();
  const rawBytesBefore=db.prepare('SELECT SUM(length(encoded_chunk)) n FROM cove_stage_owner_bitmap_shards').get().n;
  const deleted=64,deltaStart=performance.now();
  const drop=db.prepare('DELETE FROM cove_stage_owner_index_items WHERE product_id=?');
  const event=db.prepare(`INSERT INTO cove_stage_owner_bitmap_change_log(
    product_id,item_deleted,dimension_deleted) VALUES(?,1,1)`);
  const delta=tx(()=>{
    for(let i=0;i<deleted;i++){
      const id='prd_stage_synthetic_'+String(i).padStart(6,'0');
      drop.run(id);event.run(id);
    }
    db.prepare("UPDATE cove_stage_owner_index_totals SET amount=amount-? WHERE territory='US' AND currency='USD'").run(deleted);
    db.prepare('UPDATE cove_stage_owner_index_epoch SET epoch=epoch+? WHERE id=1').run(deleted);
    assert.throws(()=>store.hydrateStageOwnerBitmap(sql),/stale_or_absent/,
      'Unsealed owner withdrawal cannot expose an old positive snapshot');
    return store.persistStageOwnerBitmapRevocations(sql);
  });
  const deltaMs=+(performance.now()-deltaStart).toFixed(3);
  assert.equal(delta.removed,deleted);
  assert.equal(delta.active,PRODUCT_COUNT-deleted);
  assert.deepEqual(db.prepare('SELECT checksum,byte_length,chunk_count FROM cove_stage_owner_bitmap_seal').get(),
    sealBefore,'Removal-only patch cannot rewrite 5.9 MB immutable base');
  assert.equal(db.prepare('SELECT SUM(length(encoded_chunk)) n FROM cove_stage_owner_bitmap_shards').get().n,
    rawBytesBefore,'Removal-only patch must leave all 23 payload shards untouched');
  const hydratedDeltaAt=performance.now();
  const afterWithdrawal=store.hydrateStageOwnerBitmap(sql);
  const hydrateAfterDeltaMs=+(performance.now()-hydratedDeltaAt).toFixed(3);
  assert.equal(afterWithdrawal.count,PRODUCT_COUNT-deleted);
  assert.equal(afterWithdrawal.rows.length,PRODUCT_COUNT);
  assert.throws(()=>tx(()=>store.persistStageOwnerBitmap(sql,afterWithdrawal)),
    /rebuild_required/,
    'A retired slot cannot be accidentally re-sealed as a positive book');
  for(let i=0;i<deleted;i++)assert.equal(afterWithdrawal.allBits[i>>>5]&(1<<(i&31)),0,
    'Withdrawn book must not have a readable catalog bit');
  assert.ok(afterWithdrawal.allBits[deleted>>>5]&(1<<(deleted&31)),
    'Unchanged, already-indexed book must remain visible');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM cove_stage_owner_bitmap_revoked').get().n,deleted);
  assert.throws(()=>tx(()=>{
    db.prepare('INSERT INTO cove_stage_owner_bitmap_change_log(product_id,item_written) VALUES(?,1)')
      .run('prd_stage_synthetic_000100');
    db.prepare('UPDATE cove_stage_owner_index_epoch SET epoch=epoch+1 WHERE id=1').run();
    store.persistStageOwnerBitmapRevocations(sql);
  }),/positive_or_unsupported_edit/,
  'Unreviewed positive edit must not be accepted as a revocation delta');
  assert.throws(()=>tx(()=>{
    db.prepare('UPDATE cove_stage_owner_index_epoch SET epoch=epoch+1 WHERE id=1').run();
    store.persistStageOwnerBitmapRevocations(sql);
  }),/untracked_owner_change/,
  'Changed generation without a journaled removal must fail closed');
  assert.equal(store.hydrateStageOwnerBitmap(sql).count,PRODUCT_COUNT-deleted,
    'Transaction rollback preserves previously sealed safe snapshot');
  assert.throws(()=>tx(()=>{
    const journal=db.prepare(`INSERT INTO cove_stage_owner_bitmap_change_log(
      product_id,item_deleted) VALUES(?,1)`);
    for(let i=0;i<513;i++)
      journal.run('prd_stage_fake_overflow_'+String(i).padStart(6,'0'));
    store.persistStageOwnerBitmapRevocations(sql);
  }),/compaction_required/,
    'Oversize removal journal must demand exact owner maintenance rebuild');
  assert.equal(store.hydrateStageOwnerBitmap(sql).count,PRODUCT_COUNT-deleted,
    'Rejected oversize journal must not alter durable bitmap');
  // A single unjournaled canonical mutation must deny cached authorization.
  db.prepare('UPDATE cove_stage_owner_index_epoch SET epoch=epoch+1 WHERE id=1').run();
  assert.throws(()=>store.hydrateStageOwnerBitmap(sql),/stale_or_absent/);
  console.log(JSON.stringify({schema:'cove.stage.sharded-owner-bitmap-cold.v2',
    syntheticProducts:PRODUCT_COUNT,seedMs,shardCount:written.chunks,
    serializedBytes:written.bytes,maxEncodedShardChars:largest,
    coldHydrateMs:hydrateMs,deltaRemoved:deleted,
    deltaTransactionMs:deltaMs,coldHydrateAfterDeltaMs:hydrateAfterDeltaMs,
    baseShardsRewritten:0,exactRestoredBits:true,postDeltaVisible:PRODUCT_COUNT-deleted,
    staleEpochDenied:true,positiveWriteDenied:true,rollbackSafe:true,
    ownerRightsChecked:false,realCustomerRequests:0,hostedCloudflare:false,
    geographicLoadCertified:false,releaseCertified:false}));
} finally {db.close();rmSync(root,{recursive:true,force:true});}
