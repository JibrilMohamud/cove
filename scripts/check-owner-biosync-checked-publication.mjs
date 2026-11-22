/* eslint-disable prettier/prettier -- Real SQLite transactional QA for a single audited scheduled-write migration. */
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {DatabaseSync} from "node:sqlite";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {pathToFileURL} from "node:url";
import {build} from "esbuild";

const dir=mkdtempSync(join(tmpdir(),"cove-biosync-owner-"));
try {
  const outfile=join(dir,"owner.mjs");
  await build({entryPoints:["src/storefront-strangler/owner-biosync-checked-publication.stage.ts"],
    bundle:true,platform:"node",format:"esm",target:"node22",outfile,logLevel:"silent"});
  const {publishCheckedBiosyncOwned:publish}=await import(pathToFileURL(outfile).href);
  const audio="a".repeat(64),epub="b".repeat(64),editionId="pg-19504",trackId="02";
  const jobId="align-pg-19504-02-7fb5b7e4c4a400b1";
  const now=new Date().toISOString();
  const base={
    version:2,status:"checked",trackId,epubSha256:epub,audioSha256:audio,
    engine:"cloudflare-workers-ai-whisper",duration:30,
    verification:{method:"independent-asr-exact-text",automatic:true,
      confidenceMode:"unreported",minWordProbability:null,coverage:1,
      matchedWords:30,spokenWords:30,checkedAt:now},
    words:Array.from({length:30},(_,i)=>({
      wordIndex:i,href:"OPS/ch01.xhtml",
      cfi:"epubcfi(/6/2!/4/2:"+i+")",
      endCfi:"epubcfi(/6/2!/4/2:"+(i+1)+")",
      text:"hello",start:i*0.9,end:i*0.9+0.5,probability:null
    }))
  };
  const blob=(m)=>Buffer.from(JSON.stringify(m));
  const hash=(b)=>createHash("sha256").update(b).digest("hex");
  const bytes=blob(base),mapSha256=hash(bytes);
  const command={editionId,trackId,jobId,mapSha256};
  const objects=new Map([["biosync/maps/"+mapSha256+".json",bytes]]);
  const bucket={async get(key) {
    const buffer=objects.get(key);return buffer?{arrayBuffer:async()=>buffer.buffer.slice(
      buffer.byteOffset,buffer.byteOffset+buffer.byteLength)}:null;
  }};
  function fixture(status="queued",recording=audio) {
    const conn=new DatabaseSync(":memory:");
    conn.exec(`
      CREATE TABLE audio_editions(id TEXT PRIMARY KEY,epub_sha256 TEXT,tracks_json TEXT);
      CREATE TABLE audio_jobs(id TEXT PRIMARY KEY,kind TEXT,status TEXT,payload_json TEXT,
        last_error TEXT,lease_token TEXT,lease_until TEXT,updated_at TEXT);
      CREATE TABLE audio_timing(edition_id TEXT,track_id TEXT,audio_sha256 TEXT,
        epub_sha256 TEXT,map_sha256 TEXT,summary_json TEXT,updated_at TEXT,
        PRIMARY KEY(edition_id,track_id));
    `);
    conn.prepare("INSERT INTO audio_editions VALUES(?,?,?)").run(editionId,epub,
      JSON.stringify([{id:trackId,sha256:recording,duration:30}]));
    conn.prepare("INSERT INTO audio_jobs VALUES(?,?,?,?,?,?,?,?)").run(
      jobId,"align",status,JSON.stringify({editionId,trackId,audioSha256:recording}),
      null,null,null,null);
    const prepared=sql=>({
      sql,args:[],
      bind(...args){return {...this,args};},
      async first(){return conn.prepare(this.sql).get(...this.args)||null;},
      async all(){return {results:conn.prepare(this.sql).all(...this.args)};},
      async run(){return conn.prepare(this.sql).run(...this.args);}
    });
    const db={
      prepare:prepared,
      async batch(statements){
        conn.exec("BEGIN IMMEDIATE");
        try{
          const result=statements.map(s=>conn.prepare(s.sql).run(...s.args));
          conn.exec("COMMIT");return result;
        }catch(e){conn.exec("ROLLBACK");throw e;}
      }
    };
    return {conn,db,rows:()=>conn.prepare("SELECT * FROM audio_timing").all(),
      job:()=>conn.prepare("SELECT status FROM audio_jobs").get().status};
  }
  {
    const f=fixture();
    const ack=await publish(f.db,bucket,command);
    assert.deepEqual(ack,{schema:"cove.owner-biosync-checked-publication.v1",
      ...command,committed:true,replay:false});
    assert.equal(f.rows().length,1);
    assert.equal(f.rows()[0].map_sha256,mapSha256);
    assert.equal(f.job(),"done");
    const summary=JSON.parse(f.rows()[0].summary_json);
    assert.equal(summary.wordCount,30);
    assert.equal(summary.coverage,1);
    const replay=await publish(f.db,bucket,command);
    assert.equal(replay.replay,true);
    assert.equal(f.rows().length,1);
    assert.equal(f.job(),"done");
    const edited={...base,words:[...base.words]};
    edited.words[0]={...edited.words[0],text:"other"};
    const editedBytes=blob(edited),otherHash=hash(editedBytes);
    objects.set("biosync/maps/"+otherHash+".json",editedBytes);
    await assert.rejects(()=>publish(f.db,bucket,{...command,mapSha256:otherHash}),
      /owner_biosync_conflicting_publication/);
    assert.equal(f.rows()[0].map_sha256,mapSha256);
    f.conn.close();
  }
  for(const [status,recording] of [["running",audio],["queued","c".repeat(64)]]) {
    const f=fixture(status,recording);
    await assert.rejects(()=>publish(f.db,bucket,command),/owner_biosync_(job_not_eligible|job_identity_mismatch)/);
    assert.equal(f.rows().length,0);
    assert.equal(f.job(),status);f.conn.close();
  }
  for(const invalid of [
    {...command,sql:"UPDATE audio_timing SET map_sha256='evil'"},
    {...command,jobId:"../another"},
    {...command,mapSha256:"c".repeat(64)}
  ]) {
    const f=fixture();
    await assert.rejects(()=>publish(f.db,bucket,invalid));
    assert.equal(f.rows().length,0);f.conn.close();
  }
  for(const mutant of [
    {...base,verification:{...base.verification,coverage:0.5}},
    {...base,words:base.words.slice(0,2)},
    {...base,audioSha256:"d".repeat(64)},
    {...base,words:base.words.map((w,i)=>i===1?{...w,start:0}:w)}
  ]) {
    const b=blob(mutant),sha=hash(b);
    objects.set("biosync/maps/"+sha+".json",b);
    const f=fixture();
    await assert.rejects(()=>publish(f.db,bucket,{...command,mapSha256:sha}));
    assert.equal(f.rows().length,0);assert.equal(f.job(),"queued");f.conn.close();
  }
  {
    const f=fixture();
    const aborted={...f.db,async batch(){throw Error("primary_d1_unavailable")}};
    await assert.rejects(()=>publish(aborted,bucket,command),/primary_d1_unavailable/);
    assert.equal(f.rows().length,0);assert.equal(f.job(),"queued");
    await assert.rejects(()=>publish(f.db,undefined,command),/owner_biosync_bucket_unavailable/);
    f.conn.close();
  }
  {
    const f=fixture();
    const paired=await Promise.all([publish(f.db,bucket,command),publish(f.db,bucket,command)]);
    assert.equal(paired.length,2);
    assert.ok(paired.every(x=>x.committed===true));
    assert.equal(f.rows().length,1);
    assert.equal(f.job(),"done");f.conn.close();
  }
  console.log("PASS: owner-only BioSync map digest, exact pinned identity, atomic pointer/job, replay, conflicting revision, malformed/missing map, unavailable D1 and duplicate concurrent calls");
}finally{rmSync(dir,{recursive:true,force:true});}
