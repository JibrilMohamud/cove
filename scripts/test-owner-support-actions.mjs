/* eslint-disable prettier/prettier -- Exercise the actual private owner under disposable SQLite. */
import assert from "node:assert/strict";
import {DatabaseSync} from "node:sqlite";
import {build} from "esbuild";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {pathToFileURL} from "node:url";
import {createHash} from "node:crypto";
const folder=mkdtempSync(join(tmpdir(),"cove-support-owner-"));
const primary=new DatabaseSync(":memory:"),durable=new DatabaseSync(":memory:");
try{
 const outfile=join(folder,"owner.mjs");
 await build({entryPoints:["src/storefront-strangler/legal-authority.worker.ts"],
   bundle:true,platform:"node",format:"esm",target:"node22",outfile,logLevel:"silent",
   plugins:[{name:"mock-cloudflare-host",setup(b){
     b.onResolve({filter:/^cloudflare:workers$/},()=>({path:"host",namespace:"host"}));
     b.onLoad({filter:/.*/,namespace:"host"},()=>({contents:
       "export class DurableObject {constructor(ctx,env){this.ctx=ctx;this.env=env;}}" }));
   }}]});
 const {CoveLegalAuthority}=await import(pathToFileURL(outfile).href);
 for(const sql of [
   "CREATE TABLE staff_principals(user_id TEXT PRIMARY KEY,status TEXT)",
   "CREATE TABLE staff_principal_roles(user_id TEXT,role_id TEXT)",
   "CREATE TABLE staff_role_permissions(role_id TEXT,permission TEXT)",
   "CREATE TABLE support_cases(id TEXT PRIMARY KEY,user_id TEXT,order_id TEXT,product_id TEXT,publisher_account_id TEXT,updated_at TEXT)",
   "CREATE TABLE support_actions(id TEXT PRIMARY KEY,case_id TEXT,staff_user_id TEXT,action_type TEXT,target_type TEXT,target_id TEXT,reason_code TEXT,rationale TEXT,idempotency_key TEXT UNIQUE,before_json TEXT,after_json TEXT,provider_reference TEXT,created_at TEXT)",
   "CREATE TABLE support_case_events(id TEXT PRIMARY KEY,case_id TEXT,event_type TEXT,staff_user_id TEXT,note TEXT,event_json TEXT,created_at TEXT)",
   "CREATE TABLE commerce_orders(id TEXT PRIMARY KEY,user_id TEXT,invoice_number TEXT,receipt_url TEXT,status TEXT)",
   "CREATE TABLE commerce_notifications(id TEXT PRIMARY KEY,user_id TEXT,notification_type TEXT,dedupe_key TEXT UNIQUE,title TEXT,body TEXT,payload_json TEXT,created_at TEXT)",
   "CREATE TABLE publishing_outbox(id TEXT PRIMARY KEY,event_type TEXT,aggregate_type TEXT,aggregate_id TEXT,payload_json TEXT,status TEXT,available_at TEXT,created_at TEXT)",
   "CREATE TABLE entitlements(id TEXT PRIMARY KEY,user_id TEXT,product_id TEXT,status TEXT,updated_at TEXT)",
   "CREATE TABLE audio_offline_licenses(id TEXT PRIMARY KEY,entitlement_id TEXT,device_id TEXT,status TEXT,revoked_at TEXT,revocation_reason TEXT)"
 ])primary.exec(sql);
 const staff="staff_support_qa",alien="staff_unpriv_qa",buyer="buyer_support_qa",order="ord_support_qa";
 primary.prepare("INSERT INTO staff_principals VALUES(?,'active')").run(staff);
 primary.prepare("INSERT INTO staff_principals VALUES(?,'active')").run(alien);
 primary.prepare("INSERT INTO staff_principal_roles VALUES(?,'support')").run(staff);
 for(const permission of ["support.receipt.resend","support.entitlement.manage","support.device.manage","support.publication.manage","support.refund","support.case.manage"])
   primary.prepare("INSERT INTO staff_role_permissions VALUES('support',?)").run(permission);
 primary.prepare("INSERT INTO support_cases VALUES('case_qa',?,?,'prd_commercial_qa',NULL,'')").run(buyer,order);
 primary.prepare("INSERT INTO commerce_orders VALUES(?,?,'COVE-123','https://receipts.example/123','paid')").run(order,buyer);
 primary.prepare("INSERT INTO entitlements VALUES('ent_support_qa',?,'prd_commercial_qa','active','')").run(buyer);
 primary.prepare("INSERT INTO audio_offline_licenses VALUES('lic_qa','ent_support_qa','device_qa','active',NULL,NULL)").run();
 const db={
   prepare(statement){return {bind(...args){return {
     async first(){return primary.prepare(statement).get(...args)||null;},
     async all(){return {results:primary.prepare(statement).all(...args)};},
     async run(){return {meta:{changes:primary.prepare(statement).run(...args).changes}};},
     executeForBatch(){return primary.prepare(statement).run(...args);}
   }};}},
   async batch(statements){primary.exec("BEGIN");try{
     for(const stmt of statements)stmt.executeForBatch();
     primary.exec("COMMIT");
   }catch(e){primary.exec("ROLLBACK");throw e;}}
 };
 const sql={exec(text,...args){const stmt=durable.prepare(text);
   const rows=stmt.columns().length?stmt.all(...args):(stmt.run(...args),[]);
   return {toArray:()=>rows};
 }};
 const secret="c".repeat(64),env={PRIMARY_DB:db,COVE_RIGHTS_OWNER_ENABLED:"1",
  COVE_RIGHTS_OWNER_PRIMARY_ID:"7c7ab994-f6b3-419d-a72d-71eb9ea22e7e",
  COVE_RIGHTS_OWNER_TEST_EXPIRES_AT:String(Date.now()+600000),
  COVE_RIGHTS_OWNER_SECRET:secret};
 const owner=new CoveLegalAuthority({storage:{sql,transactionSync(fn){return fn();}}},env);
 const operationId=k=>"support:"+createHash("sha256").update(k).digest("hex");
 const base={caseId:"case_qa",actionType:"resend_receipt",targetId:order,reasonCode:"customer_requested",
   rationale:"Customer requested another original order receipt",idempotencyKey:"receipt-support-qa-1111111111"};
 const send=(action=base,actor=staff,key=secret)=>owner.fetch(new Request("https://legal-authority.internal/support/private-action",{
   method:"POST",headers:{"authorization":"Bearer "+key,"content-type":"application/json"},
   body:JSON.stringify({staffUserId:actor,operationId:operationId(action.idempotencyKey),action})
 }));
 const count=table=>Number(primary.prepare("SELECT COUNT(*) n FROM "+table).get().n);
 assert.equal((await send(base,alien)).status,403);
 assert.equal((await send(base,staff,"f".repeat(64))).status,401);
 assert.equal(count("publishing_outbox"),0);
 let response=await send();assert.equal(response.status,200,await response.text());
 let ack=await response.json();assert.equal(ack.ownerFirst,true);
 assert.equal(count("commerce_notifications"),1);assert.equal(count("publishing_outbox"),1);
 assert.equal(count("support_actions"),1);
 response=await send();assert.equal(response.status,200);
 assert.equal(count("commerce_notifications"),1);assert.equal(count("publishing_outbox"),1);
 assert.equal(count("support_actions"),1,"same operation may not duplicate action audit");
 const wrong={...base,targetId:"ord_different",idempotencyKey:"receipt-support-qa-2222222222"};
 assert.equal((await send(wrong)).status,503);
 assert.equal(count("publishing_outbox"),1);
 assert.equal((await send({...base,targetId:"ord_different"})).status,409,"idempotency cannot target another record");
 assert.equal((await send({...base,actionType:"refund",idempotencyKey:"refund-support-qa-3333333333"})).status,503);
 assert.equal((await send({...base,actionType:"restore_entitlement",targetId:"ent_support_qa",
   idempotencyKey:"restore-support-qa-4444444444"})).status,503);
 assert.equal(primary.prepare("SELECT status FROM entitlements WHERE id='ent_support_qa'").get().status,"active");
 const revoke={...base,actionType:"revoke_entitlement",targetId:"ent_support_qa",idempotencyKey:"revoke-support-qa-5555555555"};
 response=await send(revoke);assert.equal(response.status,200,await response.text());
 assert.equal(primary.prepare("SELECT status FROM entitlements WHERE id='ent_support_qa'").get().status,"revoked");
 assert.equal(primary.prepare("SELECT status FROM audio_offline_licenses WHERE id='lic_qa'").get().status,"revoked");
 assert.equal(durable.prepare("SELECT verdict FROM cove_paid_entitlement_authority WHERE entitlement_id='ent_support_qa'").get().verdict,"deny");
 response=await send(revoke);assert.equal(response.status,200);
 assert.equal(count("support_actions"),2);
 env.COVE_RIGHTS_OWNER_ENABLED="0";
 assert.equal((await send({...base,idempotencyKey:"receipt-support-qa-6666666666"})).status,503);
 console.log("PASS: real QA owner refuses unauthorized and positive actions; negative owner epoch, replay and lease lock verified");
} finally {primary.close();durable.close();rmSync(folder,{recursive:true,force:true});}
