/* eslint-disable prettier/prettier -- Review atomic D1 SQL races without contacting production. */
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {DatabaseSync} from "node:sqlite";
import {build} from "esbuild";

const output=await build({
  entryPoints:["src/storefront-strangler/qa-owner-positive-generation-cas.stage.ts"],
  bundle:true,write:false,platform:"node",format:"esm",target:"node22",logLevel:"silent",
});
const compiled=output.outputFiles[0].text;
const {publishQaOwnerPositiveGeneration,QA_POSITIVE_GENERATION_CAS_SQL,
  QA_DIRTY_GENERATION_CAS_SQL}=await import(
  "data:text/javascript;base64,"+Buffer.from(compiled).toString("base64")
);
const sql=readFileSync(
  "scripts/staging/qa-owner-positive-primary-generation.prototype.sql","utf8"
);
const qaId="7c7ab994-f6b3-419d-a72d-71eb9ea22e7e";
const version="a".repeat(64),secret="b".repeat(64),digest="c".repeat(64);
const at=Date.parse("2026-11-22T12:00:00Z");
const generation=9,expiry=at+20_000;
const fence="cove_qa_owner_positive_publication_fence";
const rowSql="SELECT * FROM "+fence+" WHERE slot=1";
const refusal=/(?:qa_owner_positive_primary_publication_denied|qa_owner_primary_read_not_current)/;

function fixture(){
  const db=new DatabaseSync(":memory:");
  db.exec(sql);
  const state={
    epoch:5,revision:"A",sourceRevision:7,now:at,
    primarySessions:0,ownerCalls:0,positiveCalls:0,
    currentCalls:0,casCalls:0,certStatus:200,certAvailable:true,
    certificateTransform:x=>x,onCas:()=>{},onAfterCas:()=>{},
    onOwnerCurrent:()=>{},rollbackCas:false,competeCas:false,
    lastPrimaryMode:null,ownerChallenges:new Set(),casDone:false,
  };
  const owner={
    async fetch(request){
      state.ownerCalls++;
      assert.equal(request.method,"POST");
      assert.equal(request.headers.get("authorization"),"Bearer "+secret);
      assert.equal(request.headers.get("cache-control"),"no-store");
      const body=await request.json();
      assert.deepEqual(Object.keys(body),["challenge"]);
      assert.match(body.challenge,/^[a-f0-9]{32}$/);
      assert.ok(!state.ownerChallenges.has(body.challenge),"every owner challenge is fresh");
      state.ownerChallenges.add(body.challenge);
      const route=new URL(request.url).pathname;
      if(route==="/qa/current-mutation-fence"){
        state.currentCalls++;
        state.onOwnerCurrent(state.currentCalls);
        return Response.json({
          schema:"cove.qa.current-owner-sql-journal.v1",
          authorizing:false,challenge:body.challenge,journalVersion:version,
          mutationEpoch:String(state.epoch),primaryId:qaId,
          rehearsalRevision:state.revision,tables:27,triggers:87,
        },{headers:{"cache-control":"no-store"}});
      }
      assert.equal(route,"/qa/positive-generation-certificate");
      state.positiveCalls++;
      if(!state.certAvailable)return new Response(null,{status:404});
      const certificate=state.certificateTransform({
        schema:"cove.qa.owner-reconciled-positive-certificate.v1",
        authorizing:true,challenge:body.challenge,primaryId:qaId,
        journalVersion:version,rehearsalRevision:state.revision,
        mutationEpoch:String(state.epoch),generation,
        sourceRevision:state.sourceRevision,manifestSha256:digest,territory:"US",
        catalogRows:3,allowRows:2,denyRows:1,
        completeHistoricalWithdrawals:true,completeCatalog:true,
        eligibilityValidUntilMs:expiry,
      });
      return Response.json(certificate,{
        status:state.certStatus,headers:{"cache-control":"no-store"},
      });
    }
  };
  const primary={
    withSession(mode){
      assert.equal(mode,"first-primary","never use stale D1 replica for CAS or verification");
      state.lastPrimaryMode=mode;state.primarySessions++;
      return {
        prepare(query){
          assert.ok([QA_POSITIVE_GENERATION_CAS_SQL,
            QA_DIRTY_GENERATION_CAS_SQL].includes(query)||query.includes(
              "FROM cove_qa_owner_positive_publication_fence WHERE slot=1"),
            "publisher cannot execute arbitrary SQL");
          const stmt=db.prepare(query);
          let params=[];
          return {
            bind(...args){params=args;return this;},
            async first(){
              if(query===QA_POSITIVE_GENERATION_CAS_SQL){
                state.casCalls++;state.onCas();
                if(state.rollbackCas){
                  state.rollbackCas=false;
                  db.exec("BEGIN IMMEDIATE");
                  const hypothetical=stmt.get(...params);
                  db.exec("ROLLBACK");
                  return hypothetical||null;
                }
                if(state.competeCas){
                  state.competeCas=false;
                  assert.ok(stmt.get(...params),"competing CAS committed");
                }
                const row=stmt.get(...params)||null;
                state.casDone=true;
                return row;
              }
              if(query===QA_DIRTY_GENERATION_CAS_SQL)
                return stmt.get(...params)||null;
              if(state.casDone)state.onAfterCas();
              return stmt.get(...params)||null;
            }
          };
        }
      };
    }
  };
  const env={owner,secret,primary,primaryId:qaId,journalVersion:version,
    nowMs:()=>state.now,COVE_QA_POSITIVE_GENERATION_ONLY:"1"};
  return {db,state,env,read:()=>db.prepare(rowSql).get(),close:()=>db.close()};
}
const run=x=>publishQaOwnerPositiveGeneration(x.env);
const positive=fixture();
try{
  const success=await run(positive);
  assert.deepEqual(success,{
    schema:"cove.qa.owner-positive-generation.v1",generation:9,ownerEpoch:5,
    atomic:true,primaryCommitted:true,authorizing:false,productionReady:false,
  });
  assert.equal(positive.read().dirty,0);
  assert.equal(positive.read().active_generation,9);
  assert.equal(positive.read().source_revision,7);
  assert.equal(positive.read().manifest_sha256,digest);
  assert.equal(positive.read().eligibility_valid_until_ms,expiry);
  assert.equal(positive.read().publication_revision,1);
  assert.equal(positive.state.currentCalls,2,
    "one owner journal challenge before and one after D1 CAS");
  assert.equal(positive.state.positiveCalls,1,
    "independently reconciled positive certificate challenge required");
  assert.equal(positive.state.primarySessions,3);
  await assert.rejects(run(positive),refusal);
  assert.equal(positive.read().publication_revision,1,
    "replay cannot increment a committed generation");
  // Transactional source invalidation closes the D1-side grant window.
  positive.db.prepare("UPDATE rights_grants SET status='revoked' WHERE product_id='p1'")
    .run();
  assert.equal(positive.read().dirty,1);
  assert.equal(positive.read().eligibility_valid_until_ms,0);
  assert.equal(positive.read().publication_revision,2);
  assert.equal(positive.db.prepare(
    "SELECT revision FROM cove_qa_owner_positive_source_revision WHERE slot=1"
  ).get().revision,8);
  await assert.rejects(run(positive),refusal);
  assert.equal(positive.read().dirty,1);
}finally{positive.close();}

for(const mutate of [
  f=>{f.env.primaryId="4bd657ac-8789-403e-a28c-93aba8d0a989";},
  f=>{delete f.env.COVE_QA_POSITIVE_GENERATION_ONLY;},
  f=>{f.env.COVE_QA_POSITIVE_GENERATION_ONLY="true";},
  f=>{f.env.secret="invalid";},
  f=>{f.state.epoch=0;},
  f=>{f.state.certAvailable=false;}, // ACTUAL QA OWNER POSTURE
  f=>{f.state.certStatus=503;},
  f=>{f.state.certificateTransform=x=>({...x,authorizing:false});},
  f=>{f.state.certificateTransform=x=>({...x,completeCatalog:false});},
  f=>{f.state.certificateTransform=x=>({...x,completeHistoricalWithdrawals:false});},
  f=>{f.state.certificateTransform=x=>({...x,mutationEpoch:"4"});},
  f=>{f.state.certificateTransform=x=>({...x,manifestSha256:"x".repeat(64)});},
  f=>{f.state.certificateTransform=x=>({...x,primaryId:"4bd657ac-8789-403e-a28c-93aba8d0a989"});},
  f=>{f.state.certificateTransform=x=>({...x,sourceRevision:6});},
  f=>{f.state.certificateTransform=x=>({...x,eligibilityValidUntilMs:at+30001});},
  f=>{f.state.certificateTransform=x=>({...x,eligibilityValidUntilMs:at});},
  f=>{f.state.certificateTransform=x=>({...x,allowRows:3});},
  f=>{f.state.certificateTransform=x=>({...x,unexpected:true});},
  f=>{f.state.certificateTransform=()=>({huge:"z".repeat(5000)});},
  f=>{f.db.exec("UPDATE cove_qa_owner_positive_source_revision SET dirty=1");},
  f=>{f.db.prepare("UPDATE rights_grants SET status='revoked' WHERE product_id='p2'").run();},
  f=>{f.db.exec("DROP TRIGGER cove_qa_positive_row_immutable");
    f.db.exec("DROP TRIGGER cove_qa_positive_row_no_delete");
    f.db.exec("DELETE FROM cove_qa_owner_positive_candidate_products WHERE product_id='p2'");},
  f=>{f.db.exec("DROP TRIGGER cove_qa_positive_candidate_immutable");
    f.db.exec("UPDATE cove_qa_owner_positive_candidate SET allow_rows=3 WHERE generation=9");},
]){
  const x=fixture();
  try{
    mutate(x);
    await assert.rejects(run(x),refusal);
    assert.equal(x.read().dirty,1);
    assert.equal(x.read().active_generation,0);
  }finally{x.close();}
}
for(const race of [
  ["withdrawal immediately before CAS",x=>{
    x.state.onCas=()=>x.db.prepare(
      "UPDATE rights_grants SET status='revoked' WHERE product_id='p2'").run();
  }],
  ["source mutation during final primary read",x=>{
    x.state.onAfterCas=()=>{x.state.onAfterCas=()=>{};
      x.db.prepare("UPDATE rights_grants SET status='revoked' WHERE product_id='p1'").run();};
  }],
  ["owner denial ACK before D1 acknowledgement",x=>{
    x.state.onOwnerCurrent=n=>{if(n===2)x.state.epoch=6;};
  }],
  ["CAS return before rollback",x=>{x.state.rollbackCas=true;}],
  ["competing positive generation CAS",x=>{x.state.competeCas=true;}],
  ["eligibility expired by final owner challenge",x=>{
    x.state.onOwnerCurrent=n=>{if(n===2)x.state.now=expiry;};
  }],
]){
  const x=fixture();
  try{
    race[1](x);
    await assert.rejects(run(x),refusal,race[0]);
    if(race[0]==="owner denial ACK before D1 acknowledgement"||
       race[0]==="eligibility expired by final owner challenge")
      assert.equal(x.read().dirty,1,"owner race must dirty positive candidate");
    if(race[0]==="CAS return before rollback")
      assert.equal(x.read().active_generation,0);
  }finally{x.close();}
}
const f=fixture();
try{
  for(const invalid of [
    "UPDATE "+fence+" SET dirty=0",
    "UPDATE "+fence+" SET owner_mutation_epoch=999",
    "UPDATE "+fence+" SET pending_withdrawals=0",
    "DELETE FROM "+fence,
    "INSERT INTO "+fence+" SELECT * FROM "+fence,
    "UPDATE cove_qa_owner_positive_candidate SET sealed=0 WHERE generation=9",
    "DELETE FROM cove_qa_owner_positive_candidate_products WHERE product_id='p3'",
  ])assert.throws(()=>f.db.exec(invalid),/qa_positive|qa_candidate|UNIQUE/);
  assert.equal(f.read().dirty,1);
  f.db.exec("BEGIN IMMEDIATE");
  assert.ok(f.db.prepare(QA_POSITIVE_GENERATION_CAS_SQL).get(
    5,7,9,digest,expiry,
    "cove.qa.owner-positive-generation.v1",qaId,version,"A",5,0,
    9,qaId,version,5,"A",7,digest,3,2,1,expiry));
  f.db.exec("ROLLBACK");
  assert.equal(f.read().active_generation,0,"positive D1 transaction must roll back");
  assert.equal(f.read().dirty,1);
}finally{f.close();}
const negativeSource=readFileSync(
  "scripts/staging/qa-owner-negative-primary-publication.prototype.sql","utf8");
const backend=readFileSync("src/persistence-backend.worker.ts","utf8");
const ownerWorker=readFileSync(
  "src/storefront-strangler/legal-authority.worker.ts","utf8");
assert.match(negativeSource,/negative.only/i);
assert.doesNotMatch(backend,/qa-owner-positive-generation-cas\.stage/);
assert.doesNotMatch(ownerWorker,/qa-owner-positive-generation-cas\.stage/);
assert.doesNotMatch(ownerWorker,/\/qa\/positive-generation-certificate/);
assert.match(compiled,/qa_owner_positive_primary_publication_denied/);
assert.ok(!compiled.includes("4bd657ac-8789-403e-a28c-93aba8d0a989"));
console.log("PASS: exact SQLite atomic QA positive generation CAS, current owner + positive authority" +
  " challenge, full candidate coverage, stale source refusal, denial races, rollback, " +
  "immutable candidate, no PROD owner emitter and no serving import.");
