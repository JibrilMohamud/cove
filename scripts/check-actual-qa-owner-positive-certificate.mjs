/* eslint-disable prettier/prettier -- Actual owner handler/SQLite QA integration, no live access. */
import assert from "node:assert/strict";
import {build} from "esbuild";
import {DatabaseSync} from "node:sqlite";
import {mkdtempSync,readFileSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import path from "node:path";
import {pathToFileURL} from "node:url";

const folder=mkdtempSync(path.join(tmpdir(),"cove-actual-owner-positive-"));
const qaId="7c7ab994-f6b3-419d-a72d-71eb9ea22e7e";
const prodId="4bd657ac-8789-403e-a28c-93aba8d0a989";
const version="a".repeat(64),secret="b".repeat(64);
const positiveRoute="/qa/positive-generation-certificate";
const currentRoute="/qa/current-mutation-fence";
const wait=async()=>{};
try{
  await build({
    entryPoints:["src/storefront-strangler/legal-authority.worker.ts"],
    outfile:path.join(folder,"owner.mjs"),bundle:true,platform:"node",
    format:"esm",target:"node22",logLevel:"silent",
    plugins:[{
      name:"owner-host",
      setup(b){
        b.onResolve({filter:/^cloudflare:workers$/},()=>
          ({path:"host",namespace:"host"}));
        b.onLoad({filter:/.*/,namespace:"host"},()=>
          ({contents:"export class DurableObject {constructor(ctx,env){this.ctx=ctx;this.env=env;}}"}));
      }
    }],
  });
  await build({
    entryPoints:["src/storefront-strangler/qa-owner-positive-generation-cas.stage.ts"],
    outfile:path.join(folder,"publish.mjs"),bundle:true,platform:"node",
    format:"esm",target:"node22",logLevel:"silent",
  });
  const [{CoveLegalAuthority,default:entry},
    {publishQaOwnerPositiveGeneration}]=await Promise.all([
    import(pathToFileURL(path.join(folder,"owner.mjs")).href),
    import(pathToFileURL(path.join(folder,"publish.mjs")).href),
  ]);
  async function make({noPositive=false,missingOwnerProof=false,tamperManifest=false,
    productionId=false}={}){
    const ownerDb=new DatabaseSync(":memory:");
    const primaryDb=new DatabaseSync(":memory:");
    const context={ownerDb,primaryDb,owner:null,env:null,closed:false};
    const sql={
      exec(query,...args){
        const stmt=ownerDb.prepare(query);
        const rows=stmt.columns().length?stmt.all(...args):(stmt.run(...args),[]);
        return {toArray:()=>rows};
      }
    };
    const primary={
      withSession(mode){
        assert.equal(mode,"first-primary","no replica or unrestricted D1 session");
        return {
          prepare(query){
            const stmt=primaryDb.prepare(query);
            let args=[];
            return {
              bind(...values){args=values;return this;},
              async first(){
                return stmt.get(...args)??null;
              },
              async all(){
                return {results:stmt.all(...args)};
              }
            };
          },
        };
      }
    };
    const env={
      PRIMARY_DB:primary,
      COVE_RIGHTS_OWNER_ENABLED:"1",
      COVE_RIGHTS_OWNER_PRIMARY_ID:productionId?prodId:qaId,
      COVE_RIGHTS_OWNER_SECRET:secret,
      COVE_RIGHTS_OWNER_TEST_EXPIRES_AT:String(Date.now()+10*60_000),
      COVE_QA_OWNER_JOURNAL_VERSION:version,
      COVE_QA_OWNER_REHEARSAL_REVISION:"A",
      ...(noPositive?{}:{COVE_QA_OWNER_POSITIVE_CERTIFICATE_ONLY:"1"}),
    };
    const storage={
      sql,transactionSync(fn){
        ownerDb.exec("BEGIN");
        try{const out=fn();ownerDb.exec("COMMIT");return out;}
        catch(e){ownerDb.exec("ROLLBACK");throw e;}
      }
    };
    const owner=new CoveLegalAuthority({storage},env);
    env.LEGAL_AUTHORITY={getByName(name){
      assert.equal(name,"cove-staged-legal-global-v1");
      return owner;
    }};
    context.owner=owner;context.env=env;
    const offer=JSON.stringify({type:"public-domain",currency:"USD",amountMinor:0});
    for(const n of ["2701","2702"]){
      sql.exec("INSERT INTO cove_legal_fences VALUES(?, 'US',1,'allow')",n);
      if(!missingOwnerProof||n!=="2702"){
        sql.exec("INSERT INTO cove_authorized_offer_proofs VALUES(?,?,?,?,?,?,?,?,?)",
          n,"US","USD",1,"prd_gutenberg_"+n,"ed_gutenberg_"+n,null,null,offer);
      }
    }
    sql.exec("INSERT INTO cove_legal_fences VALUES('2703','*',1,'deny')");
    sql.exec("INSERT INTO cove_legal_denial_operations VALUES('history-2703','2703','*',1)");
    const epoch=ownerDb.prepare(
      "SELECT epoch FROM cove_qa_current_owner_mutation_fence WHERE slot=1").get().epoch;
    assert.ok(epoch>=5);
    const rows=["2701","2702","2703"].map((n,i)=>({
      generation:9,productId:"prd_gutenberg_"+n,territory:"US",
      allowed:i===2?0:1,proofSha256:["d","e","f"][i].repeat(64),
    }));
    const header={generation:9,primaryId:qaId,journalVersion:version,
      ownerEpoch:epoch,rehearsalRevision:"A",sourceRevision:7,
      territory:"US",catalogRows:3,allowRows:2,denyRows:1};
    const {qaPositiveCandidateDigest}=await import(
      pathToFileURL(path.join(folder,"owner.mjs")).href);
    const digest=await qaPositiveCandidateDigest(header,rows);
    let source=readFileSync(
      "scripts/staging/qa-owner-positive-primary-generation.prototype.sql","utf8");
    for(const [n,id] of [["p1","2701"],["p2","2702"],["p3","2703"]])
      source=source.replaceAll("'"+n+"'","'prd_gutenberg_"+id+"'");
    const oldLine=" 5,'A',7,";
    assert.equal(source.split(oldLine).length,2);
    source=source.replace(oldLine," "+epoch+",'A',7,");
    const legacy="'"+ "c".repeat(64) +"'";
    assert.equal(source.split(legacy).length,2);
    source=source.replace(legacy,"'"+(tamperManifest?"0".repeat(64):digest)+"'");
    primaryDb.exec(source);
    context.epoch=epoch;
    context.post=async(route,body,override=secret)=>{
      return entry.fetch(new Request("https://legal-authority.internal"+route,{
        method:"POST",
        headers:{authorization:"Bearer "+override,"content-type":"application/json"},
        body:JSON.stringify(body),
      }),env);
    };
    context.publisher=()=>publishQaOwnerPositiveGeneration({
      owner:{fetch:request=>entry.fetch(request,env)},
      secret,primary,primaryId:qaId,journalVersion:version,
      COVE_QA_POSITIVE_GENERATION_ONLY:"1",
    });
    context.fence=()=>primaryDb.prepare(
      "SELECT * FROM cove_qa_owner_positive_publication_fence WHERE slot=1").get();
    context.close=()=>{if(!context.closed){
      context.closed=true;ownerDb.close();primaryDb.close();
    }};
    return context;
  }
  const positive=await make();
  try{
    const challenge="c".repeat(32);
    const receipt=await positive.post(positiveRoute,{challenge});
    assert.equal(receipt.status,200,"actual Durable Object should issue QA receipt");
    assert.match(receipt.headers.get("cache-control")||"",/no-store/);
    const body=await receipt.json();
    assert.deepEqual(Object.keys(body).sort(),[
      "schema","authorizing","challenge","primaryId","journalVersion",
      "rehearsalRevision","mutationEpoch","generation","sourceRevision",
      "manifestSha256","territory","catalogRows","allowRows","denyRows",
      "completeHistoricalWithdrawals","completeCatalog","eligibilityValidUntilMs"
    ].sort());
    assert.equal(body.authorizing,true);
    assert.equal(body.challenge,challenge);
    assert.equal(body.mutationEpoch,String(positive.epoch));
    assert.equal(body.catalogRows,3);
    assert.equal(body.allowRows,2);
    assert.equal(body.denyRows,1);
    assert.equal(body.completeHistoricalWithdrawals,true);
    assert.ok(body.eligibilityValidUntilMs>Date.now());
    assert.ok(body.eligibilityValidUntilMs<=Date.now()+26_000);
    assert.equal((await positive.post(positiveRoute,{challenge,allow:true})).status,400);
    assert.equal((await positive.post(positiveRoute,{challenge},"bad")).status,401);
    // The real owner's authenticated, challenge-bound certificate now drives
    // the actual isolated QA primary-D1 single-statement generation CAS.
    const committed=await positive.publisher();
    assert.equal(committed.primaryCommitted,true);
    assert.equal(committed.authorizing,false);
    assert.equal(positive.fence().active_generation,9);
    assert.equal(positive.fence().dirty,0);
    // Immediate independent owner acknowledgement MUST prevent stale use even
    // if the separate D1 generation is clean until explicit reconciliation.
    const withdrawal=await positive.post("/deny-next",{
      sourceId:"2701",territory:"*",operationId:"after-publish-2701",
    });
    assert.equal(withdrawal.status,200);
    assert.ok((await positive.post(currentRoute,{challenge})).status===200);
    assert.equal((await positive.post(positiveRoute,{challenge})).status,503,
      "owner no longer certifies outdated candidate");
    await assert.rejects(positive.publisher());
    assert.equal(positive.fence().active_generation,9,
      "test publisher never silently unpublishes an active generation");
    // This can remain clean in D1 until owner-denial reconciliation. A reader
    // must bracket the grant with the current owner, not trust D1 alone.
    assert.equal(positive.fence().dirty,0);
  }finally{positive.close();}

  const tests=[
    ["owner issuer opt-in absent",{noPositive:true},503],
    ["positive owner offer proof missing",{missingOwnerProof:true},503],
    ["candidate cryptographic manifest mismatch",{tamperManifest:true},503],
    ["production identity cannot obtain QA lease",{productionId:true},503],
  ];
  for(const [label,opts,expected] of tests){
    const x=await make(opts);
    try{
      const res=await x.post(positiveRoute,{challenge:"c".repeat(32)});
      assert.equal(res.status,expected,label);
      assert.equal(x.fence().dirty,1,label+" never unlocks D1");
    }finally{x.close();}
  }
  const raced=await make();
  try{
    const current=raced.env.PRIMARY_DB;
    let injected=false;
    raced.env.PRIMARY_DB={
      withSession(mode){
        const inner=current.withSession(mode);
        return {
          prepare(query){
            const stmt=inner.prepare(query);
            return {
              bind(...args){stmt.bind(...args);return this;},
              async first(){
                const value=await stmt.first();
                if(!injected && query.includes(
                  "FROM cove_qa_owner_positive_candidate ORDER BY")){
                  injected=true;
                  const denied=await raced.post("/deny-next",{
                    sourceId:"2702",territory:"*",operationId:"race-2702",
                  });
                  assert.equal(denied.status,200);
                }
                return value;
              },
              async all(){return stmt.all();}
            };
          }
        };
      }
    };
    assert.equal((await raced.post(positiveRoute,{challenge:"e".repeat(32)})).status,503);
    assert.equal(raced.fence().dirty,1);
  }finally{raced.close();}
  console.log("PASS: actual owner DO current positive certificate + full QA D1 digest/"+
    " legal/offer evidence, independent publication CAS, source-denial race, "+
    " credential/production lock; NOT certified production historical migration.");
}finally{
  rmSync(folder,{recursive:true,force:true});
}
