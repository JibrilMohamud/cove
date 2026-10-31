/* eslint-disable prettier/prettier -- Real private-owner QA SQLite authority and replay tests. */
import assert from "node:assert/strict";
import {DatabaseSync} from "node:sqlite";
import {build} from "esbuild";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {pathToFileURL} from "node:url";
const folder=mkdtempSync(join(tmpdir(),"cove-onboarding-qa-"));
const primary=new DatabaseSync(":memory:"),durable=new DatabaseSync(":memory:");
try {
  const output=join(folder,"owner.mjs");
  await build({entryPoints:["src/storefront-strangler/legal-authority.worker.ts"],
    bundle:true,platform:"node",format:"esm",target:"node22",outfile:output,logLevel:"silent",
    plugins:[{name:"fake-cloudflare-host",setup(b){
      b.onResolve({filter:/^cloudflare:workers$/},()=>({path:"fake-host",namespace:"owner-host"}));
      b.onLoad({filter:/.*/,namespace:"owner-host"},()=>({contents:"export class DurableObject { constructor(ctx,env) { this.ctx=ctx; this.env=env; } }"}));
    }}]});
  const {CoveLegalAuthority}=await import(pathToFileURL(output).href);
  primary.exec("PRAGMA foreign_keys=ON");
  for(const sql of [
    "CREATE TABLE staff_principals(user_id TEXT PRIMARY KEY,status TEXT)",
    "CREATE TABLE staff_principal_roles(user_id TEXT,role_id TEXT)",
    "CREATE TABLE staff_role_permissions(role_id TEXT,permission TEXT)",
    "CREATE TABLE publishing_accounts(id TEXT PRIMARY KEY,identity_status TEXT,tax_status TEXT,payout_status TEXT,updated_at TEXT)",
    "CREATE TABLE publishing_identity_verifications(id TEXT PRIMARY KEY,account_id TEXT,status TEXT,reason_code TEXT,decided_at TEXT)",
    "CREATE TABLE publishing_tax_profiles(id TEXT PRIMARY KEY,account_id TEXT,status TEXT,reason_code TEXT,withholding_bps INTEGER,validated_at TEXT,updated_at TEXT)",
    "CREATE TABLE publishing_payout_accounts(id TEXT PRIMARY KEY,account_id TEXT,status TEXT,requirements_due_json TEXT,verified_at TEXT,updated_at TEXT)",
    "CREATE TABLE publishing_audit_events(id TEXT PRIMARY KEY,account_id TEXT,actor_user_id TEXT,entity_type TEXT,entity_id TEXT,action TEXT,metadata_json TEXT,created_at TEXT)"
  ])primary.exec(sql);
  const actor="staff_onboarding_qa",intruder="staff_intruder_qa",
    account="pubacct_qa123",otherAccount="pubacct_other123",at="2026-10-30T00:00:00.000Z";
  for(const user of [actor,intruder])
    primary.prepare("INSERT INTO staff_principals(user_id,status) VALUES(?,'active')").run(user);
  primary.prepare("INSERT INTO staff_principal_roles(user_id,role_id) VALUES(?,'publisher-reviewer')").run(actor);
  primary.prepare("INSERT INTO staff_role_permissions(role_id,permission) VALUES('publisher-reviewer','publishing.review')").run();
  for(const id of [account,otherAccount])
    primary.prepare("INSERT INTO publishing_accounts(id,identity_status,tax_status,payout_status,updated_at) VALUES(?,'pending','pending','pending',?)").run(id,at);
  primary.prepare("INSERT INTO publishing_identity_verifications(id,account_id,status) VALUES('kyc_qa123',?,'pending')").run(account);
  primary.prepare("INSERT INTO publishing_tax_profiles(id,account_id,status,withholding_bps) VALUES('tax_qa123',?,'pending',0)").run(account);
  primary.prepare("INSERT INTO publishing_payout_accounts(id,account_id,status) VALUES('payout_qa123',?,'pending')").run(account);
  const db={
    prepare(sql){return {bind(...values){return {
      async first(){return primary.prepare(sql).get(...values)||null;},
      async all(){return {results:primary.prepare(sql).all(...values)};},
      async run(){return {meta:{changes:primary.prepare(sql).run(...values).changes}};},
      executeForBatch(){return primary.prepare(sql).run(...values);}
    };}};},
    async batch(statements) {
      primary.exec("BEGIN");
      try {for(const statement of statements)statement.executeForBatch();primary.exec("COMMIT");}
      catch(error){primary.exec("ROLLBACK");throw error;}
    }
  };
  const sql={exec(text,...values){
    const query=durable.prepare(text),rows=query.columns().length?query.all(...values):(query.run(...values),[]);
    return {toArray:()=>rows};
  }};
  const secret="a".repeat(64);
  const env={PRIMARY_DB:db,COVE_RIGHTS_OWNER_ENABLED:"1",
    COVE_RIGHTS_OWNER_PRIMARY_ID:"7c7ab994-f6b3-419d-a72d-71eb9ea22e7e",
    COVE_RIGHTS_OWNER_TEST_EXPIRES_AT:String(Date.now()+600000),
    COVE_RIGHTS_OWNER_SECRET:secret};
  const owner=new CoveLegalAuthority({storage:{sql,transactionSync(fn){return fn();}}},env);
  const request=(body,key=secret)=>owner.fetch(new Request(
    "https://legal-authority.internal/publishing/onboarding/review",{
      method:"POST",headers:{"content-type":"application/json","authorization":"Bearer "+key},
      body:JSON.stringify(body)
    }));
  const cmd={reviewerUserId:actor,accountId:account,recordId:"kyc_qa123",
    kind:"identity",status:"failed",reasonCode:"INVALID_EVIDENCE",operationId:"onboarding:test-identity"};
  const auditCount=()=>primary.prepare("SELECT COUNT(*) n FROM publishing_audit_events").get().n;
  assert.equal((await request({...cmd,reviewerUserId:intruder})).status,403);
  assert.equal((await request({...cmd,accountId:otherAccount})).status,409);
  assert.equal((await request({...cmd,status:"verified"})).status,409);
  assert.equal((await request({...cmd,status:"restricted"})).status,409);
  assert.equal((await request(cmd,"b".repeat(64))).status,401);
  assert.equal(auditCount(),0);
  let receipt=await request(cmd);
  assert.equal(receipt.status,200);assert.equal((await receipt.json()).applied,true);
  assert.equal(primary.prepare("SELECT identity_status FROM publishing_accounts WHERE id=?").get(account).identity_status,"failed");
  assert.equal(primary.prepare("SELECT status FROM publishing_identity_verifications WHERE id=?").get(cmd.recordId).status,"failed");
  assert.equal(auditCount(),1);
  receipt=await request(cmd);
  assert.equal(receipt.status,200);assert.equal((await receipt.json()).applied,false);
  assert.equal(auditCount(),1,"replay must not repeat a status decision or its audit");
  const tax={...cmd,kind:"tax",recordId:"tax_qa123",status:"expired",operationId:"onboarding:test-tax"};
  assert.equal((await request({...tax,withholdingBps:1900})).status,409);
  assert.equal((await request(tax)).status,200);
  assert.equal(primary.prepare("SELECT tax_status FROM publishing_accounts WHERE id=?").get(account).tax_status,"expired");
  const payout={...cmd,kind:"payout",recordId:"payout_qa123",status:"manual_review",operationId:"onboarding:test-payout"};
  assert.equal((await request(payout)).status,200);
  assert.equal(primary.prepare("SELECT payout_status FROM publishing_accounts WHERE id=?").get(account).payout_status,"restricted");
  assert.equal(auditCount(),3);
  env.COVE_RIGHTS_OWNER_ENABLED="0";
  assert.equal((await request({...cmd,operationId:"onboarding:test-disabled"})).status,503);
  assert.equal(auditCount(),3,"owner outage must not change any state");
  console.log("PASS: real isolated owner QA independently denies forged staff, cross-account, positive provider review, withholding edits, and outage; negative decisions atomic and retry-safe");
}finally{primary.close();durable.close();rmSync(folder,{recursive:true,force:true});}
