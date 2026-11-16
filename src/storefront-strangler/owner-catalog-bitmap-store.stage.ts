/* eslint-disable prettier/prettier -- Bounded, isolated canonical-owner bitmap durability proof. */
/**
 * STAGE ONLY. Rehydrate preauthorized owner-bitmaps without an 82k-book
 * customer-path rebuild. This DOES NOT grant any right. Only the canonical
 * owner may write snapshots, inside its SQLite transaction after all dirty
 * items and positive rights have been reconciled.
 *
 * Cloudflare SQLite rows/BLOBs have an 8 MiB limit. Persist 256 KiB UTF-8
 * payload shards as base64 TEXT, never a single unbounded catalog row.
 * The FNV checksum detects accidental data drift, NOT malicious tampering;
 * authorization is enforced solely by the live owner guard and fresh epoch.
 * Real multi-market/FTS/rights and hosted CPU SLOs remain uncertified.
 */
import type {AuthoritySql} from './legal-authority-core';
import {buildStageOwnerBitmap} from './owner-catalog-bitmap.stage';
import {guardStageOwnerIndexRead} from './owner-catalog-incremental-index.stage';

type Snapshot=ReturnType<typeof buildStageOwnerBitmap>;
const fields=['categories','languages','formats','publishers','series'] as const;
type Field=typeof fields[number];
const scope={territory:'US',currency:'USD'} as const;
const MAX_CHUNK_BYTES=256*1024,MAX_SERIAL_BYTES=32*1024*1024;
const MAX_CHUNKS=Math.ceil(MAX_SERIAL_BYTES/MAX_CHUNK_BYTES);
const encoder=new TextEncoder(),decoder=new TextDecoder('utf-8',{fatal:true});
function checksum(bytes:Uint8Array){
  let h=2166136261;
  for(const byte of bytes)h=Math.imul(h^byte,16777619)>>>0;
  return h;
}
function encode64(bytes:Uint8Array){
  let binary='';
  for(let i=0;i<bytes.length;i+=8192)
    binary+=String.fromCharCode(...bytes.subarray(i,i+8192));
  return btoa(binary);
}
function decode64(text:string){
  if(!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(text))
    throw Error('stage_owner_bitmap_invalid_chunk_encoding');
  const binary=atob(text);
  const out=new Uint8Array(binary.length);
  for(let i=0;i<binary.length;i++)out[i]=binary.charCodeAt(i);
  return out;
}
export function createStageOwnerBitmapStore(sql:AuthoritySql){
  sql.exec(`CREATE TABLE IF NOT EXISTS cove_stage_owner_bitmap_shards(
    ordinal INTEGER PRIMARY KEY CHECK(ordinal>=0),
    encoded_chunk TEXT NOT NULL
  )`);
  sql.exec(`CREATE TABLE IF NOT EXISTS cove_stage_owner_bitmap_seal(
    id INTEGER PRIMARY KEY CHECK(id=1),
    owner_epoch INTEGER NOT NULL,product_count INTEGER NOT NULL,
    chunk_count INTEGER NOT NULL,byte_length INTEGER NOT NULL,
    checksum INTEGER NOT NULL,schema_version INTEGER NOT NULL CHECK(schema_version=1)
  )`);
}
function currentFor(snapshot:Snapshot,sql:AuthoritySql){
  const owner=guardStageOwnerIndexRead(sql,scope);
  if(owner.withdrawn||owner.epoch!==snapshot.ownerEpoch||
    owner.count!==snapshot.count)
    throw Error('stage_owner_bitmap_store_stale_or_denied');
}
function encodeSnapshot(snapshot:Snapshot){
  const raw={
    schema:1,ownerEpoch:snapshot.ownerEpoch,count:snapshot.count,
    rows:snapshot.rows.map(r=>[r.product_id,r.rank_score,r.price_minor]),
    postings:fields.map(field=>[
      field,
      [...snapshot.postings.get(field)!.entries()].map(([value,bits])=>[value,Array.from(bits)]),
    ]),
  };
  const bytes=encoder.encode(JSON.stringify(raw));
  if(bytes.length===0||bytes.length>MAX_SERIAL_BYTES)
    throw Error('stage_owner_bitmap_store_oversize');
  return bytes;
}
/** Must run inside the owner's transactionSync. Failure must roll back all
 * shard inserts and the seal, not publish partially updated rights. */
export function persistStageOwnerBitmap(sql:AuthoritySql,snapshot:Snapshot){
  currentFor(snapshot,sql);
  const bytes=encodeSnapshot(snapshot);
  const parts=Math.ceil(bytes.length/MAX_CHUNK_BYTES);
  if(!parts||parts>MAX_CHUNKS)throw Error('stage_owner_bitmap_store_chunk_limit');
  createStageOwnerBitmapStore(sql);
  sql.exec('DELETE FROM cove_stage_owner_bitmap_shards');
  sql.exec('DELETE FROM cove_stage_owner_bitmap_seal WHERE id=1');
  for(let n=0;n<parts;n++){
    const chunk=bytes.subarray(n*MAX_CHUNK_BYTES,(n+1)*MAX_CHUNK_BYTES);
    const encoded=encode64(chunk);
    if(encoded.length>MAX_CHUNK_BYTES*2)
      throw Error('stage_owner_bitmap_store_oversize_shard');
    sql.exec(`INSERT INTO cove_stage_owner_bitmap_shards(ordinal,encoded_chunk)
      VALUES(?,?)`,n,encoded);
  }
  currentFor(snapshot,sql);
  sql.exec(`INSERT INTO cove_stage_owner_bitmap_seal(id,owner_epoch,product_count,
    chunk_count,byte_length,checksum,schema_version) VALUES(1,?,?,?,?,?,1)`,
    snapshot.ownerEpoch,snapshot.count,parts,bytes.length,checksum(bytes));
  return {epoch:snapshot.ownerEpoch,products:snapshot.count,
    chunks:parts,bytes:bytes.length,releaseCertified:false as const};
}
export function hydrateStageOwnerBitmap(sql:AuthoritySql):Snapshot{
  const owner=guardStageOwnerIndexRead(sql,scope);
  if(owner.withdrawn)throw Error('stage_owner_bitmap_store_market_withdrawn');
  const state=sql.exec<{owner_epoch:number;product_count:number;chunk_count:number;
    byte_length:number;checksum:number;schema_version:number}>(`
    SELECT owner_epoch,product_count,chunk_count,byte_length,checksum,schema_version
    FROM cove_stage_owner_bitmap_seal WHERE id=1`).toArray()[0];
  if(!state||state.schema_version!==1||state.owner_epoch!==owner.epoch||
    state.product_count!==owner.count)
    throw Error('stage_owner_bitmap_store_stale_or_absent');
  if(!Number.isSafeInteger(state.byte_length)||state.byte_length<1||
    state.byte_length>MAX_SERIAL_BYTES||
    !Number.isSafeInteger(state.chunk_count)||state.chunk_count<1||
    state.chunk_count>MAX_CHUNKS||!Number.isSafeInteger(state.checksum))
    throw Error('stage_owner_bitmap_store_invalid_seal');
  const shards=sql.exec<{ordinal:number;encoded_chunk:string}>(`
    SELECT ordinal,encoded_chunk FROM cove_stage_owner_bitmap_shards
    ORDER BY ordinal`).toArray();
  if(shards.length!==state.chunk_count)
    throw Error('stage_owner_bitmap_store_missing_shard');
  const bytes=new Uint8Array(state.byte_length);
  let offset=0;
  for(const [i,shard] of shards.entries()){
    if(shard.ordinal!==i||typeof shard.encoded_chunk!=='string'||
      shard.encoded_chunk.length>MAX_CHUNK_BYTES*2)
      throw Error('stage_owner_bitmap_store_invalid_shard');
    const part=decode64(shard.encoded_chunk);
    if(part.byteLength>MAX_CHUNK_BYTES||offset+part.byteLength>bytes.byteLength)
      throw Error('stage_owner_bitmap_store_chunk_overflow');
    bytes.set(part,offset);offset+=part.byteLength;
  }
  if(offset!==bytes.length||checksum(bytes)!==state.checksum)
    throw Error('stage_owner_bitmap_store_checksum_mismatch');
  let raw:any;
  try{raw=JSON.parse(decoder.decode(bytes));}
  catch{throw Error('stage_owner_bitmap_store_invalid_json');}
  if(raw?.schema!==1||raw.ownerEpoch!==owner.epoch||raw.count!==owner.count||
    !Array.isArray(raw.rows)||raw.rows.length!==owner.count||
    !Array.isArray(raw.postings)||raw.postings.length!==fields.length)
    throw Error('stage_owner_bitmap_store_invalid_payload');
  const rows:Array<{product_id:string;rank_score:number;price_minor:number}>=[];
  const seen=new Set<string>();
  for(const item of raw.rows){
    if(!Array.isArray(item)||item.length!==3||
      typeof item[0]!=='string'||!/^prd_[A-Za-z0-9_-]{3,120}$/.test(item[0])||
      seen.has(item[0])||!Number.isSafeInteger(item[1])||
      !Number.isSafeInteger(item[2])||item[2]<0)
      throw Error('stage_owner_bitmap_store_invalid_row');
    const prev=rows[rows.length-1];
    if(prev&&(prev.rank_score<item[1]||
      (prev.rank_score===item[1]&&prev.product_id>=item[0])))
      throw Error('stage_owner_bitmap_store_invalid_rank_order');
    seen.add(item[0]);rows.push({product_id:item[0],rank_score:item[1],price_minor:item[2]});
  }
  const words=Math.ceil(rows.length/32);
  const postings=new Map<Field,Map<string,Uint32Array>>();
  let allocatedBytes=words*4;
  const validTail=rows.length%32?0xffffffff>>>(32-(rows.length%32)):0xffffffff;
  for(const [i,entry] of raw.postings.entries()){
    if(!Array.isArray(entry)||entry.length!==2||entry[0]!==fields[i]||
      !Array.isArray(entry[1]))
      throw Error('stage_owner_bitmap_store_invalid_field');
    const byValue=new Map<string,Uint32Array>();
    for(const pair of entry[1]){
      if(!Array.isArray(pair)||pair.length!==2||typeof pair[0]!=='string'||
        pair[0].length<1||pair[0].length>160||byValue.has(pair[0])||
        !Array.isArray(pair[1])||pair[1].length!==words)
        throw Error('stage_owner_bitmap_store_invalid_posting');
      if(pair[1].some((v:unknown)=>typeof v!=='number'||!Number.isInteger(v)||
        v<0||v>0xffffffff))
        throw Error('stage_owner_bitmap_store_invalid_word');
      const bits=Uint32Array.from(pair[1] as number[]);
      if(words&&((bits[words-1]&~validTail)!==0))
        throw Error('stage_owner_bitmap_store_out_of_range_bit');
      allocatedBytes+=bits.byteLength;
      if(allocatedBytes>32*1024*1024)
        throw Error('stage_owner_bitmap_store_bitmap_memory_limit');
      byValue.set(pair[0],bits);
    }
    postings.set(entry[0],byValue);
  }
  const allBits=new Uint32Array(words);
  allBits.fill(0xffffffff);
  if(words&&rows.length%32)allBits[words-1]=validTail;
  const current=guardStageOwnerIndexRead(sql,scope);
  if(current.withdrawn||current.epoch!==state.owner_epoch||current.count!==rows.length)
    throw Error('stage_owner_bitmap_store_changed_during_hydration');
  return {ownerEpoch:owner.epoch,count:owner.count,approximateBitmapBytes:allocatedBytes,
    rows,postings,allBits};
}
