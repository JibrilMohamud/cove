/* eslint-disable prettier/prettier -- Isolated owner-local bitmap proof; not a production catalog. */
/**
 * STAGE ONLY. Build a fast, read-only facet bitmap from already-authorized
 * owner-index rows OUTSIDE the customer request path. This module does not
 * make positive rights decisions, grant offers, or replace a D1 legal check.
 *
 * The canonical index's epoch is incremented transactionally whenever a
 * rights-backed item is added, removed, or reindexed. A snapshot built at an
 * older epoch is unusable. The existing dirty queue, market tombstone and
 * lease-expiry guard run before EACH bitmap read. The owner must rebuild a
 * snapshot after committed reconciliation, never publish a stale one.
 *
 * NOT a production implementation: in-memory snapshot construction is still
 * O(catalog size), is not persisted across Durable Object cold starts, and
 * FTS, multi-territory, customer-scoped filters and all production sorts are
 * deliberately rejected. No rights may be inferred from metadata.
 */
import type {AuthoritySql} from './legal-authority-core';
import {readStageOwnerIncrementalIndex} from './owner-catalog-incremental-index.stage';

const TERRITORY='US',CURRENCY='USD';
const FIELDS=['categories','languages','formats','publishers','series'] as const;
type Field=typeof FIELDS[number];
type Scope={
  territory:string;currency:string;sort:string;page:number;limit:number;query?:string;
  categories?:string[];languages?:string[];formats?:string[];
  publishers?:string[];series?:string[];minPrice?:number;maxPrice?:number;
};
type OwnerItem={product_id:string;rank_score:number;price_minor:number};
type Snapshot={
  readonly ownerEpoch:number;
  readonly count:number;
  readonly approximateBitmapBytes:number;
  readonly rows:readonly OwnerItem[];
  readonly postings:Map<Field,Map<string,Uint32Array>>;
  readonly allBits:Uint32Array;
};
const defaultInput={territory:TERRITORY,currency:CURRENCY,sort:'rank',
  page:1,limit:25,query:''} as const;
function ownerEpoch(sql:AuthoritySql){
  const n=sql.exec<{epoch:number}>('SELECT epoch FROM cove_stage_owner_index_epoch WHERE id=1')
    .toArray()[0]?.epoch;
  if(!Number.isSafeInteger(n)||n<0)throw Error('stage_owner_bitmap_unsealed_epoch');
  return n;
}
function checkedScope(input:Scope){
  if(!input||input.territory!==TERRITORY||input.currency!==CURRENCY||
    input.sort!=='rank'||!Number.isSafeInteger(input.page)||input.page<1||
    input.page>500||!Number.isSafeInteger(input.limit)||input.limit<1||
    input.limit>25||input.query!==undefined&&input.query!==''||
    Object.keys(input).some(k=>!['territory','currency','sort','page','limit','query',
      ...FIELDS,'minPrice','maxPrice'].includes(k)))
    throw Error('stage_owner_bitmap_unsupported_scope');
  for(const field of FIELDS){
    const v=input[field];
    if(v!==undefined&&(!Array.isArray(v)||v.length>12||v.some(x=>
      typeof x!=='string'||x.length<1||x.length>160)))
      throw Error('stage_owner_bitmap_invalid_filter');
  }
  for(const key of ['minPrice','maxPrice'] as const){
    const v=input[key];
    if(v!==undefined&&(!Number.isSafeInteger(v)||v<0||v>1_000_000_000))
      throw Error('stage_owner_bitmap_invalid_price');
  }
  if(input.minPrice!==undefined&&input.maxPrice!==undefined&&
    input.minPrice>input.maxPrice)throw Error('stage_owner_bitmap_inverted_price');
}
function countBits(bits:Uint32Array){
  let count=0;
  for(let n of bits){
    n=n-((n>>>1)&0x55555555);
    n=(n&0x33333333)+((n>>>2)&0x33333333);
    count+=(((n+(n>>>4))&0x0f0f0f0f)*0x01010101)>>>24;
  }
  return count;
}
/**
 * Call ONLY after the canonical owner transaction commits every pending
 * mutation and before exposing this snapshot to any stage read. A failed or
 * incomplete index cannot be used as a source of positive rights.
 */
export function buildStageOwnerBitmap(sql:AuthoritySql):Snapshot{
  const guarded=readStageOwnerIncrementalIndex(sql,defaultInput);
  const beforeEpoch=ownerEpoch(sql);
  const rows=sql.exec<OwnerItem>(`SELECT product_id,rank_score,price_minor
    FROM cove_stage_owner_index_items WHERE territory=? AND currency=?
    ORDER BY rank_score DESC,product_id ASC`,TERRITORY,CURRENCY).toArray();
  if(rows.length!==guarded.count)throw Error('stage_owner_bitmap_incomplete_population');
  const positions=new Map<string,number>();
  for(const [i,row] of rows.entries()){
    if(positions.has(row.product_id)||!Number.isSafeInteger(row.rank_score)||
      !Number.isSafeInteger(row.price_minor)||row.price_minor<0)
      throw Error('stage_owner_bitmap_invalid_authorized_item');
    positions.set(row.product_id,i);
  }
  const words=Math.ceil(rows.length/32);
  const allBits=new Uint32Array(words);
  allBits.fill(0xffffffff);
  if(words&&rows.length%32)allBits[words-1]=0xffffffff>>>(32-(rows.length%32));
  const postings=new Map<Field,Map<string,Uint32Array>>();
  for(const field of FIELDS)postings.set(field,new Map());
  const dimensions=sql.exec<{product_id:string;kind:string;value:string}>(`
    SELECT d.product_id,d.kind,d.value FROM cove_stage_owner_index_dimensions d
    WHERE d.territory=? AND d.currency=?`,TERRITORY,CURRENCY).toArray();
  for(const dim of dimensions){
    const index=positions.get(dim.product_id);
    if(index===undefined||!FIELDS.includes(dim.kind as Field)||
      typeof dim.value!=='string'||!dim.value)
      // Availability is projected directly from the authorized count, never
      // accepted as a grant or searched as an independent facet.
      if(!(index!==undefined&&dim.kind==='availability'&&dim.value==='available'))
        throw Error('stage_owner_bitmap_invalid_authorized_dimension');
    if(dim.kind==='availability')continue;
    const byValue=postings.get(dim.kind as Field)!;
    let bits=byValue.get(dim.value);
    if(!bits){bits=new Uint32Array(words);byValue.set(dim.value,bits);}
    bits[index!>>>5]|=1<<(index!&31);
  }
  if(ownerEpoch(sql)!==beforeEpoch)
    throw Error('stage_owner_bitmap_modified_during_build');
  // Re-run the complete owner guard, not merely the numeric epoch; a tombstone
  // or clock deadline can change without any positive index-row mutation.
  const after=readStageOwnerIncrementalIndex(sql,defaultInput);
  if(after.count!==rows.length)throw Error('stage_owner_bitmap_modified_during_build');
  const bitmapBytes=[...postings.values()].reduce((size,values)=>
    size+[...values.values()].reduce((n,bits)=>n+bits.byteLength,0),allBits.byteLength);
  return {ownerEpoch:beforeEpoch,count:rows.length,approximateBitmapBytes:bitmapBytes,
    rows,postings,allBits};
}
/**
 * Every invocation revalidates the current authoritative index and its
 * generation BEFORE touching a bitmap. This intentionally fails closed on
 * expired paid proof, pending rights reconciliation and withdrawn markets.
 */
export function readStageOwnerBitmap(sql:AuthoritySql,snapshot:Snapshot,input:Scope){
  checkedScope(input);
  const current=readStageOwnerIncrementalIndex(sql,defaultInput);
  // A withdrawn market can return zero immediately without consulting
  // historical positive bitmap contents.
  if(current.count===0)return {...current,pageIds:[]};
  if(ownerEpoch(sql)!==snapshot.ownerEpoch||current.count!==snapshot.count)
    throw Error('stage_owner_bitmap_stale_epoch');
  const {rows,allBits,postings}=snapshot;
  const words=allBits.length;
  const normalized=new Map<Field,string[]>();
  for(const field of FIELDS)normalized.set(field,[...new Set(input[field]||[])].sort());
  const selected=(exclude?:Field|'price')=>{
    const out=allBits.slice();
    for(const field of FIELDS){
      if(field===exclude)continue;
      const values=normalized.get(field)!;
      if(!values.length)continue;
      const union=new Uint32Array(words);
      for(const value of values){
        const valueBits=postings.get(field)!.get(value);
        if(valueBits)for(let w=0;w<words;w++)union[w]|=valueBits[w];
      }
      for(let w=0;w<words;w++)out[w]&=union[w];
    }
    if(exclude!=='price'&&(input.minPrice!==undefined||input.maxPrice!==undefined))
      for(let i=0;i<rows.length;i++){
        const price=rows[i].price_minor;
        if((input.minPrice!==undefined&&price<input.minPrice)||
          (input.maxPrice!==undefined&&price>input.maxPrice))
          out[i>>>5]&=~(1<<(i&31));
      }
    return out;
  };
  const chosen=selected();
  const count=countBits(chosen);
  const offset=(input.page-1)*input.limit,pageIds:string[]=[];
  let seen=0;
  for(let i=0;i<rows.length&&pageIds.length<input.limit;i++){
    if(!(chosen[i>>>5]&(1<<(i&31))))continue;
    if(seen++>=offset)pageIds.push(rows[i].product_id);
  }
  const caps:{[K in Field]:number}={
    categories:40,languages:30,formats:20,publishers:30,series:30,
  };
  const facets={} as Record<Field,Array<{value:string;count:number}>>;
  for(const field of FIELDS){
    const basis=selected(field);
    const values:Array<{value:string;count:number}>=[];
    for(const [value,bits] of postings.get(field)!){
      let n=0;
      for(let w=0;w<words;w++)n+=countBits(Uint32Array.of(basis[w]&bits[w]));
      if(n)values.push({value,count:n});
    }
    facets[field]=values.sort((a,b)=>b.count-a.count||
      (a.value<b.value?-1:a.value>b.value?1:0)).slice(0,caps[field]);
  }
  let min:number|null=null,max:number|null=null;
  const noPrice=selected('price');
  for(let i=0;i<rows.length;i++){
    if(!(noPrice[i>>>5]&(1<<(i&31))))continue;
    const price=rows[i].price_minor;
    if(min===null||price<min)min=price;
    if(max===null||price>max)max=price;
  }
  return {count,pageIds,facets:{...facets,
    availability:count?[{value:'available',count}]:[],
    price:min===null||max===null?null:{currency:CURRENCY,min,max}},
    releaseCertified:false as const};
}
