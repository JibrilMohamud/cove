/* eslint-disable prettier/prettier -- Exact protected one-time snapshot transfer; no production writes. */
import assert from "node:assert/strict";
import {createHash,randomBytes} from "node:crypto";
import {readFileSync,mkdirSync,writeFileSync} from "node:fs";
import {setTimeout as sleep} from "node:timers/promises";
import {transferDigest} from "./real-catalog-copy-receipt.mjs";
import {createProviderBudget} from "./real-catalog-copy-budget.mjs";
import {reconcilePage} from "./real-catalog-copy-resume.mjs";
import {account,source,target,targetName,maxBytes,pageLimit,plan,initialTables,mustBeEmpty,forbiddenSourceRows,readSql,validateRows} from "./real-catalog-copy-plan.mjs";
const env=process.env;
assert.equal(env.GITHUB_REPOSITORY,"JibrilMohamud/cove");
assert.equal(env.GITHUB_REF,"refs/heads/main");
assert.equal(env.GITHUB_EVENT_NAME,"workflow_dispatch");
assert.equal(env.REVIEWED_SHA,env.GITHUB_SHA);
assert.match(env.GITHUB_SHA||"",/^[a-f0-9]{40}$/);
assert.match(env.GITHUB_RUN_ID||"",/^[1-9][0-9]{7,14}$/);
assert.match(env.GITHUB_RUN_ATTEMPT||"",/^[1-9][0-9]{0,3}$/);
assert.notEqual(source,target);
const sourceToken=env.COVE_BIOSYNC_PROD_D1_READ_TOKEN||"";
const targetRead=env.COVE_CF_STAGE_DATA_PLANE_READ_TOKEN||"";
const deploy=env.COVE_CF_STAGE_WORKERS_DEPLOY_TOKEN||"";
assert.ok([sourceToken,targetRead,deploy].every(x=>x.length>=20));
assert.equal(new Set([sourceToken,targetRead,deploy]).size,3,"Separate source read, stage read and deployment principals required");
const run=env.GITHUB_RUN_ID+"-"+env.GITHUB_RUN_ATTEMPT;
const name="cove-catalog-copy-"+run;
const api="https://api.cloudflare.com/client/v4/accounts/"+account;
const root="/workers/scripts/"+name;
const artifact="artifacts/real-catalog-snapshot";
mkdirSync(artifact,{recursive:true});
const evidence={sha:env.GITHUB_SHA,source,target,targetName,run,tables:{},privateTablesEmpty:false,sourceWrites:0,legalGenerationAttested:false,releaseCertified:false,complete:false,importerRemoved:false};
const save=()=>writeFileSync(artifact+"/evidence.json",JSON.stringify(evidence,null,2)+"\n");
const providerRequest=createProviderBudget({fetcher:(url,init)=>fetch(url,{...init,signal:AbortSignal.timeout(60000)}),onBackoff:event=>console.log("CATALOG_PROVIDER_BACKOFF "+JSON.stringify(event))});
async function cf(path,token,method="GET",body,missing=false){
  const queryPath=/^\/d1\/database\/[a-f0-9-]{36}\/query$/.test(path);
  const safeRead=method==="GET"||(method==="POST"&&queryPath&&typeof body?.sql==="string"&&/^SELECT\s/i.test(body.sql));
  const idempotentCleanup=(method==="DELETE"&&path===root+"?force=true")||(method==="POST"&&path===root+"/subdomain"&&body?.enabled===false&&body?.previews_enabled===false);
  const label=queryPath?(path.includes(source)?"source-read":"snapshot-read"):"worker-control";
  const r=await providerRequest(api+path,{method,headers:{authorization:"Bearer "+token,...(body&&!(body instanceof FormData)?{"content-type":"application/json"}:{})},...(body?{body:body instanceof FormData?body:JSON.stringify(body)}:{}),redirect:"error"},{safeRead,idempotentCleanup,label});
  if(missing&&r.status===404)return null;
  assert.ok(r.ok,"Cloudflare operation rejected: "+label+" "+method+" "+r.status);
  const data=await r.json();
  assert.ok(data.success,"Cloudflare API rejected "+label+" "+method+" "+r.status);
  return data.result;
}
async function query(id,sql,params=[]){
  assert.ok(id===source||id===target);
  assert.match(sql,/^SELECT\s/i);
  assert.doesNotMatch(sql,/;\s*\S|\b(?:INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER|ATTACH|DETACH|PRAGMA|VACUUM)\b/i);
  const result=await cf("/d1/database/"+id+"/query",id===source?sourceToken:targetRead,"POST",{sql,params:params.map(x=>String(x))});
  assert.equal(result.length,1);const x=result[0];
  assert.equal(x.success,true);assert.equal(x.meta.changed_db,false);assert.equal(x.meta.changes,0);
  if(x.meta.rows_written!==undefined)assert.equal(x.meta.rows_written,0);
  assert.ok(Array.isArray(x.results));return x.results;
}
const scalar=async(id,sql)=>Number((await query(id,sql))[0].n);
async function cleanup(){
  const present=await cf(root+"/subdomain",deploy,"GET",undefined,true);
  if(present===null)return;
  await cf(root+"/subdomain",deploy,"POST",{enabled:false,previews_enabled:false});
  await cf(root+"?force=true",deploy,"DELETE",undefined,true);
  assert.equal(await cf(root+"/subdomain",deploy,"GET",undefined,true),null,"Import Worker still exists");
}
if(process.argv.includes("--cleanup")){await cleanup();process.exit(0);}
// The always-run cleanup must never overwrite the actual import evidence.
save();
const gate=randomBytes(32).toString("hex");console.log("::add-mask::"+gate);
const origin="https://"+name+".cove-jibrilmohamud.workers.dev/copy";
async function call(body,credential=gate){
  return fetch(origin,{method:"POST",headers:{...(credential?{authorization:"Bearer "+credential}:{}),"content-type":"application/json"},body:JSON.stringify(body),cache:"no-store",redirect:"manual",signal:AbortSignal.timeout(60000)});
}
const marked=(r)=>r.headers.get("x-cove-catalog-snapshot-run")===run&&r.headers.get("cache-control")==="no-store";
async function ready(){
  for(let i=0;i<40;i++){
    const first=await call({operation:"probe"}).catch(()=>null);
    if(first?.status===204&&marked(first)){
      const denied=await call({operation:"probe"},"").catch(()=>null);
      const wrong=await call({operation:"probe"},(gate[0]==="0"?"1":"0")+gate.slice(1)).catch(()=>null);
      if([denied,wrong].some(r=>r&&r.status>=200&&r.status<300))throw Error("Unauthorized import accepted");
      if(denied?.status===401&&wrong?.status===401&&marked(denied)&&marked(wrong))return;
    }
    await sleep(2000);
  }
  throw Error("Importer readiness or unauthorized denial not verified");
}
async function copy(item,rows){
  const bytes=Buffer.byteLength(JSON.stringify(rows));
  if(bytes>maxBytes&&rows.length>1){const mid=Math.floor(rows.length/2);await copy(item,rows.slice(0,mid));await copy(item,rows.slice(mid));return;}
  validateRows(item,rows);
  for(let i=0;i<6;i++){
    const r=await call({operation:"copy",table:item.table,rows}).catch(()=>null);
    if(r?.status===204&&marked(r))return;
    if(r&&marked(r)&&![429,502,503,504].includes(r.status))throw Error("Marked import rejected "+item.table+": "+r.status);
    if(r&&r.status!==404&&r.status!==429&&r.status!==502&&r.status!==503&&r.status!==504)throw Error("Unexpected import status "+r.status);
    // Exact primary-key UPSERT is idempotent. No production or legal-owner command is retried.
    await sleep(1000*(i+1));
  }
  throw Error("Isolated import acknowledgement missing for "+item.table);
}
async function reconcileTable(item){
  const hash=createHash("sha256");let cursor=null,count=0,reused=0,written=0,pages=0;
  const initialCount=await scalar(target,'SELECT count(*) n FROM "'+item.table+'"');
  const limit=pageLimit(item);
  console.log("CATALOG_COPY_START "+JSON.stringify({table:item.table,existing:initialCount,pageLimit:limit}));
  for(;;){
    const rows=await query(source,readSql(item,cursor,false,limit),cursor||[]);
    if(!rows.length)break;
    const data=rows.map(r=>item.columns.map(c=>r[c]));
    const last=rows.at(-1);const next=item.keys.map(k=>last[k]);
    assert.ok(next.every(x=>x!==null&&x!==undefined));assert.notDeepEqual(next,cursor,"Cursor failed to advance");
    const readTarget=async()=> (await query(target,readSql(item,cursor,true,limit),cursor||[])).map(r=>item.columns.map(c=>r[c]));
    const result=await reconcilePage(data,{readTarget,write:rows=>copy(item,rows),checkExisting:count<initialCount});
    if(result.reused)reused+=data.length;else written+=data.length;
    for(const row of result.verified)hash.update(JSON.stringify(row)+"\n");
    count+=data.length;cursor=next;pages++;
    if(pages%20===0){
      evidence.progress={table:item.table,count,reused,written,pages};save();
      console.log("CATALOG_COPY_PROGRESS "+JSON.stringify(evidence.progress));
    }
    if(rows.length<limit)break;
  }
  const finalCount=await scalar(target,'SELECT count(*) n FROM "'+item.table+'"');
  assert.equal(finalCount,count,"Unexpected extra or missing snapshot rows: "+item.table);
  return {count,sha256:hash.digest("hex"),reused,written,pages};
}
const countSet=async(id,tables)=>Object.fromEntries(await Promise.all(tables.map(async t=>[t,await scalar(id,'SELECT count(*) n FROM "'+t+'"')])));
const targetInfo=await cf("/d1/database/"+target,targetRead);
assert.equal(targetInfo.name,targetName);
const sourceCounts=await countSet(source,["products","editions","works","rights_grants","rights_grant_territories","edition_taxonomy_nodes","catalog_search_documents"]);
assert.ok(sourceCounts.products>=82247&&sourceCounts.editions===sourceCounts.products&&sourceCounts.works===sourceCounts.products);
assert.equal(await scalar(source,"SELECT count(*) n FROM products WHERE source_name<>'gutenberg'"),0,"Non-Gutenberg catalog requires new projection review");
assert.equal(await scalar(source,"SELECT count(*) n FROM rights_grants WHERE source NOT LIKE 'gutenberg-%' OR contract_id IS NOT NULL OR contract_version_id IS NOT NULL"),0);
assert.equal(await scalar(source,"SELECT count(*) n FROM asset_versions WHERE source_url NOT LIKE 'https://www.gutenberg.org/%' AND source_url NOT LIKE 'https://www.gutenberg.net.au/%' AND source_url NOT LIKE 'https://www.gutenberg.ca/%'"),0);
assert.equal(await scalar(source,"SELECT count(*) n FROM asset_versions WHERE source_url LIKE '%?%'"),0);
for(const t of forbiddenSourceRows)assert.equal(await scalar(source,'SELECT count(*) n FROM "'+t+'"'),0,"New private or contractual source rows require review: "+t);
for(const t of initialTables)assert.equal(await scalar(target,'SELECT count(*) n FROM "'+t+'"'),await scalar(source,'SELECT count(*) n FROM "'+t+'"'),"Reference count changed: "+t);
for(const t of mustBeEmpty)assert.equal(await scalar(target,'SELECT count(*) n FROM "'+t+'"'),0,"Private target table populated: "+t);
try{
  await cleanup();
  const metadata={main_module:"real-catalog-copy.worker.mjs",compatibility_date:"2026-10-25",observability:{enabled:false},bindings:[{type:"d1",name:"SNAPSHOT",id:target},{type:"plain_text",name:"TARGET",text:target},{type:"plain_text",name:"RUN",text:run},{type:"plain_text",name:"EXPIRES",text:String(Date.now()+145*60_000)},{type:"secret_text",name:"GATE",text:gate}]};
  assert.equal(metadata.bindings.filter(x=>x.type==="d1").length,1);
  assert.ok(!JSON.stringify(metadata).includes(source));
  const form=new FormData();form.append("metadata",new Blob([JSON.stringify(metadata)],{type:"application/json"}));
  for(const file of ["real-catalog-copy.worker.mjs","real-catalog-copy-plan.mjs"])form.append(file,new Blob([readFileSync("scripts/staging/"+file)],{type:"application/javascript+module"}),file);
  await cf(root,deploy,"PUT",form);
  const settings=await cf(root+"/settings",deploy);
  const dbs=settings.bindings.filter(x=>x.type==="d1");
  assert.equal(dbs.length,1);assert.equal(dbs[0].name,"SNAPSHOT");assert.equal(dbs[0].id,target);
  assert.ok(settings.bindings.every(x=>["d1","secret_text","plain_text"].includes(x.type)));
  await cf(root+"/subdomain",deploy,"POST",{enabled:true,previews_enabled:false});
  await ready();
  const unsealed=await call({operation:"unseal"});
  assert.equal(unsealed.status,204);assert.ok(marked(unsealed));
  // Table order preserves FK parents. Read-back hashes include every projected value.
  for(const item of plan){
    try{
      const verified=await reconcileTable(item);
      evidence.tables[item.table]=verified;delete evidence.progress;save();
      console.log("CATALOG_COPY_VERIFIED "+item.table+" "+JSON.stringify(verified));
    }catch(error){
      evidence.failedTable=item.table;save();
      throw new Error("Catalog copy failed at "+item.table+": "+error.message,{cause:error});
    }
  }
  // Count/status gates are distinct from independent rights-owner generation.
  const final=await countSet(target,Object.keys(sourceCounts));
  assert.deepEqual(final,sourceCounts);
  assert.deepEqual(await countSet(source,Object.keys(sourceCounts)),sourceCounts,"Source catalog counts changed during copy");
  const statuses=(id)=>query(id,"SELECT source,decision,status,count(*) n FROM rights_grants GROUP BY source,decision,status ORDER BY source,decision,status");
  assert.deepEqual(await statuses(target),await statuses(source));
  const fts=await scalar(target,"SELECT count(*) n FROM catalog_search_fts");
  const active=await scalar(target,"SELECT count(*) n FROM catalog_search_documents WHERE suppressed=0");
  assert.equal(fts,active);
  const ftsEn=await scalar(target,"SELECT count(*) n FROM catalog_search_fts_en");
  assert.equal(ftsEn,await scalar(target,"SELECT count(*) n FROM catalog_search_documents d JOIN products p ON p.id=d.product_id JOIN editions e ON e.id=p.edition_id WHERE d.suppressed=0 AND lower(e.language)='en'"));
  for(const t of mustBeEmpty)assert.equal(await scalar(target,'SELECT count(*) n FROM "'+t+'"'),0);
  for(const sql of ["SELECT count(*) n FROM products p LEFT JOIN editions e ON e.id=p.edition_id WHERE e.id IS NULL","SELECT count(*) n FROM editions e LEFT JOIN works w ON w.id=e.work_id WHERE w.id IS NULL","SELECT count(*) n FROM rights_grants g LEFT JOIN editions e ON e.id=g.edition_id WHERE e.id IS NULL","SELECT count(*) n FROM edition_taxonomy_nodes n LEFT JOIN editions e ON e.id=n.edition_id LEFT JOIN storefront_taxonomy_nodes t ON t.id=n.taxonomy_node_id WHERE e.id IS NULL OR t.id IS NULL"])assert.equal(await scalar(target,sql),0);
  evidence.counts=final;evidence.fts={all:fts,english:ftsEn};evidence.rightsStatuses=await statuses(target);evidence.privateTablesEmpty=true;
  const digest=createHash("sha256").update(JSON.stringify({tables:evidence.tables,counts:final,fts:evidence.fts,rightsStatuses:evidence.rightsStatuses})).digest("hex");
  const sealed=await call({operation:"seal",sha:env.GITHUB_SHA,transferDigest:transferDigest(),manifestDigest:digest,products:final.products,editions:final.editions});
  assert.equal(sealed.status,204,"Completed snapshot receipt refused");assert.ok(marked(sealed));
  evidence.manifestDigest=digest;evidence.complete=true;save();
}finally{await cleanup();evidence.importerRemoved=true;save();}
console.log("PASS: isolated full-catalog projection; not independent legal or release certification.");
