/* eslint-disable prettier/prettier -- Actual isolated SQL-backed private copyright command tests. */
import assert from "node:assert/strict";
import {DatabaseSync} from "node:sqlite";
import {build} from "esbuild";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {pathToFileURL} from "node:url";
const tmp=mkdtempSync(join(tmpdir(),"cove-trust-owner-"));
const dbSql=new DatabaseSync(":memory:"),durable=new DatabaseSync(":memory:");
try{
 const outfile=join(tmp,"owner.mjs");
 await build({entryPoints:["src/storefront-strangler/legal-authority.worker.ts"],
  bundle:true,platform:"node",format:"esm",target:"node22",outfile,logLevel:"silent",
  plugins:[{name:"mock-worker",setup(b){
   b.onResolve({filter:/^cloudflare:workers$/},()=>({path:"host",namespace:"host"}));
   b.onLoad({filter:/.*/,namespace:"host"},()=>({contents:
     "export class DurableObject {constructor(ctx,env){this.ctx=ctx;this.env=env;}}"}));
  }}]});
 const {CoveLegalAuthority}=await import(pathToFileURL(outfile).href);
 for(const sql of [
  "CREATE TABLE staff_principals(user_id TEXT PRIMARY KEY,status TEXT)",
  "CREATE TABLE staff_principal_roles(user_id TEXT,role_id TEXT)",
  "CREATE TABLE staff_role_permissions(role_id TEXT,permission TEXT)",
  "CREATE TABLE publishing_rights_evidence(id TEXT PRIMARY KEY,account_id TEXT,scan_status TEXT,verification_status TEXT)",
  "CREATE TABLE publishing_audit_events(id TEXT PRIMARY KEY,account_id TEXT,actor_user_id TEXT,entity_type TEXT,entity_id TEXT,action TEXT,metadata_json TEXT,created_at TEXT)"
 ])dbSql.exec(sql);
 const reviewer="staff_rights_qa",intruder="staff_unprivileged_qa";
 dbSql.prepare("INSERT INTO staff_principals VALUES(?,'active')").run(reviewer);
 dbSql.prepare("INSERT INTO staff_principals VALUES(?,'active')").run(intruder);
 dbSql.prepare("INSERT INTO staff_principal_roles VALUES(?,'reviewer')").run(reviewer);
 dbSql.prepare("INSERT INTO staff_role_permissions VALUES('reviewer','publishing.review')").run();
 dbSql.prepare("INSERT INTO staff_role_permissions VALUES('reviewer','moderation.copyright.manage')").run();
 dbSql.prepare("INSERT INTO publishing_rights_evidence VALUES('evidence_rights_qa','pubacct_rights_qa','clean','pending')").run();
 const db={prepare(stmt){return {
  bind(...args){return {
    async first(){return dbSql.prepare(stmt).get(...args)||null;},
    async all(){return {results:dbSql.prepare(stmt).all(...args)};},
    async run(){return {meta:{changes:dbSql.prepare(stmt).run(...args).changes}};},
    executeForBatch(){return dbSql.prepare(stmt).run(...args);}
  };},
  async first(){return dbSql.prepare(stmt).get()||null;},
  async all(){return {results:dbSql.prepare(stmt).all()};},
  async run(){return {meta:{changes:dbSql.prepare(stmt).run().changes}};}
 };},async batch(statements){
  dbSql.exec("BEGIN");try{for(const stmt of statements)stmt.executeForBatch();dbSql.exec("COMMIT");}
  catch(e){dbSql.exec("ROLLBACK");throw e;}
 }};
 const sql={exec(statement,...args){
  const st=durable.prepare(statement),rows=st.columns().length?st.all(...args):(st.run(...args),[]);
  return {toArray:()=>rows};
 }};
 const secret="c".repeat(64),env={PRIMARY_DB:db,COVE_RIGHTS_OWNER_ENABLED:"1",
  COVE_RIGHTS_OWNER_PRIMARY_ID:"7c7ab994-f6b3-419d-a72d-71eb9ea22e7e",
  COVE_RIGHTS_OWNER_TEST_EXPIRES_AT:String(Date.now()+600000),COVE_RIGHTS_OWNER_SECRET:secret};
 const owner=new CoveLegalAuthority({storage:{sql,transactionSync(fn){return fn();}}},env);
 const send=(action,payload={},key=secret)=>owner.fetch(new Request(
  "https://legal-authority.internal/trust/private-action",{
  method:"POST",headers:{authorization:"Bearer "+key,"content-type":"application/json"},
  body:JSON.stringify({action,operationId:"trust:"+crypto.randomUUID(),payload})
 }));
 const staff=raw=>({actorUserId:reviewer,raw});
 const count=table=>Number(dbSql.prepare("SELECT count(*) n FROM "+table).get().n);
 assert.equal((await send("review-evidence",staff({evidenceId:"evidence_rights_qa",status:"rejected"}),"d".repeat(64))).status,401);
 assert.equal((await send("review-evidence",{actorUserId:intruder,raw:{evidenceId:"evidence_rights_qa",status:"rejected"}})).status,403);
 assert.equal((await send("sign-rights",{actorUserId:"publisher_qa",raw:{}})).status,409);
 assert.equal((await send("review-evidence",staff({evidenceId:"evidence_rights_qa",status:"verified"}))).status,409);
 assert.equal((await send("validate-notice",staff({disputeId:"dispute_qa",decision:"compliant_takedown"}))).status,409);
 assert.equal((await send("validate-counter",staff({counterNoticeId:"counter_qa",decision:"compliant_forward"}))).status,409);
 assert.equal((await send("court-action",staff({disputeId:"dispute_qa"}))).status,409);
 assert.equal((await send("repeat-policy",staff({accountId:"pubacct_rights_qa",action:"overturn_incident"}))).status,409);
 assert.equal((await send("resolve-dispute",staff({disputeId:"dispute_qa",restoreContent:true,resolutionCode:"no_infringement"}))).status,409);
 assert.equal((await send("resolve-dispute",staff({disputeId:"dispute_qa",royaltyDisposition:"release",resolutionCode:"claimant_withdrawn"}))).status,409);
 assert.equal(count("publishing_audit_events"),0);
 let response=await send("review-evidence",staff({evidenceId:"evidence_rights_qa",status:"rejected"}));
 if(response.status!==200)throw Error("QA negative evidence review status="+response.status);
 const receipt=await response.json();
 assert.equal(receipt.schema,"cove.owner-trust-negative.v1");
 assert.equal(receipt.ownerFirst,true);
 assert.equal(receipt.result.status,"rejected");
 assert.equal(dbSql.prepare("SELECT verification_status FROM publishing_rights_evidence WHERE id='evidence_rights_qa'").get().verification_status,"rejected");
 assert.equal(count("publishing_audit_events"),1);
 env.COVE_RIGHTS_OWNER_ENABLED="0";
 assert.equal((await send("review-evidence",staff({evidenceId:"evidence_rights_qa",status:"verified"}))).status,503);
 console.log("PASS: independent staff permission, 38-site private trust boundary, negative evidence review and all uncertified positive actions fail closed");
}finally{dbSql.close();durable.close();rmSync(tmp,{recursive:true,force:true});}
