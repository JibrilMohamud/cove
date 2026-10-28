/* eslint-disable prettier/prettier -- Canonical publication writes must execute under a durable product hold. */
import assert from "node:assert/strict";
import {DatabaseSync} from "node:sqlite";
import {build} from "esbuild";
import {mkdtempSync,readdirSync,readFileSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {pathToFileURL} from "node:url";
const directory=mkdtempSync(join(tmpdir(),"cove-publication-owner-"));
const databases=[];
try {
  const load=async(entry,name,host=false)=>{
    const outfile=join(directory,name+".mjs");
    await build({entryPoints:[entry],outfile,bundle:true,format:"esm",platform:"node",
      target:"node22",alias:{jszip:"jszip/dist/jszip.min.js"},logLevel:"silent",
      plugins:host?[{name:"test-do-host",setup(b){
        b.onResolve({filter:/^cloudflare:workers$/},()=>({path:"host",namespace:"test-host"}));
        b.onLoad({filter:/.*/,namespace:"test-host"},()=>({contents:
          "export class DurableObject {constructor(ctx,env){this.ctx=ctx;this.env=env;}}"}));
      }}]:[]});
    return import(pathToFileURL(outfile).href);
  };
  const {CoveLegalAuthority}=await load("src/storefront-strangler/legal-authority.worker.ts","owner",true);
  const legal=await load("src/storefront-strangler/commercial-legal-core.ts","legal");
  const commandCore=await load("src/storefront-strangler/publication-command-core.ts","command");
  const bindingsFile=join(directory,"bindings.mjs");
  await build({stdin:{contents:
    'export * from "./src/features/fore/publishing.server.ts"; export * from "./src/storefront-strangler/publication-owner-routing.server.ts";',
    resolveDir:process.cwd()},outfile:bindingsFile,bundle:true,format:"esm",platform:"node",target:"node22",
    alias:{jszip:"jszip/dist/jszip.min.js"},logLevel:"silent"});
  const publisher=await import(pathToFileURL(bindingsFile).href),routing=publisher;
  const primaryTemplate=new DatabaseSync(":memory:");databases.push(primaryTemplate);
  for(const file of readdirSync("drizzle").filter(f=>f.endsWith(".sql")).sort())
    primaryTemplate.exec(readFileSync(join("drizzle",file),"utf8"));
  const migrations=primaryTemplate.prepare("SELECT sql FROM sqlite_master WHERE sql IS NOT NULL").all();
  // Keep a real fully migrated primary for each case, including all triggers
  // and foreign keys, rather than simulating publication SQL with a mock.
  const productId="prd_owner_publication",versionId="pubv_owner_publication";
  const secret="c".repeat(64),at="2026-01-01T00:00:00.000Z";
  function fixture({releaseDate=at}={}){
    const primary=new DatabaseSync(":memory:"),owned=new DatabaseSync(":memory:");
    databases.push(primary,owned);
    for(const file of readdirSync("drizzle").filter(f=>f.endsWith(".sql")).sort())
      primary.exec(readFileSync(join("drizzle",file),"utf8"));
    primary.exec("PRAGMA foreign_keys=ON");
    const insert=(table,row)=>{
      const keys=Object.keys(row);primary.prepare(`INSERT INTO ${table}(${keys.join(',')}) VALUES(${keys.map(()=>'?').join(',')})`)
        .run(...keys.map(k=>row[k]));
    };
    insert("works",{id:"wrk_owner_publication",title:"Owner publication",created_at:at,updated_at:at});
    insert("editions",{id:"ed_owner_publication",work_id:"wrk_owner_publication",title:"Owner publication",
      release_status:"scheduled",created_at:at,updated_at:at});
    insert("products",{id:productId,edition_id:"ed_owner_publication",sku:productId,format:"ebook",
      source_name:"publisher",source_external_id:productId,storefront_status:"inactive",created_at:at,updated_at:at});
    insert("publishing_accounts",{id:"puba_owner_publication",account_type:"person",legal_name:"Fixture Publisher",
      display_name:"Fixture Publisher",country_code:"US",status:"active",identity_status:"verified",
      tax_status:"verified",payout_status:"verified",created_at:at,updated_at:at});
    insert("publishing_titles",{id:"pubt_owner_publication",account_id:"puba_owner_publication",title:"Owner publication",created_at:at,updated_at:at});
    insert("publishing_edition_drafts",{id:"pubed_owner_publication",title_id:"pubt_owner_publication",created_at:at,updated_at:at});
    insert("publishing_submission_snapshots",{id:"pubsub_owner_publication",edition_id:"pubed_owner_publication",
      account_id:"puba_owner_publication",revision:1,snapshot_json:"{}",snapshot_sha256:"d".repeat(64),
      status:"published",submitted_by_user_id:"user_owner_publication",submitted_at:at});
    insert("publishing_publications",{id:"pub_owner_publication",submission_id:"pubsub_owner_publication",
      publishing_account_id:"puba_owner_publication",work_id:"wrk_owner_publication",edition_id:"ed_owner_publication",
      product_id:productId,materialization_key:productId,published_at:at});
    insert("publishing_release_lifecycles",{id:"life_owner_publication",publishing_edition_id:"pubed_owner_publication",
      state:"scheduled",pending_publication_version_id:versionId,created_at:at,updated_at:at});
    const manifest={workId:"wrk_owner_publication",catalogEditionId:"ed_owner_publication",productId,
      metadata:{title:"Owner publication",language:"en",releaseDate},rightsGrantIds:["rgrant_owner_publication"],
      rightsContractId:"rcontract_owner_publication",rightsContractVersionId:"rcv_owner_publication",
      rightsContractManagedByPublication:false,offerId:"off_owner_publication"};
    insert("publishing_publication_versions",{id:versionId,lifecycle_id:"life_owner_publication",publication_id:"pub_owner_publication",
      submission_id:"pubsub_owner_publication",version_number:1,snapshot_sha256:"d".repeat(64),manifest_json:JSON.stringify(manifest),
      release_state:"scheduled",created_by_user_id:"user_owner_publication",created_at:at});
    insert("rights_parties",{id:"rparty_owner_publication",display_name:"Fixture licensor",status:"active",created_at:at,updated_at:at});
    insert("rights_contracts",{id:"rcontract_owner_publication",reference_code:"owner-fixture",name:"Fixture contract",
      rightsholder_party_id:"rparty_owner_publication",status:"active",created_at:at,updated_at:at});
    insert("rights_contract_versions",{id:"rcv_owner_publication",contract_id:"rcontract_owner_publication",version_number:1,
      status:"active",effective_from:at,retailer_commission_bps:3000,created_at:at});
    insert("rights_grants",{id:"rgrant_owner_publication",edition_id:"ed_owner_publication",rightsholder_party_id:"rparty_owner_publication",
      territory_code:"US",format:"ebook",license_type:"commercial",contract_id:"rcontract_owner_publication",
      contract_version_id:"rcv_owner_publication",decision:"allow",status:"draft",created_at:at,updated_at:at});
    insert("offers",{id:"off_owner_publication",product_id:productId,offer_type:"purchase",currency:"USD",amount_minor:399,
      active:0,created_at:at,updated_at:at});
    insert("catalog_search_documents",{product_id:productId,external_book_id:productId,title:"Owner publication",currency:"USD",
      availability:"available",suppressed:0,first_ingested_at:at,updated_at:at});
    const sql={exec(query,...args){const q=owned.prepare(query);
      const rows=q.columns().length?q.all(...args):(q.run(...args),[]);return {toArray:()=>rows};}};
    let beforeWrite=null,reads=0,writes=0,failWrites=false,failOwnerCommit=false;
    const DB={prepare(query){
      function bound(args=[]){return {bind:(...a)=>bound(a),
        async first(){reads++;return primary.prepare(query).get(...args)||null;},
        async all(){reads++;return {results:primary.prepare(query).all(...args)};},
        async run(){
          writes++;if(beforeWrite)await beforeWrite(query);
          if(failWrites)throw Error("simulated_primary_unavailable");
          const q=primary.prepare(query);return q.columns().length?
            {results:q.all(...args),success:true,meta:{changes:0}}:
            {success:true,meta:{changes:Number(q.run(...args).changes)}};
        }};}
      return bound();
    },async batch(statements){primary.exec("BEGIN");try{
      const results=[];for(const stmt of statements)results.push(await stmt.run());
      primary.exec("COMMIT");return results;
    }catch(error){primary.exec("ROLLBACK");throw error;}}};
    const env={PRIMARY_DB:DB,COVE_RIGHTS_OWNER_ENABLED:"1",COVE_RIGHTS_OWNER_PRIMARY_ID:"7c7ab994-f6b3-419d-a72d-71eb9ea22e7e",
      COVE_RIGHTS_OWNER_SECRET:secret,COVE_RIGHTS_OWNER_TEST_EXPIRES_AT:String(Date.now()+10*60_000)};
    const ctx={storage:{sql,transactionSync(fn){owned.exec("BEGIN");try{const r=fn();
      if(failOwnerCommit&&owned.prepare("SELECT 1 ok FROM cove_publication_commands WHERE state='committed'").get())
        throw Error("simulated_owner_commit_interruption");
      owned.exec("COMMIT");return r;}
      catch(error){owned.exec("ROLLBACK");throw error;}}}};
    let owner=new CoveLegalAuthority(ctx,env);
    const post=(path,body)=>owner.fetch(new Request("https://legal-authority.internal"+path,{
      method:"POST",headers:{authorization:"Bearer "+secret,"content-type":"application/json"},body:JSON.stringify(body)
    }));
    const command={operationId:"publication:test:01",publicationVersionId:versionId,
      actorUserId:null,triggerType:"schedule",territory:"US",currency:"USD"};
    return {primary,owned,DB,env,sql,command,post,
      activate:(overrides={})=>post("/publication/activate-version",{...command,...overrides}),
      setBeforeWrite(fn){beforeWrite=fn;},setFailWrites(value){failWrites=value;},
      setFailOwnerCommit(value){failOwnerCommit=value;},
      restart(){owner=new CoveLegalAuthority(ctx,env);},
      stats:()=>({reads,writes})};
  }
  const f=fixture();let observed=0;
  assert.equal((await f.activate({triggerType:"rollback",actorUserId:"user_unprivileged"})).status,403);
  assert.equal(f.stats().writes,0,"The owner independently checks current staff permission before activation");
  f.setBeforeWrite(async()=>{
    observed++;
    if(observed===1)assert.equal((await f.activate()).status,409,
      "Concurrent duplicate command may not enter a second primary executor");
    assert.equal(f.owned.prepare("SELECT verdict FROM cove_commercial_authority WHERE product_id=?").get(productId).verdict,"deny");
    assert.equal(f.owned.prepare("SELECT COUNT(*) n FROM cove_publication_commands WHERE product_id=? AND state='pending'")
      .get(productId).n,1,"Durable owner hold must precede EVERY primary mutation");
    const competing=await f.post("/commercial/publish-verified",{productId,territory:"US",channel:"retail"});
    assert.notEqual(competing.status,200,"Independent publisher cannot regrant an intermediate primary state");
  });
  const response=await f.activate();
  assert.equal(response.status,200,await response.text());
  assert.ok(observed>10,"Actual multi-table publication implementation must run");
  assert.equal(f.primary.prepare("SELECT state FROM publishing_release_lifecycles WHERE id='life_owner_publication'").get().state,"live");
  assert.equal(f.owned.prepare("SELECT state FROM cove_publication_commands").get().state,"committed");
  assert.equal(legal.readCommercialProofs(f.sql,[productId],"US","retail").length,1);
  const previousWrites=f.stats().writes;
  assert.equal((await f.activate()).status,200);
  assert.equal(f.stats().writes,previousWrites,"Replaying a completed command must not reactivate or rewrite primary state");
  assert.equal((await f.activate({currency:"CAD"})).status,503,"An operation ID cannot change its market identity");

  const failed=fixture();failed.setFailWrites(true);
  assert.equal((await failed.activate()).status,503);
  assert.equal(failed.owned.prepare("SELECT state FROM cove_publication_commands").get().state,"pending");
  failed.restart();failed.setFailWrites(false);
  assert.equal((await failed.activate()).status,503,"An interrupted primary command cannot be blindly replayed after owner restart");
  assert.equal(legal.readCommercialProofs(failed.sql,[productId],"US","retail").length,0);
  assert.equal((await failed.activate({operationId:"publication:steal:02"})).status,503);

  const withdrawn=fixture();let withdrew=false;
  withdrawn.setBeforeWrite(async()=>{
    if(withdrew)return;withdrew=true;
    assert.equal((await withdrawn.post("/commercial/deny-next",{productId,operationId:"rights:withdraw:during-publication"})).status,200);
  });
  assert.equal((await withdrawn.activate()).status,503);
  assert.equal(legal.readCommercialProofs(withdrawn.sql,[productId],"US","retail").length,0,
    "A withdrawal acknowledged during primary writes must defeat completion and positive publication");

  // Complete primary marker + durable pending owner state is the ONLY
  // automatic restart recovery: it revalidates current evidence, never D1 writes.
  const recovery=fixture();recovery.setFailOwnerCommit(true);
  assert.equal((await recovery.activate()).status,503);
  assert.equal(recovery.owned.prepare("SELECT state FROM cove_publication_commands").get().state,"pending");
  recovery.restart();recovery.setFailOwnerCommit(false);const recoveredWrites=recovery.stats().writes;
  assert.equal((await recovery.activate({operationId:"publication:lost-response:new-id"})).status,200);
  assert.equal(recovery.stats().writes,recoveredWrites);
  assert.equal((await f.post("/commercial/deny-next",{productId,operationId:"retail:withdraw-after-activation"})).status,200);
  assert.equal((await f.activate()).status,503,
    "A completed old activation cannot reinstate an offer after a later owner withdrawal, even if primary D1 still looks active");
  assert.equal((await f.activate({operationId:"publication:old-version:new-id"})).status,409,
    "Changing only the transport ID does not make a withdrawn old publication fresh evidence");

  assert.throws(()=>routing.scopePublicationOwnerEnv({DB:f.DB,COVE_PUBLICATION_COMMANDS_ENABLED:"1",COVE_SSR_STAGING:"0"}),
    /not_certified/);
  const noOwner={DB:f.DB};assert.equal(routing.scopePublicationOwnerEnv(noOwner),noOwner);
  const caller=fixture();let dispatched=0;
  const callerDB=routing.bindPublicationOwner(caller.DB,{
    secret,territory:"US",currency:"USD",owner:{async fetch(request){
      assert.equal(new URL(request.url).pathname,"/publication/activate-version");
      const input=await request.json();dispatched++;
      assert.equal(input.publicationVersionId,versionId);
      return Response.json({schema:"cove.publication-activation.v1",ownerFirst:true,
        operationId:input.operationId,publicationVersionId:versionId,state:"live",versionNumber:1});
    }}
  });
  const scheduled=await publisher.advancePublishingReleaseSchedules(callerDB);
  assert.equal(dispatched,1);assert.equal(scheduled.advanced.length,1);
  assert.equal(caller.stats().writes,0,"Scheduled activation caller must not execute canonical writes outside owner");
  await assert.rejects(publisher.activatePublicationVersionOwned(callerDB,versionId,null,"staff"),
    /inside the legal owner/);
  const restricted=fixture();
  restricted.primary.prepare("UPDATE publishing_accounts SET identity_status='expired'").run();
  assert.equal((await restricted.activate()).status,409);
  assert.equal(restricted.stats().writes,0,"Expired publisher compliance cannot start canonical activation");
  const premature=fixture({releaseDate:new Date(Date.now()+86400000).toISOString()});
  assert.equal((await premature.activate()).status,409);
  assert.equal(premature.stats().writes,0,"The owner independently enforces the scheduled release date");
  const unavailable=fixture();unavailable.env.COVE_RIGHTS_OWNER_ENABLED="0";
  assert.equal((await unavailable.activate()).status,503);
  assert.equal(unavailable.stats().writes,0,"Owner outage cannot fall back to caller-side activation writes");
  assert.ok(migrations.length>100);assert.ok(publisher.activatePublicationVersionOwned);
  assert.ok(commandCore.beginPublicationCommand);
  console.log("PASS: actual canonical activation runs under durable owner hold; fresh rights/offer publication, replay, restart, primary outage and concurrent withdrawal are fenced");
} finally {for(const db of databases)db.close();rmSync(directory,{recursive:true,force:true});}
