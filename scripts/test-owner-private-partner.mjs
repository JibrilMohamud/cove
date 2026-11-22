/* eslint-disable prettier/prettier -- Actual QA owner execution against SQLite, with no public D1 fallback. */
import assert from "node:assert/strict";
import {DatabaseSync} from "node:sqlite";
import {build} from "esbuild";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {pathToFileURL} from "node:url";
const tmp=mkdtempSync(join(tmpdir(),"cove-partner-owner-"));
const sqlite=new DatabaseSync(":memory:"),durable=new DatabaseSync(":memory:");
try{
 const outfile=join(tmp,"owner.mjs");
 await build({entryPoints:["src/storefront-strangler/legal-authority.worker.ts"],
  bundle:true,platform:"node",format:"esm",target:"node22",outfile,logLevel:"silent",
  plugins:[{name:"fake-worker",setup(b){
   b.onResolve({filter:/^cloudflare:workers$/},()=>({path:"host",namespace:"host"}));
   b.onLoad({filter:/.*/,namespace:"host"},()=>({contents:
    "export class DurableObject {constructor(ctx,env){this.ctx=ctx;this.env=env;}}"}));
  }}]});
 const {CoveLegalAuthority}=await import(pathToFileURL(outfile).href);
 for(const sql of [
  "CREATE TABLE staff_principals(user_id TEXT PRIMARY KEY,status TEXT)",
  "CREATE TABLE staff_principal_roles(user_id TEXT,role_id TEXT)",
  "CREATE TABLE staff_role_permissions(role_id TEXT,permission TEXT)",
  "CREATE TABLE auth_accounts(app_id TEXT PRIMARY KEY)",
  "CREATE TABLE publishing_accounts(id TEXT PRIMARY KEY,status TEXT)",
  "CREATE TABLE publishing_account_members(account_id TEXT,user_id TEXT,role TEXT,status TEXT)",
  "CREATE TABLE publisher_partner_profiles(account_id TEXT PRIMARY KEY,production_status TEXT,partner_code TEXT,updated_at TEXT,sandbox_enabled INTEGER)",
  "CREATE TABLE publisher_partner_credentials(id TEXT PRIMARY KEY,account_id TEXT,environment TEXT,status TEXT,revoked_at TEXT)",
  "CREATE TABLE publisher_partner_audit_events(id TEXT PRIMARY KEY,account_id TEXT,environment TEXT,actor_type TEXT,actor_id TEXT,event_type TEXT,subject_type TEXT,subject_id TEXT,event_json TEXT,created_at TEXT)"
 ])sqlite.exec(sql);
 const staff="staff_partner_qa",user="user_partner_qa";
 sqlite.prepare("INSERT INTO staff_principals VALUES(?,'active')").run(staff);
 sqlite.prepare("INSERT INTO staff_principal_roles VALUES(?,'role_partner')").run(staff);
 sqlite.prepare("INSERT INTO staff_role_permissions VALUES('role_partner','publishing.partner.manage')").run();
 sqlite.prepare("INSERT INTO auth_accounts VALUES(?)").run(user);
 sqlite.prepare("INSERT INTO publishing_accounts VALUES('acct_partner_qa','active')").run();
 sqlite.prepare("INSERT INTO publishing_account_members VALUES('acct_partner_qa',?,'admin','active')").run(user);
 sqlite.prepare("INSERT INTO publisher_partner_profiles VALUES('acct_partner_qa','active','PQA','',1)").run();
 sqlite.prepare("INSERT INTO publisher_partner_credentials VALUES('cred_live','acct_partner_qa','production','active',NULL)").run();
 sqlite.prepare("INSERT INTO publisher_partner_credentials VALUES('cred_test','acct_partner_qa','sandbox','active',NULL)").run();
 const db={prepare(statement){return {
   bind(...params){return {
     async first(){return sqlite.prepare(statement).get(...params)||null;},
     async all(){return {results:sqlite.prepare(statement).all(...params)};},
     async run(){return {meta:{changes:sqlite.prepare(statement).run(...params).changes}};},
     executeForBatch(){return sqlite.prepare(statement).run(...params);}
   };},
   async first(){return sqlite.prepare(statement).get()||null;},
   async all(){return {results:sqlite.prepare(statement).all()};},
   async run(){return {meta:{changes:sqlite.prepare(statement).run().changes}};}
 };},async batch(statements){
   sqlite.exec("BEGIN");try{for(const st of statements)st.executeForBatch();sqlite.exec("COMMIT");}
   catch(e){sqlite.exec("ROLLBACK");throw e;}
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
  "https://legal-authority.internal/publishing/partner/private-action",{
   method:"POST",headers:{"authorization":"Bearer "+key,"content-type":"application/json"},
   body:JSON.stringify({action,operationId:"partner:"+crypto.randomUUID(),payload})
 }));
 const status=()=>sqlite.prepare("SELECT production_status FROM publisher_partner_profiles WHERE account_id='acct_partner_qa'").get().production_status;
 const credential=id=>sqlite.prepare("SELECT status FROM publisher_partner_credentials WHERE id=?").get(id).status;
 const count=()=>Number(sqlite.prepare("SELECT count(*) n FROM publisher_partner_audit_events").get().n);
 assert.equal((await send("certify",{actorUserId:staff,raw:{accountId:"acct_partner_qa",productionStatus:"paused",reason:"QA pause"}},"a".repeat(64))).status,401);
 assert.equal((await send("certify",{actorUserId:user,raw:{accountId:"acct_partner_qa",productionStatus:"paused",reason:"QA pause"}})).status,403);
 assert.equal((await send("certify",{actorUserId:staff,raw:{accountId:"acct_partner_qa",productionStatus:"active",reason:"Unsafe activate"}})).status,409);
 for(const action of ["issue-credential","assign-contract","reconcile-public-domain","submit-feed","asset-expectations","upload-asset"])
   assert.equal((await send(action,{actorUserId:staff,raw:{accountId:"acct_partner_qa"}})).status,409,action+" must fail closed");
 assert.equal(status(),"active");assert.equal(count(),0);
 let response=await send("certify",{actorUserId:staff,raw:{accountId:"acct_partner_qa",productionStatus:"paused",reason:"Evidence pending"}});
 if(response.status!==200)throw Error("Private partner pause returned "+response.status);
 let receipt=await response.json();
 assert.equal(receipt.schema,"cove.private-partner-negative-qa.v1");
 assert.equal(receipt.ownerFirst,true);assert.equal(receipt.result.to,"paused");
 assert.equal(status(),"paused");
 assert.equal(credential("cred_live"),"revoked");
 assert.equal(credential("cred_test"),"active","Production pause must not revoke sandbox credential by accident");
 assert.equal(count(),1);
 response=await send("revoke-credential",{actorUserId:user,raw:{accountId:"acct_partner_qa",credentialId:"cred_test"}});
 if(response.status!==200)throw Error("Private partner revoke returned "+response.status);
 receipt=await response.json();assert.equal(receipt.result.revoked,true);
 assert.equal(credential("cred_test"),"revoked");
 assert.equal(count(),2);
 env.COVE_RIGHTS_OWNER_ENABLED="0";
 assert.equal((await send("certify",{actorUserId:staff,raw:{accountId:"acct_partner_qa",productionStatus:"terminated",reason:"QA termination"}})).status,503);
 assert.equal(status(),"paused");
 console.log("PASS: independent staff permission and account role; partner pause/revoke deny before positives; R2/feed and live certification fail closed");
}finally{sqlite.close();durable.close();rmSync(tmp,{recursive:true,force:true});}
