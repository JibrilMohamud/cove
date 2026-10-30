/* eslint-disable prettier/prettier -- Canonical publication writes must execute under a durable product hold. */
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
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
  const storefront=await load("src/storefront-strangler/commercial-storefront-authority.ts","storefront");
  const commandCore=await load("src/storefront-strangler/publication-command-core.ts","command");
  const bindingsFile=join(directory,"bindings.mjs");
  await build({stdin:{contents:
    'export * from "./src/features/fore/publishing.server.ts"; export * from "./src/storefront-strangler/publication-owner-routing.server.ts"; export * from "./src/storefront-strangler/legal-primary-write-lock.ts";',
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
  function fixture({releaseDate=at,preorderDate=null,initialCurrent=false,retirePrevious=false,legacyPrior=false,retainGrant=false,snapshotJson="{}"}={}){
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
    const snapshotHash=createHash("sha256").update("{}").digest("hex");
    insert("publishing_submission_snapshots",{id:"pubsub_owner_publication",edition_id:"pubed_owner_publication",
      account_id:"puba_owner_publication",revision:1,snapshot_json:snapshotJson,snapshot_sha256:snapshotHash,
      status:"published",submitted_by_user_id:"user_owner_publication",submitted_at:at});
    insert("publishing_publications",{id:"pub_owner_publication",submission_id:"pubsub_owner_publication",
      publishing_account_id:"puba_owner_publication",work_id:"wrk_owner_publication",edition_id:"ed_owner_publication",
      product_id:productId,materialization_key:productId,published_at:at});
    insert("publishing_release_lifecycles",{id:"life_owner_publication",publishing_edition_id:"pubed_owner_publication",
      state:"scheduled",pending_publication_version_id:versionId,created_at:at,updated_at:at});
    const manifest={schemaVersion:4,submissionId:"pubsub_owner_publication",snapshotSha256:snapshotHash,workId:"wrk_owner_publication",catalogEditionId:"ed_owner_publication",productId,
      metadata:{title:"Owner publication",language:"en",releaseDate,preorderDate},rightsGrantIds:["rgrant_owner_publication"],
      rightsContractId:"rcontract_owner_publication",rightsContractVersionId:"rcv_owner_publication",
      rightsContractManagedByPublication:false,offerId:"off_owner_publication"};
    insert("publishing_publication_versions",{id:versionId,lifecycle_id:"life_owner_publication",publication_id:"pub_owner_publication",
      submission_id:"pubsub_owner_publication",version_number:retirePrevious?2:1,snapshot_sha256:snapshotHash,manifest_json:JSON.stringify(manifest),
      release_state:"scheduled",created_by_user_id:"user_owner_publication",created_at:at});
    insert("rights_parties",{id:"rparty_owner_publication",display_name:"Fixture licensor",status:"active",created_at:at,updated_at:at});
    insert("rights_contracts",{id:"rcontract_owner_publication",reference_code:"owner-fixture",name:"Fixture contract",
      rightsholder_party_id:"rparty_owner_publication",status:"active",created_at:at,updated_at:at});
    insert("rights_contract_versions",{id:"rcv_owner_publication",contract_id:"rcontract_owner_publication",version_number:1,
      status:"active",effective_from:at,retailer_commission_bps:3000,created_at:at});
    insert("rights_grants",{id:"rgrant_owner_publication",edition_id:"ed_owner_publication",rightsholder_party_id:"rparty_owner_publication",
      territory_code:"US",format:"ebook",license_type:"commercial",contract_id:"rcontract_owner_publication",
      contract_version_id:"rcv_owner_publication",decision:"allow",status:retainGrant?"active":"draft",created_at:at,updated_at:at});
    insert("offers",{id:"off_owner_publication",product_id:productId,offer_type:"purchase",currency:"USD",amount_minor:399,
      active:0,created_at:at,updated_at:at});
    insert("catalog_search_documents",{product_id:productId,external_book_id:productId,title:"Owner publication",currency:"USD",
      availability:"available",suppressed:0,first_ingested_at:at,updated_at:at});
    if(initialCurrent)primary.prepare("UPDATE publishing_release_lifecycles SET current_publication_version_id=?,pending_publication_version_id=NULL").run(versionId);
    if(retirePrevious){
      insert("rights_contracts",{id:"rcontract_owner_previous",reference_code:"owner-previous",name:"Previous contract",
        rightsholder_party_id:"rparty_owner_publication",status:"active",created_at:at,updated_at:at});
      insert("rights_contract_versions",{id:"rcv_owner_previous",contract_id:"rcontract_owner_previous",version_number:1,
        status:"active",effective_from:at,retailer_commission_bps:3000,created_at:at});
      insert("rights_grants",{id:"rgrant_owner_previous",edition_id:"ed_owner_publication",rightsholder_party_id:"rparty_owner_publication",
        territory_code:"US",format:"ebook",license_type:"commercial",contract_id:"rcontract_owner_previous",
        contract_version_id:"rcv_owner_previous",decision:"allow",status:retainGrant?"revoked":"active",created_at:at,updated_at:at});
      insert("publishing_submission_snapshots",{id:"pubsub_owner_previous",edition_id:"pubed_owner_publication",
        account_id:"puba_owner_publication",revision:2,snapshot_json:"{}",snapshot_sha256:"e".repeat(64),
        status:"published",submitted_by_user_id:"user_owner_publication",submitted_at:at});
      const previous=retainGrant?{...manifest}:{...manifest,rightsGrantIds:legacyPrior?[]:["rgrant_owner_previous"],
        rightsContractId:"rcontract_owner_previous",rightsContractVersionId:"rcv_owner_previous",rightsContractManagedByPublication:true};
      insert("publishing_publication_versions",{id:"pubv_owner_previous",lifecycle_id:"life_owner_publication",publication_id:"pub_owner_publication",
        submission_id:"pubsub_owner_previous",version_number:1,snapshot_sha256:"e".repeat(64),manifest_json:JSON.stringify(previous),
        release_state:"live",created_by_user_id:"user_owner_publication",created_at:at});
      primary.prepare("UPDATE publishing_release_lifecycles SET current_publication_version_id='pubv_owner_previous',state='scheduled'").run();
    }
    let failMarkPublished=false;
    const sql={exec(query,...args){
      if(failMarkPublished&&/UPDATE cove_publication_commands SET published_epoch/.test(query))
        throw Error("simulated_final_publication_epoch_interruption");
      const q=owned.prepare(query);
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
      preorder:(overrides={})=>post("/publication/open-preorder",{operationId:"preorder:test:01",publicationVersionId:versionId,territory:"US",currency:"USD",...overrides}),
      setBeforeWrite(fn){beforeWrite=fn;},setFailWrites(value){failWrites=value;},
      setFailOwnerCommit(value){failOwnerCommit=value;},
      setFailMarkPublished(value){failMarkPublished=value;},
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
      const path=new URL(request.url).pathname,input=await request.json();
      if(path==="/publication/recover-recorded")return Response.json({
        schema:"cove.publication-recovery.v1",ownerFirst:true,operationId:input.operationId,
        checked:0,recovered:0,blocked:0});
      assert.equal(path,"/publication/activate-version");dispatched++;
      assert.equal(input.publicationVersionId,versionId);
      return Response.json({schema:"cove.publication-activation.v1",ownerFirst:true,
        operationId:input.operationId,publicationVersionId:versionId,state:"live",versionNumber:1});
    }}
  });
  const scheduled=await publisher.advancePublishingReleaseSchedules(callerDB);
  assert.equal(dispatched,1);assert.equal(scheduled.advanced.length,1);
  assert.equal(caller.stats().writes,0,"Scheduled activation caller must not execute canonical writes outside owner");
  await assert.rejects(publisher.activatePublicationVersionOwned(callerDB,versionId,null,"staff"),
    /requires its private owner/);
  const restricted=fixture();
  restricted.primary.prepare("UPDATE publishing_accounts SET identity_status='expired'").run();
  assert.equal((await restricted.activate()).status,409);
  assert.equal(restricted.stats().writes,0,"Expired publisher compliance cannot start canonical activation");
  const premature=fixture({releaseDate:new Date(Date.now()+86400000).toISOString()});
  assert.equal((await premature.activate()).status,409);
  assert.equal(premature.stats().writes,0,"The owner independently enforces the scheduled release date");
  for(const [legacyPrior,primaryOutage] of [[false,false],[true,false],[false,true]]){
    const shared=fixture({retirePrevious:true,legacyPrior});
    const otherProducts=["prd_shared_prior_grant","prd_shared_prior_contract"];
    for(const [index,otherProduct] of otherProducts.entries())
      assert.equal(legal.publishFreshCommercialProof(shared.sql,{
        productId:otherProduct,editionId:"ed_owner_publication",territory:"US",channel:"retail",
        grantId:index?"rgrant_other_contract_product":"rgrant_owner_previous",
        contractId:"rcontract_owner_previous",contractVersionId:"rcv_owner_previous",
        validUntil:new Date(Date.now()+60000).toISOString()
      },0).applied,true);
    assert.equal(legal.readCommercialProofs(shared.sql,otherProducts,"US","retail").length,2);
    shared.setBeforeWrite(async()=>{
      assert.equal(legal.readCommercialProofs(shared.sql,otherProducts,"US","retail").length,0,
        "Retiring a grant or managed contract must deny every other product BEFORE canonical activation writes");
    });
    shared.setFailWrites(primaryOutage);
    assert.equal((await shared.activate()).status,primaryOutage?503:200);
    assert.equal(legal.readCommercialProofs(shared.sql,otherProducts,"US","retail").length,0);
    assert.equal(shared.primary.prepare("SELECT status FROM rights_contracts WHERE id='rcontract_owner_previous'").get().status,
      primaryOutage?"active":"terminated","Owner withdrawal must remain effective against stale primary contract state");
  }
  const retained=fixture({retirePrevious:true,retainGrant:true});
  assert.equal(legal.publishFreshCommercialProof(retained.sql,{
    productId,editionId:"ed_owner_publication",territory:"US",channel:"retail",
    grantId:"rgrant_owner_publication",contractId:"rcontract_owner_publication",contractVersionId:"rcv_owner_publication",
    validUntil:new Date(Date.now()+60000).toISOString()
  },0).applied,true);
  storefront.publishCommercialStorefront(retained.sql,{
    product_id:productId,edition_id:"ed_owner_publication",territory:"US",currency:"USD",rights_epoch:1,
    grant_id:"rgrant_owner_publication",contract_id:"rcontract_owner_publication",contract_version_id:"rcv_owner_publication",
    product_public_id:null,edition_public_id:null,
    offer_json:JSON.stringify({type:"purchase",currency:"USD",amountMinor:399}),
    valid_until:legal.readCommercialProofs(retained.sql,[productId],"US","retail")[0].valid_until,
  });
  assert.equal((await retained.activate()).status,200,
    "A metadata/version update retaining the exact approved grant cannot revoke that same grant during activation");
  assert.equal(storefront.readCommercialStorefront(retained.sql,[productId],"US","USD").length,1,
    "A completed publication update retaining its prior valid offer must remain visible");
  assert.equal(retained.primary.prepare("SELECT status FROM rights_grants WHERE id='rgrant_owner_publication'").get().status,"active");
  assert.equal(retained.owned.prepare("SELECT COUNT(*) n FROM cove_commercial_subject_denials WHERE subject_id='rgrant_owner_publication'").get().n,0);

  const invalidActivationSnapshot=fixture({snapshotJson:'{"changed":true}'});
  assert.equal((await invalidActivationSnapshot.activate()).status,409);
  assert.equal(invalidActivationSnapshot.stats().writes,0,"Activation hashes the immutable approved snapshot before its first owner hold or primary write");
  const initial=fixture({initialCurrent:true});
  assert.equal((await initial.activate()).status,200,
    "Initial scheduled materialization already points at its target version but still requires real activation");
  assert.ok(initial.stats().writes>10);
  assert.equal(initial.primary.prepare("SELECT state FROM publishing_release_lifecycles").get().state,"live");
  assert.equal((await initial.activate()).status,200,"Recorded initial activation replay stays idempotent");
  const stale=fixture();
  stale.primary.prepare("UPDATE publishing_release_lifecycles SET state='updated',current_publication_version_id=NULL").run();
  assert.equal((await stale.activate()).status,409,"Stale scheduler cannot restore a nonselected publication");
  assert.equal(stale.stats().writes,0);

  function preorderFixture(overrides={}){return fixture({initialCurrent:true,
    releaseDate:new Date(Date.now()+86400000).toISOString(),preorderDate:at,...overrides});}
  const pre=preorderFixture();let preorderWrites=0;
  pre.setBeforeWrite(async()=>{
    preorderWrites++;
    assert.equal(pre.owned.prepare("SELECT verdict FROM cove_commercial_authority WHERE product_id=?").get(productId).verdict,"deny");
    assert.equal(pre.owned.prepare("SELECT COUNT(*) n FROM cove_publication_commands WHERE product_id=? AND state='pending'").get(productId).n,1);
    if(preorderWrites===1)assert.equal((await pre.preorder()).status,409,"No parallel preorder executor may enter");
  });
  const opened=await pre.preorder();
  assert.equal(opened.status,200,await opened.text());
  assert.ok(preorderWrites>5,"Original positive commercial terms and preorder implementation executed");
  assert.equal(pre.primary.prepare("SELECT state FROM publishing_release_lifecycles").get().state,"preorder");
  assert.equal(pre.primary.prepare("SELECT release_status FROM editions").get().release_status,"preorder");
  assert.equal(pre.primary.prepare("SELECT active FROM offers").get().active,1);
  assert.equal(legal.readCommercialProofs(pre.sql,[productId],"US","retail").length,1);
  const beforeReplay=pre.stats().writes;
  assert.equal((await pre.preorder()).status,200);
  assert.equal(pre.stats().writes,beforeReplay,"Exact preorder command replay does not repeat primary side effects");
  assert.equal((await pre.preorder({currency:"CAD"})).status,503,"A preorder operation cannot change currency identity");

  const scheduledClient=preorderFixture();
  const enrolled=routing.bindPublicationOwner(publisher.makeStageLegalWriterLock(scheduledClient.DB),{
    owner:{async fetch(request){assert.equal(request.headers.get("authorization"),"Bearer "+secret);
      return scheduledClient.post(new URL(request.url).pathname,await request.json());}},
    secret,territory:"US",currency:"USD"
  });
  const scheduledResult=await publisher.advancePublishingReleaseSchedules(enrolled);
  assert.equal(scheduledResult.advanced.length,1);
  assert.equal(scheduledResult.advanced[0].state,"preorder",
    "Actual scheduler under legal SQL write lock must route the full positive preorder through its private owner");

  const invalidSnapshot=preorderFixture({snapshotJson:'{"changed":true}'});
  assert.equal((await invalidSnapshot.preorder()).status,409,"Byte hash mismatch refuses positive publication before its hold");
  assert.equal(invalidSnapshot.stats().writes,0);
  const invalidCompliance=preorderFixture();
  invalidCompliance.primary.prepare("UPDATE publishing_accounts SET payout_status='restricted'").run();
  assert.equal((await invalidCompliance.preorder()).status,409);
  assert.equal(invalidCompliance.stats().writes,0);
  const early=fixture({initialCurrent:true,releaseDate:new Date(Date.now()+86400000).toISOString(),
    preorderDate:new Date(Date.now()+3600000).toISOString()});
  assert.equal((await early.preorder()).status,409);
  assert.equal(early.stats().writes,0);
  const outage=preorderFixture();outage.setFailWrites(true);
  assert.equal((await outage.preorder()).status,503);
  assert.equal(legal.readCommercialProofs(outage.sql,[productId],"US","retail").length,0);
  outage.restart();outage.setFailWrites(false);
  assert.equal((await outage.preorder()).status,503,"Incomplete primary preorder command cannot be blindly replayed after restart");
  const repair=preorderFixture();repair.setFailOwnerCommit(true);
  assert.equal((await repair.preorder()).status,503);
  assert.equal(repair.primary.prepare("SELECT state FROM publishing_release_lifecycles").get().state,"preorder");
  const beforeRepair=repair.stats().writes;
  repair.restart();repair.setFailOwnerCommit(false);
  assert.equal((await repair.preorder({operationId:"preorder:response-lost"})).status,200,
    "Complete canonical preorder marker reconciles the exact immutable pending command after restart");
  assert.equal(repair.stats().writes,beforeRepair);
  const withdrawnPre=preorderFixture();let withdrewPre=false;
  withdrawnPre.setBeforeWrite(async()=>{if(!withdrewPre){withdrewPre=true;
    assert.equal((await withdrawnPre.post("/commercial/deny-next",{productId,operationId:"qa:preorder-concurrent-withdrawal"})).status,200);}});
  assert.equal((await withdrawnPre.preorder()).status,503);
  assert.equal(legal.readCommercialProofs(withdrawnPre.sql,[productId],"US","retail").length,0);
  assert.equal((await withdrawnPre.preorder()).status,503,"Replaying old preorder cannot reverse a concurrent withdrawal");

  const ownerDb=f=>routing.bindPublicationOwner(publisher.makeStageLegalWriterLock(f.DB),{
    secret,territory:"US",currency:"USD",owner:{async fetch(request){
      return f.post(new URL(request.url).pathname,await request.json());
    }}
  });
  for(const kind of ["activation","preorder","final-positive-marker"]) {
    const stranded=kind==="preorder"?preorderFixture():fixture();
    if(kind==="final-positive-marker")stranded.setFailMarkPublished(true);
    else stranded.setFailOwnerCommit(true);
    assert.equal((await (kind==="preorder"?stranded.preorder():stranded.activate())).status,503);
    assert.equal(stranded.primary.prepare("SELECT state FROM publishing_release_lifecycles").get().state,
      kind==="preorder"?"preorder":"live");
    const writes=stranded.stats().writes;
    stranded.restart();stranded.setFailOwnerCommit(false);stranded.setFailMarkPublished(false);
    const recovered=await publisher.advancePublishingReleaseSchedules(ownerDb(stranded));
    assert.deepEqual(recovered.recovery,{checked:1,recovered:1,blocked:0},kind+": actual scheduler repairs orphaned owner completion");
    assert.equal(recovered.advanced.length,0,"Completed live/preorder item is not activated again");
    assert.equal(stranded.stats().writes,writes,"Recovery performs no primary mutations");
    assert.equal(legal.readCommercialProofs(stranded.sql,[productId],"US","retail").length,1);
    assert.deepEqual((await publisher.advancePublishingReleaseSchedules(ownerDb(stranded))).recovery,
      {checked:0,recovered:0,blocked:0},"Completed recovery leaves no replayable pending work");
  }
  const incomplete=preorderFixture();let partialWrites=0;
  incomplete.setBeforeWrite(()=>{if(++partialWrites===3)incomplete.setFailWrites(true);});
  assert.equal((await incomplete.preorder()).status,503);
  const incompleteWrites=incomplete.stats().writes;
  incomplete.restart();incomplete.setFailWrites(false);incomplete.setBeforeWrite(null);
  const refused=await incomplete.post("/publication/recover-recorded",{operationId:"recovery:partial"});
  assert.deepEqual(await refused.json(),{schema:"cove.publication-recovery.v1",ownerFirst:true,
    operationId:"recovery:partial",checked:1,recovered:0,blocked:1});
  assert.equal(incomplete.stats().writes,incompleteWrites,"Partial primary command is never blindly replayed");
  assert.equal(legal.readCommercialProofs(incomplete.sql,[productId],"US","retail").length,0);
  const stillWithdrawn=await withdrawnPre.post("/publication/recover-recorded",{operationId:"recovery:withdrawn"});
  assert.equal((await stillWithdrawn.json()).blocked,1,"Recovery cannot reverse concurrent withdrawal");
  assert.equal(legal.readCommercialProofs(withdrawnPre.sql,[productId],"US","retail").length,0);
  assert.equal((await incomplete.post("/publication/recover-recorded",{operationId:"recovery:invalid",sql:"not a typed command"})).status,400);
  const malformedReceipt=routing.bindPublicationOwner(f.DB,{secret,territory:"US",currency:"USD",
    owner:{async fetch(){return Response.json({schema:"cove.publication-recovery.v1",ownerFirst:true,
      operationId:"forged",checked:0,recovered:0,blocked:0});}}});
  await assert.rejects(publisher.advancePublishingReleaseSchedules(malformedReceipt),/did not acknowledge/);

  const rotation=fixture();
  for(let n=0;n<27;n++)rotation.owned.prepare(
    "INSERT INTO cove_publication_commands(operation_id,product_id,command_sha256,epoch,state,recovery_json) VALUES(?,?,?,1,'pending',?)"
  ).run("recovery-blocked:"+String(n).padStart(2,"0"),"prd_recovery_blocked_"+n,"a".repeat(64),"{}");
  const scan=async id=>(await rotation.post("/publication/recover-recorded",{operationId:id})).json();
  assert.equal((await scan("scan:first")).checked,25,"Recovery batch is bounded");
  assert.equal((await scan("scan:second")).checked,2,"Blocked older commands cannot starve later pages");
  assert.equal((await scan("scan:wrap")).checked,25,"Recovery scan wraps to retry unresolved commands");

  const legacy=fixture();legacy.setFailWrites(true);
  assert.equal((await legacy.activate()).status,503);
  const legacyWrites=legacy.stats().writes;
  legacy.owned.exec("ALTER TABLE cove_publication_commands DROP COLUMN recovery_json");
  legacy.restart();legacy.setFailWrites(false);
  assert.ok(legacy.owned.prepare("PRAGMA table_info(cove_publication_commands)").all().some(x=>x.name==="recovery_json"),
    "Existing owner SQLite journal receives the additive recovery migration");
  assert.equal((await (await legacy.post("/publication/recover-recorded",{operationId:"recovery:legacy"})).json()).checked,0,
    "Legacy holds without an immutable recorded envelope are not reconstructed from caller arguments");
  assert.equal(legacy.stats().writes,legacyWrites);
  assert.equal(legal.readCommercialProofs(legacy.sql,[productId],"US","retail").length,0);

  const unavailable=fixture();unavailable.env.COVE_RIGHTS_OWNER_ENABLED="0";
  assert.equal((await unavailable.post("/publication/recover-recorded",{operationId:"recovery:disabled"})).status,503);
  assert.equal((await unavailable.activate()).status,503);
  assert.equal(unavailable.stats().writes,0,"Owner outage cannot fall back to caller-side activation writes");
  assert.ok(migrations.length>100);assert.ok(publisher.activatePublicationVersionOwned);
  assert.ok(commandCore.beginPublicationCommand);
  console.log("PASS: actual canonical activation runs under durable owner hold; fresh rights/offer publication, replay, restart, primary outage and concurrent withdrawal are fenced");
} finally {for(const db of databases)db.close();rmSync(directory,{recursive:true,force:true});}
