/* eslint-disable prettier/prettier -- Exercise actual private publishing owner with SQLite and adversarial QA actors. */
import assert from "node:assert/strict";
import {DatabaseSync} from "node:sqlite";
import {build} from "esbuild";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {pathToFileURL} from "node:url";
const folder=mkdtempSync(join(tmpdir(),"cove-publisher-qa-")),
 primary=new DatabaseSync(":memory:"),durable=new DatabaseSync(":memory:");
try{
 const outfile=join(folder,"owner.mjs");
 await build({entryPoints:["src/storefront-strangler/legal-authority.worker.ts"],
 bundle:true,platform:"node",format:"esm",target:"node22",outfile,logLevel:"silent",
 plugins:[{name:"fake-worker-module",setup(b){
  b.onResolve({filter:/^cloudflare:workers$/},()=>({path:"host",namespace:"host"}));
  b.onLoad({filter:/.*/,namespace:"host"},()=>({contents:
   "export class DurableObject {constructor(ctx,env){this.ctx=ctx;this.env=env;}}"}));
 }}]});
 const {CoveLegalAuthority}=await import(pathToFileURL(outfile).href);
 for(const sql of [
  "CREATE TABLE auth_accounts(app_id TEXT PRIMARY KEY)",
  "CREATE TABLE staff_principals(user_id TEXT PRIMARY KEY,status TEXT)",
  "CREATE TABLE staff_principal_roles(user_id TEXT,role_id TEXT)",
  "CREATE TABLE staff_role_permissions(role_id TEXT,permission TEXT)",
  "CREATE TABLE publishing_account_members(account_id TEXT,user_id TEXT,role TEXT,status TEXT,invited_email TEXT,invited_by_user_id TEXT,created_at TEXT,updated_at TEXT)",
  "CREATE TABLE publishing_audit_events(id TEXT PRIMARY KEY,account_id TEXT,actor_user_id TEXT,entity_type TEXT,entity_id TEXT,action TEXT,metadata_json TEXT,created_at TEXT)"
 ])primary.exec(sql);
 const staff="staff_editor_qa",publisher="publisher_owner_qa",outsider="publisher_intruder_qa",account="pubacct_owner_qa";
 primary.prepare("INSERT INTO auth_accounts VALUES(?)").run(publisher);
 primary.prepare("INSERT INTO auth_accounts VALUES(?)").run(outsider);
 primary.prepare("INSERT INTO publishing_account_members(account_id,user_id,role,status) VALUES(?,?,'owner','active')").run(account,publisher);
 primary.prepare("INSERT INTO staff_principals VALUES(?,'active')").run(staff);
 const db={prepare(stmt){return {
   bind(...args){return {
     async first(){return primary.prepare(stmt).get(...args)||null;},
     async all(){return {results:primary.prepare(stmt).all(...args)};},
     async run(){return {meta:{changes:primary.prepare(stmt).run(...args).changes}};},
     executeForBatch(){return primary.prepare(stmt).run(...args);}
   };},
   async first(){return primary.prepare(stmt).get()||null;},
   async all(){return {results:primary.prepare(stmt).all()};},
   async run(){return {meta:{changes:primary.prepare(stmt).run().changes}};}
 }},async batch(statements){
   primary.exec("BEGIN");try{for(const item of statements)item.executeForBatch();primary.exec("COMMIT");}
   catch(e){primary.exec("ROLLBACK");throw e;}
 }};
 const sql={exec(query,...args){
  const st=durable.prepare(query),rows=st.columns().length?st.all(...args):(st.run(...args),[]);
  return {toArray:()=>rows};
 }};
 const secret="d".repeat(64),env={PRIMARY_DB:db,COVE_RIGHTS_OWNER_ENABLED:"1",
 COVE_RIGHTS_OWNER_PRIMARY_ID:"7c7ab994-f6b3-419d-a72d-71eb9ea22e7e",
 COVE_RIGHTS_OWNER_TEST_EXPIRES_AT:String(Date.now()+600000),COVE_RIGHTS_OWNER_SECRET:secret};
 const owner=new CoveLegalAuthority({storage:{sql,transactionSync(fn){return fn();}}},env);
 const invoke=(action,payload={},key=secret)=>owner.fetch(new Request(
 "https://legal-authority.internal/publishing/editor-action",{
 method:"POST",headers:{authorization:"Bearer "+key,"content-type":"application/json"},
 body:JSON.stringify({action,operationId:"editor:"+crypto.randomUUID(),payload})}));
 const n=table=>Number(primary.prepare("SELECT count(*) n FROM "+table).get().n);
 const invitation={accountId:account,email:"Invited@Example.com",role:"editor"};
 assert.equal((await invoke("member-invite",{userId:publisher,raw:invitation},"f".repeat(64))).status,401);
 assert.equal((await invoke("member-invite",{userId:"unknown_publisher_qa",raw:invitation})).status,403);
 assert.equal((await invoke("member-invite",{userId:outsider,raw:invitation})).status,503);
 assert.equal(n("publishing_audit_events"),0);
 assert.equal(n("publishing_account_members"),1);
 assert.equal((await invoke("review-submission",{userId:publisher,raw:{decision:"hold"}})).status,403);
 for(const action of ["edition-submit","update-policy","owner-optin","asset-upload"]){
  assert.equal((await invoke(action,{userId:publisher,raw:{}})).status,409,
    action+" cannot write a positive commercial claim without independent owner proof");
 }
 assert.equal((await invoke("review-submission",{userId:staff,raw:{decision:"approve"}})).status,403,
  "Staff must be independently permissioned before reviewing");
 primary.prepare("INSERT INTO staff_principal_roles VALUES(?,'editor_reviewer')").run(staff);
 primary.prepare("INSERT INTO staff_role_permissions VALUES('editor_reviewer','publishing.review')").run();
 assert.equal((await invoke("review-submission",{userId:staff,raw:{decision:"approve"}})).status,409,
  "Even valid staff cannot grant publication approval without owner evidence");
 const response=await invoke("member-invite",{userId:publisher,raw:invitation});
 if(response.status!==200)throw Error("Private QA publisher invite returned "+response.status);
 const receipt=await response.json();
 assert.equal(receipt.schema,"cove.private-publishing-editor-qa.v1");
 assert.equal(receipt.ownerFirst,true);assert.equal(receipt.action,"member-invite");
 assert.equal(receipt.result.status,"invited");
 assert.equal(n("publishing_audit_events"),1);
 assert.equal(n("publishing_account_members"),2);
 const row=primary.prepare("SELECT invited_email,status,invited_by_user_id FROM publishing_account_members WHERE status='invited'").get();
 assert.equal(row.invited_email,"invited@example.com");
 assert.equal(row.invited_by_user_id,publisher);
 assert.equal(row.status,"invited");
 env.COVE_RIGHTS_OWNER_ENABLED="0";
 assert.equal((await invoke("member-invite",{userId:publisher,raw:invitation})).status,503);
 assert.equal(n("publishing_account_members"),2);
 console.log("PASS: isolated owner enforces staff and publisher scope, denies positive publishing and expired lease, issues one QA invite with audit event");
}finally{primary.close();durable.close();rmSync(folder,{recursive:true,force:true});}
