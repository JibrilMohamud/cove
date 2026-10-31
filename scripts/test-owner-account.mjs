/* eslint-disable prettier/prettier -- Actual private owner, complete SQLite schema, erasure checkpoints and device transaction failures. */
import assert from "node:assert/strict";
import {DatabaseSync} from "node:sqlite";
import {mkdtempSync,readdirSync,readFileSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {loadPrivateFinance} from "./test-private-finance-loader.mjs";
const folder=mkdtempSync(join(tmpdir(),"cove-account-owner-")),stores=[];
const oldFetch=globalThis.fetch;
try{
 const {CoveLegalAuthority,testReadPaidAccess,testPublishFreshEntitlement}=await loadPrivateFinance(join(folder,"owner.mjs"));
 const migrations=readdirSync("drizzle").filter(x=>x.endsWith(".sql")).sort().map(x=>readFileSync("drizzle/"+x,"utf8"));
 function fixture(){
  const primary=new DatabaseSync(":memory:"),durable=new DatabaseSync(":memory:");stores.push(primary,durable);
  for(const migration of migrations)primary.exec(migration);primary.exec("PRAGMA foreign_keys=OFF");
  const at="2025-01-01T00:00:00.000Z",user="buyer_account_qa",other="other_account_qa";
  for(const id of [user,other])primary.prepare("INSERT INTO auth_accounts(provider_id,app_id,email,created_at) VALUES(?,?,?,?)").run("provider_"+id,id,id+"@test.invalid",at);
  let fail=-1,lost=false,storageFail=false,stored=new Set(),deletes=0;
  const db={prepare(query){const statement=(values=[])=>({bind:(...v)=>statement(v),query,values,
   async first(){return primary.prepare(query).get(...values)||null;},async all(){return {results:primary.prepare(query).all(...values)};},
   async run(){return {meta:primary.prepare(query).run(...values)};},execute(){return {meta:primary.prepare(query).run(...values)};}
  });return statement();},async batch(statements){primary.exec("BEGIN");try{
   const out=[];for(let i=0;i<statements.length;i++){if(i===fail)throw Error("account_batch_failure");out.push(statements[i].execute());}
   primary.exec("COMMIT");if(lost){lost=false;throw Error("lost_account_batch_ack");}return out;
  }catch(e){if(primary.isTransaction)primary.exec("ROLLBACK");throw e;}}};
  const sql={exec(query,...values){const q=durable.prepare(query),rows=q.columns().length?q.all(...values):(q.run(...values),[]);return {toArray:()=>rows};}};
  const secret="a".repeat(64),env={PRIMARY_DB:db,COVE_RIGHTS_OWNER_ENABLED:"1",COVE_RIGHTS_OWNER_PRIMARY_ID:"7c7ab994-f6b3-419d-a72d-71eb9ea22e7e",COVE_RIGHTS_OWNER_TEST_EXPIRES_AT:String(Date.now()+600000),COVE_RIGHTS_OWNER_SECRET:secret,
   BUCKET:{async list({prefix}){return {objects:[...stored].filter(k=>k.startsWith(prefix)).map(key=>({key})),truncated:false};},async delete(key){deletes++;if(storageFail)throw Error("r2_down");stored.delete(key);}}};
  let owner;const restart=()=>{owner=new CoveLegalAuthority({storage:{sql,transactionSync(fn){return fn();}}},env);};restart();
  const request=(body,key=secret)=>owner.fetch(new Request("https://legal-authority.internal/account/private-action",{method:"POST",headers:{authorization:"Bearer "+key,"content-type":"application/json"},body:JSON.stringify(body)}));
  const call=async body=>{const r=await request(body);assert.equal(r.status,200,await r.clone().text());return (await r.json()).result;};
  const queue=(id="erase_account_qa",u=user)=>primary.prepare("INSERT INTO account_deletion_requests(id,user_id,status,requested_at,execute_after,confirmation_hash,created_at,updated_at) VALUES(?,?,'queued',?,'2000-01-01','qa',?,?)").run(id,u,at,at,at);
  return {primary,durable,sql,env,user,other,at,request,call,queue,restart,stored,storageFail(v){storageFail=v;},inject(i){fail=i;},loseAck(){lost=true;},deletes:()=>deletes,retry(id="erase_account_qa"){primary.prepare("UPDATE account_deletion_requests SET next_retry_at=NULL,lease_expires_at=NULL WHERE id=?").run(id);}};
 }
 const f=fixture(),device={deviceKey:"permanent-device-key-qa-001",name:"QA reader",platform:"reader"};
 assert.equal((await f.request({action:"register-device",userId:f.user,device},"b".repeat(64))).status,401);
 assert.equal((await f.request({action:"register-device",userId:"unknown_user",device})).status,403);
 assert.equal((await f.request({action:"erasure-tick",limit:1,userId:f.other})).status,503,"A scheduler cannot select a user to erase");
 const registered=await f.call({action:"register-device",userId:f.user,device});
 assert.equal((await f.call({action:"register-device",userId:f.user,device})).id,registered.id);
 const revocation={action:"revoke-device",userId:f.user,deviceId:registered.id};
 assert.equal((await f.request({...revocation,userId:f.other})).status,503);
 // Real licenses/grants are tied to this buyer/device. Other buyers survive.
 for(const [n,u] of [[1,f.user],[2,f.other]])f.primary.prepare("INSERT INTO audio_offline_licenses(id,user_id,product_id,entitlement_id,device_id,token_hash,manifest_hash,status,issued_at,expires_at,last_refreshed_at) VALUES(?,?, 'prd_account_qa','ent_account_qa',?,?,'hash_qa','active',?,'2099-01-01',?)").run("license_qa_"+n,u,registered.id,"token_qa_"+n,f.at,f.at);
 for(let i=0;i<4;i++){
  f.inject(i);assert.equal((await f.request(revocation)).status,503);
  assert.equal(f.primary.prepare("SELECT revoked_at FROM devices WHERE id=?").get(registered.id).revoked_at,null);
  assert.equal(f.primary.prepare("SELECT status FROM audio_offline_licenses WHERE id='license_qa_1'").get().status,"active");
 }
 f.inject(-1);f.loseAck();assert.equal((await f.request(revocation)).status,503);f.restart();
 assert.equal((await f.call(revocation)).revoked,true);
 assert.equal(f.primary.prepare("SELECT status FROM audio_offline_licenses WHERE id='license_qa_1'").get().status,"revoked");
 assert.equal(f.primary.prepare("SELECT status FROM audio_offline_licenses WHERE id='license_qa_2'").get().status,"active");
 assert.equal((await f.request({action:"register-device",userId:f.user,device})).status,503,"Revoked keys are terminal");

 for(const [n,u,visibility] of [["private",f.user,"private"],["other",f.other,"private"],["public",f.user,"available"]]){
  f.primary.prepare("INSERT INTO works(id,title,created_at,updated_at) VALUES(?,?,?,?)").run("work_qa_"+n,n,f.at,f.at);
  f.primary.prepare("INSERT INTO editions(id,work_id,title,release_status,created_at,updated_at) VALUES(?,?,?,?,?,?)").run("ed_qa_"+n,"work_qa_"+n,n,visibility,f.at,f.at);
  f.primary.prepare("INSERT INTO products(id,edition_id,sku,format,source_name,source_external_id,created_at,updated_at) VALUES(?,?,?,'ebook',?,?,?,?)").run("prd_qa_"+n,"ed_qa_"+n,"sku_qa_"+n,visibility==="private"?"upload":"gutenberg","qa_"+n,f.at,f.at);
  f.primary.prepare("INSERT INTO personal_imports(id,user_id,product_id,object_key,created_at) VALUES(?,?,?,?,?)").run("import_qa_"+n,u,"prd_qa_"+n,`uploads/${u}/${n}.epub`,f.at);
 }
 f.queue();f.stored.add(`uploads/${f.user}/orphan.epub`);f.storageFail(true);
 let tick=await f.call({action:"erasure-tick",limit:1});assert.equal(tick.retrying,1);
 assert.equal(f.durable.prepare("SELECT COUNT(*) n FROM cove_account_access_denials WHERE user_id=?").get(f.user).n,1,"Owner denial must commit before R2 deletion");
 assert.ok(f.primary.prepare("SELECT disabled_at FROM auth_accounts WHERE app_id=?").get(f.user).disabled_at);
 assert.equal((await f.request({action:"register-device",userId:f.user,device:{...device,deviceKey:"fresh-device-after-erasure"}})).status,403);
 const scope={entitlementId:"ent_account_qa",userId:f.user,productId:"prd_account_qa",territory:"US",channel:"retail"};
 assert.equal(testReadPaidAccess(f.sql,scope),null);
 assert.throws(()=>testPublishFreshEntitlement(f.sql,{...scope,orderId:"order_account_qa"},0),/paid_account_erasure_denied/);
 f.restart();assert.equal(testReadPaidAccess(f.sql,scope),null,"Access veto survives restart");
 f.storageFail(false);f.retry();f.inject(1);tick=await f.call({action:"erasure-tick",limit:1});assert.equal(tick.retrying,1);
 let state=f.primary.prepare("SELECT * FROM account_deletion_requests WHERE id='erase_account_qa'").get();
 assert.ok(state.storage_erased_at);assert.equal(state.database_erased_at,null);assert.equal(state.status,"queued");
 f.inject(-1);f.retry();f.restart();tick=await f.call({action:"erasure-tick",limit:1});assert.equal(tick.completed,1);
 assert.equal(f.primary.prepare("SELECT status FROM account_deletion_requests WHERE id='erase_account_qa'").get().status,"completed");
 assert.equal(f.primary.prepare("SELECT id FROM products WHERE id='prd_qa_private'").get(),undefined);
 assert.equal(f.primary.prepare("SELECT id FROM editions WHERE id='ed_qa_private'").get(),undefined);
 assert.ok(f.primary.prepare("SELECT id FROM products WHERE id='prd_qa_other'").get());
 assert.ok(f.primary.prepare("SELECT id FROM products WHERE id='prd_qa_public'").get());
 const deleteCount=f.deletes();assert.equal((await f.call({action:"erasure-tick",limit:1})).processed,0);assert.equal(f.deletes(),deleteCount);
 // Independent legal holds prevent irreversible disablement or deletion.
 const held=fixture();held.queue();held.primary.prepare("INSERT INTO staff_principals(user_id,status,created_at,updated_at) VALUES(?,'active',?,?)").run(held.user,held.at,held.at);
 assert.equal((await held.call({action:"erasure-tick",limit:1})).blocked,1);
 assert.equal(held.primary.prepare("SELECT disabled_at FROM auth_accounts WHERE app_id=?").get(held.user).disabled_at,null);
 assert.equal(held.durable.prepare("SELECT COUNT(*) n FROM cove_account_access_denials").get().n,0);
 // Provider failure cannot fake completion or erase the account's veto.
 const provider=fixture();provider.queue();provider.env.FORE_AUTH_MODE="supabase";provider.env.SUPABASE_URL="https://identity.test";provider.env.SUPABASE_SECRET_KEY="sb_secret_fixture_not_real";
 let outage=true,calls=0;globalThis.fetch=async (request,options)=>{calls++;assert.match(String(request),/^https:\/\/identity\.test\/auth\/v1\/admin\/users\//);if(outage)return new Response(null,{status:503});return options?.method==="DELETE"?new Response(null,{status:204}):Response.json({code:"user_not_found"},{status:404});};
 tick=await provider.call({action:"erasure-tick",limit:1});assert.equal(tick.retrying,1);
 state=provider.primary.prepare("SELECT * FROM account_deletion_requests WHERE id='erase_account_qa'").get();assert.ok(state.database_erased_at);assert.equal(state.identity_erased_at,null);
 outage=false;provider.retry();provider.restart();assert.equal((await provider.call({action:"erasure-tick",limit:1})).completed,1);assert.equal(calls,3);
 const concurrent=fixture();concurrent.queue();
 const originalList=concurrent.env.BUCKET.list;
 let entered,release;const arrived=new Promise(r=>{entered=r;}),gate=new Promise(r=>{release=r;});
 concurrent.env.BUCKET.list=async x=>{entered();await gate;return originalList(x);};
 const running=concurrent.request({action:"erasure-tick",limit:1});await arrived;
 const deferred=await concurrent.request({action:"erasure-tick",limit:1});assert.equal(deferred.status,200);assert.equal((await deferred.json()).result.processed,0);
 release();assert.equal((await running).status,200);
 assert.equal(concurrent.primary.prepare("SELECT attempts FROM account_deletion_requests WHERE id='erase_account_qa'").get().attempts,1);
 const sb="sb:00000000-0000-4000-8000-000000000001";
 concurrent.primary.prepare("INSERT INTO auth_accounts(provider_id,app_id,email,created_at) VALUES(?,?,?,?)").run(sb.slice(3),sb,"sb@test.invalid",concurrent.at);
 assert.ok((await concurrent.call({action:"register-device",userId:sb,device})).id);
 const fk=fixture();fk.primary.exec("PRAGMA foreign_keys=ON");fk.queue();
 fk.primary.prepare("INSERT INTO works(id,title,created_at,updated_at) VALUES('work_fk','Private',?,?)").run(fk.at,fk.at);
 fk.primary.prepare("INSERT INTO editions(id,work_id,title,release_status,created_at,updated_at) VALUES('ed_fk','work_fk','Private','private',?,?)").run(fk.at,fk.at);
 fk.primary.prepare("INSERT INTO products(id,edition_id,sku,format,source_name,source_external_id,created_at,updated_at) VALUES('prd_fk','ed_fk','sku_fk','ebook','upload','upload_fk',?,?)").run(fk.at,fk.at);
 fk.primary.prepare("INSERT INTO personal_imports(id,user_id,product_id,object_key,created_at) VALUES('import_fk',?,'prd_fk',?,?)").run(fk.user,`uploads/${fk.user}/private.epub`,fk.at);
 assert.equal((await fk.call({action:"erasure-tick",limit:1})).completed,1);
 assert.equal(fk.primary.prepare("SELECT id FROM products WHERE id='prd_fk'").get(),undefined);
 assert.equal(fk.primary.prepare("PRAGMA foreign_key_check").all().length,0);
 provider.env.COVE_RIGHTS_OWNER_ENABLED="0";assert.equal((await provider.request({action:"erasure-tick",limit:1})).status,503);
 console.log("PASS: private account owner scopes buyer/device, atomically revokes with lost-ACK recovery, preserves terminal keys, legal holds, durable account access denial, checkpointed R2/DB/provider erasure and restart recovery");
}finally{globalThis.fetch=oldFetch;for(const db of stores)db.close();rmSync(folder,{recursive:true,force:true});}
