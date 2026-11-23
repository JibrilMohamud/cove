/* eslint-disable prettier/prettier -- SQL race fixture is intentionally explicit about ordering. */
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {DatabaseSync} from "node:sqlite";
import {build} from "esbuild";

const output=await build({
  entryPoints:["src/storefront-strangler/owner-primary-denial-publication.stage.ts"],
  bundle:true,write:false,platform:"node",format:"esm",target:"node22",logLevel:"silent"
});
const source=output.outputFiles[0].text;
const {advanceQaPrimaryDenialEpoch,QA_NEGATIVE_PRIMARY_CAS_SQL}=await import(
  "data:text/javascript;base64,"+Buffer.from(source).toString("base64")
);
const sql=readFileSync("scripts/staging/qa-owner-negative-primary-publication.prototype.sql","utf8");
const QA_ID="7c7ab994-f6b3-419d-a72d-71eb9ea22e7e";
const VERSION="a".repeat(64),SECRET="b".repeat(64);
const FENCE="cove_qa_owner_primary_publication_fence";
const select="SELECT * FROM "+FENCE+" WHERE slot=1";
const refusal=/qa_owner_primary_negative_publication_denied/;

function fixture(){
  const db=new DatabaseSync(":memory:");
  db.exec(sql);
  const state={epoch:1,ownerCalls:0,primaryReads:0,primarySessions:0,
    ownerStatus:200,revision:"A",rollbackNext:false,competeNext:false,
    beforeOwnerResponse:()=>{}};
  const owner={
    async fetch(request){
      state.ownerCalls++;
      state.beforeOwnerResponse(state.ownerCalls);
      assert.equal(request.method,"POST");
      assert.equal(new URL(request.url).pathname,"/qa/current-mutation-fence");
      assert.equal(request.headers.get("authorization"),"Bearer "+SECRET);
      const {challenge}=await request.json();
      assert.match(challenge,/^[a-f0-9]{32}$/);
      return Response.json({
        schema:"cove.qa.current-owner-sql-journal.v1",
        authorizing:false,challenge,journalVersion:VERSION,
        mutationEpoch:String(state.epoch),primaryId:QA_ID,
        rehearsalRevision:state.revision,tables:27,triggers:87
      },{status:state.ownerStatus,headers:{"cache-control":"no-store"}});
    }
  };
  const primary={
    withSession(mode){
      assert.equal(mode,"first-primary","never read a replica on owner publication");
      state.primarySessions++;
      return {
        prepare(query){
          const stmt=db.prepare(query);
          let binds=[];
          return {
            bind(...values){binds=values;return this;},
            async first(){
              state.primaryReads++;
              if(query===QA_NEGATIVE_PRIMARY_CAS_SQL&&state.rollbackNext){
                state.rollbackNext=false;
                db.exec("BEGIN");
                try{const claimed=stmt.get(...binds);db.exec("ROLLBACK");return claimed;}
                catch(e){db.exec("ROLLBACK");throw e;}
              }
              if(query===QA_NEGATIVE_PRIMARY_CAS_SQL&&state.competeNext){
                state.competeNext=false;
                assert.ok(db.prepare(query).get(...binds),"competing CAS must commit");
              }
              return stmt.get(...binds)||null;
            }
          };
        }
      };
    }
  };
  const env={owner,secret:SECRET,primary,primaryId:QA_ID,journalVersion:VERSION};
  return {db,state,env,row:()=>db.prepare(select).get(),close:()=>db.close()};
}

const fresh=fixture();
try{
  const sealed=fresh.row();
  assert.equal(sealed.owner_mutation_epoch,0);
  assert.equal(sealed.dirty,1);
  assert.equal(sealed.eligibility_valid_until_ms,0);
  assert.equal(sealed.pending_withdrawals,1);
  assert.equal((await advanceQaPrimaryDenialEpoch(fresh.env)).applied,true);
  assert.equal(fresh.row().owner_mutation_epoch,1);
  assert.equal(fresh.row().pending_withdrawals,2);
  assert.equal(fresh.row().publication_revision,1);
  assert.equal(fresh.row().dirty,1);
  assert.equal(fresh.row().eligibility_valid_until_ms,0);
  assert.equal((await advanceQaPrimaryDenialEpoch(fresh.env)).applied,false);
  assert.equal(fresh.row().publication_revision,1,"replay cannot bump the primary epoch");
  fresh.state.epoch=2;
  assert.equal((await advanceQaPrimaryDenialEpoch(fresh.env)).applied,true);
  assert.equal(fresh.row().owner_mutation_epoch,2);
  assert.equal(fresh.row().pending_withdrawals,3);

  for(const illegal of [
    "UPDATE "+FENCE+" SET owner_mutation_epoch=1",
    "UPDATE "+FENCE+" SET dirty=0",
    "UPDATE "+FENCE+" SET pending_withdrawals=0",
    "UPDATE "+FENCE+" SET owner_rehearsal_revision='B'",
    "UPDATE "+FENCE+" SET eligibility_valid_until_ms=9999999999999",
    "UPDATE "+FENCE+" SET publication_revision=0",
    "DELETE FROM "+FENCE,
    "INSERT INTO "+FENCE+" SELECT * FROM "+FENCE
  ]){
    assert.throws(()=>fresh.db.exec(illegal),/qa_|CHECK constraint/);
  }
  assert.equal(fresh.row().owner_mutation_epoch,2);
  fresh.db.exec("BEGIN");
  fresh.db.prepare(QA_NEGATIVE_PRIMARY_CAS_SQL).get(
    3,"cove.qa.owner-primary-read-bracket.v1",QA_ID,VERSION,"A",2,2,3
  );
  fresh.db.exec("ROLLBACK");
  assert.equal(fresh.row().owner_mutation_epoch,2,"negative publication must roll back atomically");

  fresh.state.epoch=3;
  fresh.state.rollbackNext=true;
  await assert.rejects(advanceQaPrimaryDenialEpoch(fresh.env),refusal);
  assert.equal(fresh.row().owner_mutation_epoch,2,"reported but rolled back CAS cannot be acknowledged");
  assert.equal((await advanceQaPrimaryDenialEpoch(fresh.env)).applied,true);
  assert.equal(fresh.row().owner_mutation_epoch,3);

  fresh.state.epoch=4;
  fresh.state.competeNext=true;
  await assert.rejects(advanceQaPrimaryDenialEpoch(fresh.env),refusal);
  assert.equal(fresh.row().owner_mutation_epoch,4,"competing CAS remains negative-only");
  assert.equal((await advanceQaPrimaryDenialEpoch(fresh.env)).applied,false);

  fresh.state.epoch=5;
  fresh.state.beforeOwnerResponse=(n)=>{if(n===fresh.state.ownerCalls&&fresh.state.injectLater){
    fresh.state.injectLater=false;fresh.state.epoch=6;
  }};
  const oldOwnerCalls=fresh.state.ownerCalls;
  fresh.state.beforeOwnerResponse=(n)=>{
    if(n===oldOwnerCalls+2)fresh.state.epoch=6;
  };
  await assert.rejects(advanceQaPrimaryDenialEpoch(fresh.env),refusal);
  assert.equal(fresh.row().owner_mutation_epoch,5,"publisher dirtied D1 before owner advanced again");
  assert.equal((await advanceQaPrimaryDenialEpoch(fresh.env)).applied,true);
  assert.equal(fresh.row().owner_mutation_epoch,6);
  assert.equal(fresh.row().dirty,1);
  assert.equal(fresh.row().eligibility_valid_until_ms,0);
  assert.ok(fresh.state.primarySessions>=fresh.state.primaryReads,
    "every publication SELECT/UPDATE has an independent first-primary session");
}finally{fresh.close();}

for(const change of [
  f=>{f.env.primaryId="4bd657ac-8789-403e-a28c-93aba8d0a989";},
  f=>{f.env.journalVersion="invalid";},
  f=>{f.env.secret="invalid";},
  f=>{f.state.ownerStatus=503;},
  f=>{f.state.revision="B";},
  f=>{f.state.epoch=0;},
  f=>{f.state.epoch=9007199254740992;}
]){
  const f=fixture();
  try{
    change(f);
    await assert.rejects(advanceQaPrimaryDenialEpoch(f.env));
    assert.equal(f.row().owner_mutation_epoch,0);
    assert.equal(f.row().dirty,1);
  }finally{f.close();}
}
const corrupt=fixture();
try{
  corrupt.db.exec("DROP TRIGGER cove_qa_negative_publication_update");
  corrupt.db.exec("UPDATE "+FENCE+" SET publication_revision=9007199254740991");
  // An adversary with schema-change privileges is out of scope; still deny
  // revision exhaustion rather than silently wrap to an apparent valid epoch.
  await assert.rejects(advanceQaPrimaryDenialEpoch(corrupt.env),refusal);
}finally{corrupt.close();}

const backend=readFileSync("src/persistence-backend.worker.ts","utf8");
assert.doesNotMatch(backend,/owner-primary-denial-publication\.stage/);
assert.match(sql,/ISOLATED QA ONLY/);
assert.match(source,/qa_negative_only_owner_publication_required|negativeOnly/);
assert.ok(!source.includes("COVE_RIGHTS_OWNER_ENABLED=\"1\""));
console.log("PASS: isolated SQLite atomic negative-only owner publication, replay, " +
  "concurrent CAS, rollback, owner ACK race, malformed receipts and sealed rights");
