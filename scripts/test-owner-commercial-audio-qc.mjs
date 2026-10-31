/* eslint-disable prettier/prettier -- Execute private audio QC owner against SQLite state. */
import assert from "node:assert/strict";
import {DatabaseSync} from "node:sqlite";
import {build} from "esbuild";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {pathToFileURL} from "node:url";
const dir=mkdtempSync(join(tmpdir(),"cove-private-audio-qc-"));
const primary=new DatabaseSync(":memory:"),durable=new DatabaseSync(":memory:");
try {
 const target=join(dir,"owner.mjs");
 await build({entryPoints:["src/storefront-strangler/legal-authority.worker.ts"],
   bundle:true,platform:"node",format:"esm",target:"node22",outfile:target,logLevel:"silent",
   plugins:[{name:"qa-cloudflare-host",setup(b){
     b.onResolve({filter:/^cloudflare:workers$/},()=>({path:"mock",namespace:"host"}));
     b.onLoad({filter:/.*/,namespace:"host"},()=>({contents:
       "export class DurableObject {constructor(ctx,env){this.ctx=ctx;this.env=env;}}"}));
   }}]});
 const {CoveLegalAuthority}=await import(pathToFileURL(target).href);
 for(const statement of [
   "CREATE TABLE commercial_audio_policy_versions(id TEXT PRIMARY KEY,policy_json TEXT)",
   "CREATE TABLE commercial_audio_profiles(edition_id TEXT PRIMARY KEY,active_policy_id TEXT,preview_file_id TEXT,qc_status TEXT,updated_at TEXT)",
   "CREATE TABLE commercial_audio_qc_jobs(edition_id TEXT PRIMARY KEY,status TEXT,attempts INTEGER,max_attempts INTEGER,lease_owner TEXT,lease_expires_at TEXT,available_at TEXT,last_run_id TEXT,last_error TEXT,created_at TEXT,updated_at TEXT)",
   "CREATE TABLE commercial_audio_chapters(id TEXT PRIMARY KEY,edition_id TEXT,position INTEGER,title TEXT,file_id TEXT,duration_ms INTEGER,mime_type TEXT,sample_rate_hz INTEGER,bitrate_kbps INTEGER,bitrate_mode TEXT,channels INTEGER,sha256 TEXT,loudness_rms_db REAL,true_peak_db REAL,noise_floor_db REAL,qc_status TEXT)",
   "CREATE TABLE commercial_audio_files(id TEXT PRIMARY KEY,object_key TEXT,size_bytes INTEGER,mime_type TEXT,sha256 TEXT,duration_ms INTEGER,sample_rate_hz INTEGER,bitrate_kbps INTEGER,bitrate_mode TEXT,channels INTEGER,loudness_rms_db REAL,true_peak_db REAL,noise_floor_db REAL,qc_status TEXT,quarantine_status TEXT,edition_id TEXT,kind TEXT)",
   "CREATE TABLE commercial_audio_qc_runs(id TEXT PRIMARY KEY,edition_id TEXT,policy_id TEXT,source_manifest_hash TEXT,status TEXT,findings_json TEXT,measured_json TEXT,created_at TEXT)"
 ])primary.exec(statement);
 const at=new Date().toISOString(),ed="pubed_audio_qa",sha="a".repeat(64);
 primary.prepare("INSERT INTO commercial_audio_policy_versions VALUES('policy_qa','{}')").run();
 primary.prepare("INSERT INTO commercial_audio_profiles VALUES(?,'policy_qa',NULL,'pending',?)").run(ed,at);
 primary.prepare("INSERT INTO commercial_audio_qc_jobs VALUES(?,'queued',0,5,NULL,NULL,?,NULL,'',?,?)").run(ed,at,at,at);
 primary.prepare("INSERT INTO commercial_audio_files VALUES('file_qa','qa/audio.mp3',1000,'audio/mpeg',?,60000,44100,192,'CBR',2,-20,-4,-70,'pending','quarantined',?,'chapter')").run(sha,ed);
 primary.prepare("INSERT INTO commercial_audio_chapters VALUES('chapter_qa',?,1,'QA Chapter','file_qa',60000,'audio/mpeg',44100,192,'CBR',2,?,-20,-4,-70,'pending')").run(ed,sha);
 const db={
   prepare(sql){return {
     async first(){return primary.prepare(sql).get()||null;},
     async all(){return {results:primary.prepare(sql).all()};},
     async run(){return {meta:{changes:primary.prepare(sql).run().changes}};},
     bind(...args){return {
       async first(){return primary.prepare(sql).get(...args)||null;},
       async all(){return {results:primary.prepare(sql).all(...args)};},
       async run(){return {meta:{changes:primary.prepare(sql).run(...args).changes}};}
     };}
   };},
   async batch(statements){primary.exec("BEGIN");
     try{for(const statement of statements)await statement.run();primary.exec("COMMIT");}
     catch(e){primary.exec("ROLLBACK");throw e;}
   }
 };
 const storage={sql:{exec(sql,...args){const stmt=durable.prepare(sql);
   const rows=stmt.columns().length?stmt.all(...args):(stmt.run(...args),[]);
   return {toArray:()=>rows};
 }},transactionSync(fn){return fn();}};
 const secret="b".repeat(64);
 const env={PRIMARY_DB:db,COVE_RIGHTS_OWNER_ENABLED:"1",
   COVE_RIGHTS_OWNER_PRIMARY_ID:"7c7ab994-f6b3-419d-a72d-71eb9ea22e7e",
   COVE_RIGHTS_OWNER_TEST_EXPIRES_AT:String(Date.now()+600000),
   COVE_RIGHTS_OWNER_SECRET:secret};
 const owner=new CoveLegalAuthority({storage},env);
 const call=(action,payload,key=secret)=>owner.fetch(new Request(
   "https://legal-authority.internal/publishing/audio/qc-jobs",{
     method:"POST",headers:{"content-type":"application/json","authorization":"Bearer "+key},
     body:JSON.stringify({action,payload,operationId:"qa-audio-qc:"+crypto.randomUUID()})
   }));
 assert.equal((await call("lease",{workerId:"audioworker",limit:1},"c".repeat(64))).status,401);
 assert.equal(primary.prepare("SELECT status FROM commercial_audio_qc_jobs WHERE edition_id=?").get(ed).status,"queued");
 let r=await call("lease",{workerId:"audioworker",limit:1});
 assert.equal(r.status,200);let body=await r.json();assert.equal(body.ownerFirst,true);
 assert.equal(body.result.jobs.length,1);
 assert.equal(primary.prepare("SELECT lease_owner FROM commercial_audio_qc_jobs WHERE edition_id=?").get(ed).lease_owner,"audioworker");
 const measurement={sha256:sha,malwareClean:true,durationMs:60000,rmsDb:-20,peakDb:-4,
   noiseFloorDb:-70,sampleRateHz:44100,bitrateKbps:192,bitrateMode:"CBR",channels:2};
 const completion={editionId:ed,workerId:"wrong-worker",chapters:[{...measurement,chapterId:"chapter_qa"}]};
 assert.equal((await call("complete",completion)).status,503);
 assert.equal(primary.prepare("SELECT status FROM commercial_audio_qc_jobs WHERE edition_id=?").get(ed).status,"leased");
 r=await call("complete",{...completion,workerId:"audioworker"});
 assert.equal(r.status,200);body=await r.json();assert.equal(body.result.status,"passed");
 assert.equal(primary.prepare("SELECT quarantine_status FROM commercial_audio_files WHERE id='file_qa'").get().quarantine_status,"clean");
 assert.equal(primary.prepare("SELECT qc_status FROM commercial_audio_profiles WHERE edition_id=?").get(ed).qc_status,"passed");
 assert.equal(primary.prepare("SELECT COUNT(*) n FROM commercial_audio_qc_runs").get().n,1);
 env.COVE_RIGHTS_OWNER_ENABLED="0";
 assert.equal((await call("lease",{workerId:"audioworker",limit:1})).status,503);
 assert.equal(primary.prepare("SELECT COUNT(*) n FROM commercial_audio_qc_runs").get().n,1);
 console.log("PASS: private QA audio QC owner leases, rejects forged worker, verifies measurements, atomically updates quarantine and denies owner-off");
}finally{primary.close();durable.close();rmSync(dir,{recursive:true,force:true});}
