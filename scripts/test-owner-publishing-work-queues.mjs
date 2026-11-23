/* eslint-disable prettier/prettier -- Actual isolated SQLite worker lease and evidence checks. */
import assert from "node:assert/strict";
import {DatabaseSync} from "node:sqlite";
import {build} from "esbuild";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {pathToFileURL} from "node:url";
const dir=mkdtempSync(join(tmpdir(),"cove-private-jobs-"));
const db0=new DatabaseSync(":memory:"),durable=new DatabaseSync(":memory:");
try{
 const output=join(dir,"owner.mjs");
 await build({entryPoints:["src/storefront-strangler/legal-authority.worker.ts"],
   bundle:true,platform:"node",format:"esm",target:"node22",outfile:output,logLevel:"silent",
   plugins:[{name:"cloudflare-qa-host",setup(b){
     b.onResolve({filter:/^cloudflare:workers$/},()=>({path:"qa",namespace:"host"}));
     b.onLoad({filter:/.*/,namespace:"host"},()=>({contents:
       "export class DurableObject { constructor(ctx,env){this.ctx=ctx;this.env=env;} }"}));
   }}]});
 const {CoveLegalAuthority}=await import(pathToFileURL(output).href);
 db0.exec("PRAGMA foreign_keys=ON");
 for(const sql of [
   "CREATE TABLE publishing_assets(id TEXT PRIMARY KEY,edition_id TEXT,kind TEXT,current_version_id TEXT)",
   "CREATE TABLE publishing_asset_versions(id TEXT PRIMARY KEY,asset_id TEXT,object_key TEXT,mime_type TEXT,size_bytes INTEGER,sha256 TEXT,original_filename TEXT,validation_summary TEXT,quarantine_status TEXT)",
   "CREATE TABLE publishing_validation_jobs(id TEXT PRIMARY KEY,asset_version_id TEXT,check_type TEXT,status TEXT,attempts INTEGER,max_attempts INTEGER,lease_owner TEXT,lease_expires_at TEXT,available_at TEXT,last_error TEXT,updated_at TEXT,execution_class TEXT,priority INTEGER,created_at TEXT,required INTEGER)",
   "CREATE TABLE publishing_validation_results(id TEXT PRIMARY KEY,job_id TEXT,asset_version_id TEXT,check_type TEXT,validator_name TEXT,validator_version TEXT,status TEXT,issue_count INTEGER,issues_json TEXT,report_object_key TEXT,report_sha256 TEXT,completed_at TEXT)",
   "CREATE TABLE publishing_rights_evidence(id TEXT PRIMARY KEY,object_key TEXT,mime_type TEXT,sha256 TEXT,size_bytes INTEGER,scan_status TEXT)",
   "CREATE TABLE publishing_rights_evidence_scan_jobs(id TEXT PRIMARY KEY,evidence_id TEXT,status TEXT,lease_owner TEXT,lease_expires_at TEXT,attempts INTEGER,max_attempts INTEGER,available_at TEXT,last_error TEXT,updated_at TEXT,created_at TEXT)"
 ])db0.exec(sql);
 const at=new Date().toISOString();
 db0.prepare("INSERT INTO publishing_assets VALUES('ass_qa','ed_qa','cover','ver_qa')").run();
 db0.prepare("INSERT INTO publishing_asset_versions VALUES('ver_qa','ass_qa','qa/assets','image/png',200,?,'cover.png','pending','quarantined')").run("b".repeat(64));
 db0.prepare("INSERT INTO publishing_validation_jobs VALUES('job_qa','ver_qa','cover','queued',0,3,NULL,NULL,?,'',?,'external',1,?,1)").run(at,at,at);
 db0.prepare("INSERT INTO publishing_rights_evidence VALUES('ev_qa','qa/rights','application/pdf',?,300,'pending')").run("c".repeat(64));
 db0.prepare("INSERT INTO publishing_rights_evidence_scan_jobs VALUES('rights_job_qa','ev_qa','queued',NULL,NULL,0,3,?,'',?,?)").run(at,at,at);
 const primary={
   prepare(query){return {
     async first(){return db0.prepare(query).get()||null;},
     async all(){return {results:db0.prepare(query).all()};},
     async run(){return {meta:{changes:db0.prepare(query).run().changes}};},
     bind(...args){return {
       async first(){return db0.prepare(query).get(...args)||null;},
       async all(){return {results:db0.prepare(query).all(...args)};},
       async run(){return {meta:{changes:db0.prepare(query).run(...args).changes}};}
     };}
   };},
   async batch(statements){
     db0.exec("BEGIN");
     try{for(const statement of statements)await statement.run();db0.exec("COMMIT");}
     catch(error){db0.exec("ROLLBACK");throw error;}
   }
 };
 const storage={sql:{exec(query,...params){const s=durable.prepare(query);
   const rows=s.columns().length?s.all(...params):(s.run(...params),[]);
   return {toArray:()=>rows};
 }},transactionSync(fn){return fn();}};
 const secret="a".repeat(64),env={
   PRIMARY_DB:primary,COVE_RIGHTS_OWNER_ENABLED:"1",
   COVE_RIGHTS_OWNER_PRIMARY_ID:"7c7ab994-f6b3-419d-a72d-71eb9ea22e7e",
   COVE_RIGHTS_OWNER_TEST_EXPIRES_AT:String(Date.now()+600000),
   COVE_RIGHTS_OWNER_SECRET:secret
 };
 const owner=new CoveLegalAuthority({storage},env);
 const call=(action,payload,key=secret)=>owner.fetch(new Request(
   "https://legal-authority.internal/publishing/worker/jobs",{
     method:"POST",headers:{"content-type":"application/json","authorization":"Bearer "+key},
     body:JSON.stringify({action,payload,operationId:"qa-worker:"+crypto.randomUUID()})
   }));
 assert.equal((await call("lease-validation",{workerId:"qa-worker",limit:1}, "b".repeat(64))).status,401);
 assert.equal(db0.prepare("SELECT status FROM publishing_validation_jobs WHERE id='job_qa'").get().status,"queued");
 let r=await call("lease-validation",{workerId:"qa-worker",limit:1});
 assert.equal(r.status,200);let ack=await r.json();
 assert.equal(ack.ownerFirst,true);assert.equal(ack.result.jobs.length,1);
 assert.equal(db0.prepare("SELECT lease_owner FROM publishing_validation_jobs WHERE id='job_qa'").get().lease_owner,"qa-worker");
 assert.equal((await call("complete-validation",{jobId:"job_qa",workerId:"wrong-worker",status:"passed",validatorName:"qa-verified"})).status,503);
 assert.equal(db0.prepare("SELECT status FROM publishing_validation_jobs WHERE id='job_qa'").get().status,"leased");
 r=await call("complete-validation",{jobId:"job_qa",workerId:"qa-worker",status:"passed",validatorName:"qa-verified"});
 assert.equal(r.status,200);ack=await r.json();
 assert.equal(ack.result.assetVersionId,"ver_qa");
 assert.equal(db0.prepare("SELECT quarantine_status FROM publishing_asset_versions WHERE id='ver_qa'").get().quarantine_status,"clean");
 assert.equal(db0.prepare("SELECT COUNT(*) n FROM publishing_validation_results").get().n,1);
 r=await call("lease-rights-scan",{workerId:"rights-worker",limit:1});
 assert.equal(r.status,200);ack=await r.json();
 assert.equal(ack.result.jobs.length,1);
 assert.equal(db0.prepare("SELECT lease_owner FROM publishing_rights_evidence_scan_jobs WHERE id='rights_job_qa'").get().lease_owner,"rights-worker");
 assert.equal((await call("complete-rights-scan",{jobId:"rights_job_qa",workerId:"wrong",status:"passed"})).status,503);
 assert.equal(db0.prepare("SELECT scan_status FROM publishing_rights_evidence WHERE id='ev_qa'").get().scan_status,"pending");
 // Force an expired, still-leased job; owner must refuse stale proof.
 db0.prepare("UPDATE publishing_rights_evidence_scan_jobs SET lease_expires_at='2000-01-01T00:00:00Z' WHERE id='rights_job_qa'").run();
 assert.equal((await call("complete-rights-scan",{jobId:"rights_job_qa",workerId:"rights-worker",status:"passed"})).status,503);
 assert.equal(db0.prepare("SELECT scan_status FROM publishing_rights_evidence WHERE id='ev_qa'").get().scan_status,"pending");
 db0.prepare("UPDATE publishing_rights_evidence_scan_jobs SET lease_expires_at='2999-01-01T00:00:00Z' WHERE id='rights_job_qa'").run();
 r=await call("complete-rights-scan",{jobId:"rights_job_qa",workerId:"rights-worker",status:"failed",error:"QA scanned infection"});
 assert.equal(r.status,200);
 assert.equal(db0.prepare("SELECT scan_status FROM publishing_rights_evidence WHERE id='ev_qa'").get().scan_status,"failed");
 env.COVE_RIGHTS_OWNER_ENABLED="0";
 assert.equal((await call("lease-validation",{workerId:"qa-worker",limit:1})).status,503);
 console.log("PASS: private job owner isolated SQLite lease, stale/foreign worker refusal, atomic summaries, owner-off denial");
}finally{db0.close();durable.close();rmSync(dir,{recursive:true,force:true});}
