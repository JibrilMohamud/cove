/* eslint-disable prettier/prettier -- Execute the actual isolated QA preorder owner against SQLite. */
import assert from "node:assert/strict";
import {DatabaseSync} from "node:sqlite";
import {build} from "esbuild";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {pathToFileURL} from "node:url";
const folder=mkdtempSync(join(tmpdir(),"cove-preorder-qa-"));
const primary=new DatabaseSync(":memory:"),durable=new DatabaseSync(":memory:");
try{
 const outfile=join(folder,"owner.mjs");
 await build({entryPoints:["src/storefront-strangler/legal-authority.worker.ts"],
  bundle:true,platform:"node",format:"esm",target:"node22",outfile,logLevel:"silent",
  plugins:[{name:"fake-cloudflare-worker",setup(b){
   b.onResolve({filter:/^cloudflare:workers$/},()=>({path:"host",namespace:"host"}));
   b.onLoad({filter:/.*/,namespace:"host"},()=>({contents:
    "export class DurableObject {constructor(ctx,env){this.ctx=ctx;this.env=env;}}"}));
  }}]});
 const {CoveLegalAuthority}=await import(pathToFileURL(outfile).href);
 for(const sql of [
  "CREATE TABLE preorder_release_plans(id TEXT PRIMARY KEY,release_at TEXT,opens_at TEXT,manuscript_deadline_at TEXT,cancellation_policy TEXT,status TEXT,updated_at TEXT)",
  "CREATE TABLE preorders(id TEXT PRIMARY KEY,release_plan_id TEXT,order_id TEXT,user_id TEXT,product_id TEXT,currency TEXT,guaranteed_price_minor INTEGER,status TEXT,canceled_at TEXT,updated_at TEXT)",
  "CREATE TABLE preorder_refund_jobs(id TEXT PRIMARY KEY,preorder_id TEXT,order_id TEXT,amount_minor INTEGER,currency TEXT,reason TEXT,status TEXT,attempt_count INTEGER,created_at TEXT,updated_at TEXT,lease_token TEXT,lease_expires_at TEXT,last_error TEXT,provider_refund_id TEXT)",
  "CREATE TABLE preorder_events(id TEXT PRIMARY KEY,preorder_id TEXT,event_type TEXT,actor_type TEXT,actor_id TEXT,event_json TEXT,created_at TEXT)"
 ])primary.exec(sql);
 const future=new Date(Date.now()+30*86400000).toISOString(),due=new Date(Date.now()-3600000).toISOString();
 primary.prepare("INSERT INTO preorder_release_plans(id,release_at,opens_at,manuscript_deadline_at,cancellation_policy,status,updated_at) VALUES('plan_qa',?,'2000-01-01T00:00:00Z',?,'customer_until_release','open','')").run(future,future);
 primary.prepare("INSERT INTO preorders VALUES('po_qa','plan_qa','order_qa','buyer_qa','prd_commercial_qa','USD',3000,'paid_pending_release',NULL,'')").run();
 const db={prepare(stmt){return {bind(...args){return {
  async first(){return primary.prepare(stmt).get(...args)||null;},
  async all(){return {results:primary.prepare(stmt).all(...args)};},
  async run(){return {meta:{changes:primary.prepare(stmt).run(...args).changes}};},
  executeForBatch(){return primary.prepare(stmt).run(...args);}
 }},async first(){return primary.prepare(stmt).get()||null;},
 async all(){return {results:primary.prepare(stmt).all()};},
 async run(){return {meta:{changes:primary.prepare(stmt).run().changes}};}};},
 async batch(stmts){primary.exec("BEGIN");try{
   for(const stmt of stmts)stmt.executeForBatch();
   primary.exec("COMMIT");
 }catch(e){primary.exec("ROLLBACK");throw e;}}};
 const sql={exec(text,...args){const q=durable.prepare(text);
   const rows=q.columns().length?q.all(...args):(q.run(...args),[]);
   return {toArray:()=>rows};}};
 const secret="a".repeat(64),env={PRIMARY_DB:db,
   COVE_RIGHTS_OWNER_ENABLED:"1",
   COVE_RIGHTS_OWNER_PRIMARY_ID:"7c7ab994-f6b3-419d-a72d-71eb9ea22e7e",
   COVE_RIGHTS_OWNER_TEST_EXPIRES_AT:String(Date.now()+600000),
   COVE_RIGHTS_OWNER_SECRET:secret};
 const owner=new CoveLegalAuthority({storage:{sql,transactionSync(fn){return fn();}}},env);
 const send=(action,payload={},key=secret)=>owner.fetch(new Request(
   "https://legal-authority.internal/preorder/private-action",{
   method:"POST",headers:{"authorization":"Bearer "+key,"content-type":"application/json"},
   body:JSON.stringify({action,payload,operationId:"preorder:"+crypto.randomUUID()})
 }));
 const count=t=>Number(primary.prepare("SELECT count(*) n FROM "+t).get().n);
 assert.equal((await send("advance",{},"b".repeat(64))).status,401);
 assert.equal((await send("register-paid",{input:{orderId:"order_qa"}})).status,409);
 assert.equal((await send("complete-refund",{input:{jobId:"job_qa",leaseToken:"token_qa",success:true}})).status,409);
 assert.equal((await send("customer-cancel",{userId:"intruder_qa",preorderId:"po_qa"})).status,503);
 assert.equal(count("preorder_refund_jobs"),0);
 let response=await send("customer-cancel",{userId:"buyer_qa",preorderId:"po_qa"});
 if(response.status!==200)throw Error("QA preorder cancellation returned "+response.status);
 const receipt=await response.json();
 assert.equal(receipt.ownerFirst,true);
 assert.equal(receipt.action,"customer-cancel");
 assert.equal(receipt.result.status,"cancellation_requested");
 assert.equal(primary.prepare("SELECT status FROM preorders WHERE id='po_qa'").get().status,"cancellation_requested");
 assert.equal(count("preorder_refund_jobs"),1);
 assert.equal(count("preorder_events"),1);
 assert.equal((await send("customer-cancel",{userId:"buyer_qa",preorderId:"po_qa"})).status,503);
 assert.equal(count("preorder_refund_jobs"),1,"cancellation replay must not create duplicate refund jobs");
 response=await send("lease-refunds",{input:{workerId:"refund_qa",limit:1}});
 if(response.status!==200)throw Error("QA refund lease returned "+response.status);
 const job=(await response.json()).result.jobs[0];
 assert.ok(job?.lease_token);
 assert.equal((await send("complete-refund",{input:{
   jobId:job.id,leaseToken:job.lease_token,success:true,providerRefundId:"re_unverified"
 }})).status,409);
 assert.equal(primary.prepare("SELECT status FROM preorder_refund_jobs WHERE id=?").get(job.id).status,"leased");
 response=await send("complete-refund",{input:{
   jobId:job.id,leaseToken:job.lease_token,success:false,error:"provider pending"
 }});
 if(response.status!==200)throw Error("QA refund failure returned "+response.status);
 assert.equal(primary.prepare("SELECT status FROM preorder_refund_jobs WHERE id=?").get(job.id).status,"queued");
 primary.prepare("INSERT INTO preorder_release_plans VALUES('plan_due',?,'2000-01-01T00:00:00Z',?,'customer_until_release','open','')").run(due,due);
 primary.prepare("INSERT INTO preorders VALUES('po_due','plan_due','order_due','buyer_due','prd_commercial_due','USD',2200,'paid_pending_release',NULL,'')").run();
 response=await send("advance",{});
 assert.equal(response.status,503,"owner refuses to release any due paid preorder without independent proof");
 assert.equal(primary.prepare("SELECT status FROM preorder_release_plans WHERE id='plan_due'").get().status,"open");
 assert.equal(primary.prepare("SELECT status FROM preorders WHERE id='po_due'").get().status,"paid_pending_release");
 env.COVE_RIGHTS_OWNER_ENABLED="0";
 assert.equal((await send("customer-cancel",{userId:"buyer_due",preorderId:"po_due"})).status,503);
 console.log("PASS: private QA preorder owner verifies contract, denies forged provider success and paid releases, preserves cancellation scope/retry and owner lease lock");
}finally{primary.close();durable.close();rmSync(folder,{recursive:true,force:true});}
