/* eslint-disable prettier/prettier -- Full migrated primary, actual owner handler and injected workflow crash windows. */
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {DatabaseSync} from "node:sqlite";
import {build} from "esbuild";
import {mkdtempSync,readdirSync,readFileSync,rmSync,copyFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {pathToFileURL} from "node:url";
const dir=mkdtempSync(join(tmpdir(),"cove-materialization-owner-")),databases=[];
const sha=bytes=>createHash("sha256").update(bytes).digest("hex");
const secret="a".repeat(64),at="2026-01-01T00:00:00.000Z";
let serial=0;
try {
  const outfile=join(dir,"real-owner.mjs");
  await build({stdin:{contents:
    'export {CoveLegalAuthority} from "./src/storefront-strangler/legal-authority.worker.ts"; export * from "./src/features/fore/publishing.server.ts"; export * from "./src/storefront-strangler/publication-owner-routing.server.ts"; export * from "./src/storefront-strangler/legal-primary-write-lock.ts";',
    resolveDir:process.cwd()},outfile,bundle:true,format:"esm",platform:"node",target:"node22",
    alias:{jszip:"jszip/dist/jszip.min.js"},logLevel:"silent",plugins:[{name:"host",setup(b){
      b.onLoad({filter:/legal-authority\.worker\.ts$/},args=>({contents:readFileSync(args.path,"utf8")
        .replace('error instanceof Error?error.name:"unknown"','error instanceof Error?error.message:"unknown"'),loader:"ts"}));
      b.onResolve({filter:/^cloudflare:workers$/},()=>({path:"host",namespace:"test-host"}));
      b.onLoad({filter:/.*/,namespace:"test-host"},()=>({contents:
        "export class DurableObject {constructor(ctx,env){this.ctx=ctx;this.env=env;}}"}));
    }}]});
  const api=await import(pathToFileURL(outfile).href);
  const template=join(dir,"schema.sqlite"),schema=new DatabaseSync(template);
  for(const file of readdirSync("drizzle").filter(f=>f.endsWith(".sql")).sort())schema.exec(readFileSync(join("drizzle",file),"utf8"));
  schema.close();
  function fixture({future=false}={}) {
    const path=join(dir,"primary-"+(++serial)+".sqlite");copyFileSync(template,path);
    const primary=new DatabaseSync(path),owned=new DatabaseSync(":memory:");databases.push(primary,owned);
    primary.exec("PRAGMA foreign_keys=ON");
    const insert=(table,row)=>{const keys=Object.keys(row);primary.prepare(`INSERT INTO ${table}(${keys.join(',')}) VALUES(${keys.map(()=>'?').join(',')})`).run(...Object.values(row));};
    const account={id:"puba_materialize",account_type:"person",legal_name:"Owner Publisher",display_name:"Owner Publisher",country_code:"US",contact_email:"qa@example.invalid",status:"active",identity_status:"verified",tax_status:"verified",payout_status:"verified",created_at:at,updated_at:at};
    insert("publishing_accounts",account);
    const tax={id:"pubtax_materialize",account_id:account.id,country_code:"US",provider:"manual",status:"verified",created_at:at,updated_at:at};
    const payout={id:"pubpay_materialize",account_id:account.id,provider:"manual",provider_account_id:"qa_materialize",bank_country_code:"US",payout_currency:"USD",status:"verified",created_at:at,updated_at:at};
    insert("publishing_tax_profiles",tax);insert("publishing_payout_accounts",payout);
    insert("rights_parties",{id:"rparty_materialize",display_name:"Owner Publisher",status:"active",created_at:at,updated_at:at});
    primary.prepare("UPDATE publishing_accounts SET rights_party_id='rparty_materialize'").run();
    insert("rights_contracts",{id:"rcontract_materialize",reference_code:"QA-MATERIALIZE",name:"Approved distribution",rightsholder_party_id:"rparty_materialize",status:"active",effective_from:at,created_at:at,updated_at:at});
    insert("rights_contract_versions",{id:"rcversion_materialize",contract_id:"rcontract_materialize",version_number:1,status:"draft",effective_from:at,retailer_commission_bps:3000,created_at:at});
    insert("rights_contract_version_formats",{contract_version_id:"rcversion_materialize",format:"ebook",decision:"allow"});
    insert("rights_contract_version_channels",{contract_version_id:"rcversion_materialize",sales_channel:"retail",permitted:1});
    insert("rights_contract_version_territories",{contract_version_id:"rcversion_materialize",territory_code:"US",decision:"allow"});
    primary.prepare("UPDATE rights_contract_versions SET status='active' WHERE id='rcversion_materialize'").run();
    insert("publisher_contract_assignments",{account_id:account.id,contract_id:"rcontract_materialize",status:"active",created_at:at});
    const title={id:"pubtitle_materialize",account_id:account.id,title:"Owner Published Book",language:"en",created_at:at,updated_at:at};
    insert("publishing_titles",title);
    const edition={id:"pubedition_materialize",title_id:title.id,revision:1,status:"approved",format:"ebook",language:"en",rights_basis:"owned",contract_id:"rcontract_materialize",contract_version_id:"rcversion_materialize",territory_scope_json:JSON.stringify({mode:"single",territory:"US"}),sales_channels_json:'["retail"]',list_currency:"USD",list_price_minor:499,downloadable:1,subscription_permitted:0,library_permitted:0,release_date:future?new Date(Date.now()+7*86400_000).toISOString():at,created_at:at,updated_at:at};
    insert("publishing_edition_drafts",edition);
    insert("publishing_release_lifecycles",{id:"publife_materialize",publishing_edition_id:edition.id,state:"approved",created_at:at,updated_at:at});
    insert("staff_principals",{user_id:"staff_materialize",status:"active",created_at:at,updated_at:at});
    insert("staff_principal_roles",{user_id:"staff_materialize",role_id:"role_publishing_reviewer",granted_at:at});
    const ai={id:"pubai_materialize",edition_id:edition.id,account_id:account.id,revision:1,policy_version:"fore-ai-content-v1",text_origin:"human",cover_origin:"human",narration_origin:"not_applicable",translation_origin:"not_applicable",human_editorial_review_attestation:1,rights_responsibility_attestation:1,non_spam_attestation:1,signature_name:"Owner Publisher",signed_by_user_id:"publisher_materialize",signed_at:at,created_at:at};
    insert("publishing_ai_disclosures",ai);
    const objects=new Map(),assets=[];
    for(const kind of ["manuscript","cover"]) {
      const assetId="pubasset_"+kind,versionId="pubassetver_"+kind,bytes=new TextEncoder().encode("Isolated verified QA "+kind),objectKey="qa/"+kind;
      const mime=kind==="cover"?"image/png":"application/epub+zip";
      insert("publishing_assets",{id:assetId,edition_id:edition.id,kind,created_at:at,updated_at:at});
      insert("publishing_asset_versions",{id:versionId,asset_id:assetId,version_number:1,object_key:objectKey,original_filename:kind,mime_type:mime,size_bytes:bytes.length,sha256:sha(bytes),quarantine_status:"clean",validation_summary:"passed",created_by_user_id:"publisher_materialize",created_at:at});
      primary.prepare("UPDATE publishing_assets SET current_version_id=? WHERE id=?").run(versionId,assetId);
      assets.push({id:assetId,kind,current_version_id:versionId,object_key:objectKey,mime_type:mime,size_bytes:bytes.length,sha256:sha(bytes)});objects.set(objectKey,bytes);
    }
    const snapshot={schemaVersion:5,
      account:primary.prepare("SELECT * FROM publishing_accounts WHERE id=?").get(account.id),
      tax:primary.prepare("SELECT * FROM publishing_tax_profiles WHERE id=?").get(tax.id),
      payout:primary.prepare("SELECT * FROM publishing_payout_accounts WHERE id=?").get(payout.id),
      title:primary.prepare("SELECT * FROM publishing_titles WHERE id=?").get(title.id),
      edition:primary.prepare("SELECT * FROM publishing_edition_drafts WHERE id=?").get(edition.id),assets,contributors:[{display_name:"Author Owner",role:"author",position:0}],aiDisclosure:ai};
    const snapshotJson=JSON.stringify(snapshot);
    insert("publishing_submission_snapshots",{id:"pubsub_materialize",edition_id:edition.id,account_id:account.id,revision:1,snapshot_json:snapshotJson,snapshot_sha256:sha(snapshotJson),status:"approved",submitted_by_user_id:"publisher_materialize",submitted_at:at});
    insert("publishing_submission_reviews",{id:"pubreview_materialize",submission_id:"pubsub_materialize",reviewer_user_id:"staff_materialize",decision:"approve",created_at:at});
    let writes=0,failAt=0,ownerCommitFailure=false,finalEpochFailure=false,beforeWrite=null,afterWrite=null;
    let lastError=null;
    const DB={prepare(query){
      const bound=(args=[])=>({bind:(...a)=>bound(a),async first(){return primary.prepare(query).get(...args)||null;},async all(){return {results:primary.prepare(query).all(...args)};},async run(){
        writes++;if(beforeWrite)await beforeWrite(query,writes);
        if(failAt===writes)throw Error("injected_primary_write_failure");
        try {
          const stmt=primary.prepare(query),result=stmt.columns().length?{results:stmt.all(...args),success:true,meta:{changes:0}}:{success:true,meta:{changes:Number(stmt.run(...args).changes)}};
          if(afterWrite)await afterWrite(query,writes);
          return result;
        }catch(e){lastError=e;throw e;}
      }});return bound();
    },async batch(statements){primary.exec("BEGIN");try{const result=[];for(const stmt of statements)result.push(await stmt.run());primary.exec("COMMIT");return result;}catch(e){primary.exec("ROLLBACK");throw e;}}};
    const sql={exec(query,...args){if(finalEpochFailure&&/UPDATE cove_publication_commands SET published_epoch/.test(query))throw Error("injected_final_owner_marker");const stmt=owned.prepare(query);const rows=stmt.columns().length?stmt.all(...args):(stmt.run(...args),[]);return {toArray:()=>rows};}};
    const BUCKET={async get(key){const bytes=objects.get(key);return bytes?{arrayBuffer:async()=>bytes.slice().buffer}:null;},async put(key,bytes){objects.set(key,new Uint8Array(bytes));},async delete(key){objects.delete(key);}};
    const env={PRIMARY_DB:DB,BUCKET,COVE_RIGHTS_OWNER_ENABLED:"1",COVE_RIGHTS_OWNER_PRIMARY_ID:"7c7ab994-f6b3-419d-a72d-71eb9ea22e7e",COVE_RIGHTS_OWNER_SECRET:secret,COVE_RIGHTS_OWNER_TEST_EXPIRES_AT:String(Date.now()+14*60_000)};
    const ctx={storage:{sql,transactionSync(fn){owned.exec("BEGIN");try{const result=fn();if(ownerCommitFailure&&owned.prepare("SELECT 1 ok FROM cove_publication_commands WHERE state='committed'").get())throw Error("injected_owner_commit");owned.exec("COMMIT");return result;}catch(e){owned.exec("ROLLBACK");throw e;}}}};
    let owner=new api.CoveLegalAuthority(ctx,env);
    const post=(path,body)=>owner.fetch(new Request("https://owner.internal"+path,{method:"POST",headers:{authorization:"Bearer "+secret,"content-type":"application/json"},body:JSON.stringify(body)}));
    const command={submissionId:"pubsub_materialize",reviewerUserId:"staff_materialize",operationId:"materialize:test",territory:"US",currency:"USD"};
    const port={fetch:request=>owner.fetch(request)};
    return {primary,owned,DB,env,objects,snapshot,post,port,
      materialize:(overrides={})=>post("/publication/materialize-submission",{...command,...overrides}),
      writes:()=>writes,lastError:()=>lastError,
      failAt(n){failAt=n;},before(fn){beforeWrite=fn;},after(fn){afterWrite=fn;},
      failCommit(value){ownerCommitFailure=value;},failEpoch(value){finalEpochFailure=value;},
      restart(){owner=new api.CoveLegalAuthority(ctx,env);}};
  }
  const good=fixture();
  good.before(async(query,n)=>{
    const pending=good.owned.prepare("SELECT product_id,state FROM cove_publication_commands").get();
    assert.equal(pending?.state,"pending","Owner must hold the product before EVERY primary write");
    assert.equal(good.owned.prepare("SELECT verdict FROM cove_commercial_authority WHERE product_id=?").get(pending.product_id)?.verdict,"deny");
    if(n===1)assert.equal((await good.materialize()).status,409,"Duplicate concurrent command cannot enter the executor");
    assert.notEqual((await good.post("/commercial/publish-verified",{productId:pending.product_id,territory:"US",channel:"retail"})).status,200,"A concurrent writer cannot expose partial materialization");
  });
  const result=await good.materialize();
  assert.equal(result.status,200,"Actual full materialization failed: "+good.lastError());
  const receipt=await result.json(),writeCount=good.writes();
  assert.equal(receipt.accessPublished,true);assert.ok(writeCount>30);
  assert.equal(good.owned.prepare("SELECT state FROM cove_publication_commands").get().state,"committed");
  assert.equal(good.primary.prepare("SELECT status FROM finance_royalty_contracts").get().status,"active");
  assert.equal(good.primary.prepare("SELECT active FROM offers").get().active,1);
  assert.equal(good.primary.prepare("SELECT state FROM publishing_release_lifecycles").get().state,"live");
  good.before(null);
  assert.equal((await good.materialize({operationId:"materialize:lost-ack:new-id"})).status,200);
  assert.equal(good.writes(),writeCount,"Completed replay cannot repeat rights/royalty/catalog writes");
  assert.throws(()=>good.primary.prepare("DELETE FROM publishing_audit_events WHERE action='published'").run(),/immutable/);
  assert.throws(()=>good.primary.prepare("UPDATE publishing_audit_events SET metadata_json='{}' WHERE action='published'").run(),/immutable/);
  console.log("PASS: full materialization writes="+writeCount+"; positive proof, royalty terms, strict immutable completion and replay");

  // Every write boundary leaves a durable denial and cannot be blindly
  // rerun after restart, even when publishing_publications already exists.
  for(let point=1;point<=writeCount;point++) {
    const f=fixture();f.failAt(point);
    assert.equal((await f.materialize()).status,503,"failure point "+point);
    const pending=f.owned.prepare("SELECT product_id,state FROM cove_publication_commands").get();
    assert.equal(pending?.state,"pending","Failure must retain the edit hold at "+point);
    assert.equal(f.owned.prepare("SELECT verdict FROM cove_commercial_authority WHERE product_id=?").get(pending.product_id).verdict,"deny");
    const prior=f.writes();f.restart();f.failAt(0);
    assert.equal((await f.materialize({operationId:"materialize:retry"})).status,503);
    assert.equal(f.writes(),prior,"Partial primary materialization must not replay at "+point);
  }
  for(const mode of ["commit","epoch","lost-marker-ack"]) {
    const f=fixture();if(mode==="commit")f.failCommit(true);else if(mode==="epoch")f.failEpoch(true);
    else f.after(query=>{if(query.startsWith("INSERT INTO publishing_audit_events"))throw Error("lost_primary_marker_ack");});
    assert.equal((await f.materialize()).status,503);
    f.restart();f.failCommit(false);f.failEpoch(false);f.after(null);const prior=f.writes();
    const recovered=await f.post("/publication/recover-recorded",{operationId:"recovery:materialize"});
    assert.equal(recovered.status,200);const ack=await recovered.json();
    assert.equal(ack.recovered,1,mode+" actual scheduler recovery");assert.equal(f.writes(),prior);
  }
  const future=fixture({future:true});const scheduled=await future.materialize();
  assert.equal(scheduled.status,200,"Scheduled materialization failed: "+future.lastError());
  assert.equal((await scheduled.json()).accessPublished,false);
  assert.equal(future.primary.prepare("SELECT active FROM offers").get().active,0);
  assert.equal(future.owned.prepare("SELECT verdict FROM cove_commercial_authority").get().verdict,"deny");
  assert.equal(future.owned.prepare("SELECT published_epoch FROM cove_publication_commands").get().published_epoch,0);
  const futureWrites=future.writes();assert.equal((await future.materialize()).status,200);assert.equal(future.writes(),futureWrites);
  assert.equal((await (await future.post("/publication/recover-recorded",{operationId:"recover:prepared"})).json()).checked,0);

  for(const mutate of [
    f=>f.primary.prepare("UPDATE staff_principals SET status='suspended'").run(),
    f=>f.primary.prepare("UPDATE publishing_payout_accounts SET status='restricted'").run(),
    f=>f.primary.prepare("UPDATE publishing_tax_profiles SET expires_at='2025-01-01T00:00:00.000Z'").run(),
    f=>f.primary.prepare("UPDATE publishing_accounts SET identity_status='failed'").run(),
    f=>f.primary.prepare("UPDATE publishing_release_lifecycles SET state='takedown'").run(),
    f=>f.objects.set("qa/manuscript",new TextEncoder().encode("corrupted")),
    f=>f.primary.prepare("UPDATE publishing_asset_versions SET quarantine_status='rejected' WHERE id='pubassetver_manuscript'").run(),
  ]) {
    const f=fixture();mutate(f);assert.equal((await f.materialize()).status,503);assert.equal(f.writes(),0,"Independent preflight must reject before any canonical write");
  }
  const extra=fixture();assert.equal((await extra.materialize({sql:"SELECT 1"})).status,400);assert.equal(extra.writes(),0);
  assert.equal((await extra.materialize({reviewerUserId:"system:automated-review"})).status,503);
  assert.equal((await extra.materialize({reviewerUserId:"staff_someone_else"})).status,503);
  extra.env.COVE_RIGHTS_OWNER_PRIMARY_ID="4bd657ac-8789-403e-a28c-93aba8d0a989";
  assert.equal((await extra.materialize()).status,503,"Production cannot enroll via this QA route");

  for(const type of ["withdrawal","compliance","copy-race"]) {
    const f=fixture();let changed=false;
    f.before(async(query)=>{if(changed)return;changed=true;
      const productId=f.owned.prepare("SELECT product_id FROM cove_publication_commands").get().product_id;
      if(type==="withdrawal")assert.equal((await f.post("/commercial/deny-next",{productId,operationId:"withdraw:during-materialization"})).status,200);
      else if(type==="compliance")f.primary.prepare("UPDATE publishing_accounts SET payout_status='restricted'").run();
      else f.objects.set("qa/manuscript",new TextEncoder().encode("changed after source preflight"));
    });
    assert.equal((await f.materialize()).status,503,type+" must prevent positive acknowledgement");
    assert.equal(f.owned.prepare("SELECT verdict FROM cove_commercial_authority").get().verdict,"deny");
  }
  // A real second immutable submission must replace grants while retaining
  // its still-assigned contract, and cannot leave proofs on another product
  // that depended on the retired grant.
  async function secondRevision(f,{future=false}={}) {
    const previous=await (await f.materialize()).json();
    const insert=(table,row)=>{const keys=Object.keys(row);f.primary.prepare(`INSERT INTO ${table}(${keys.join(',')}) VALUES(${keys.map(()=>'?').join(',')})`).run(...Object.values(row));};
    f.primary.prepare("UPDATE publishing_edition_drafts SET revision=2,status='approved',release_date=? WHERE id='pubedition_materialize'")
      .run(future?new Date(Date.now()+7*86400_000).toISOString():at);
    f.primary.prepare("UPDATE publishing_release_lifecycles SET state='approved'").run();
    const snapshot={...f.snapshot,title:f.primary.prepare("SELECT * FROM publishing_titles WHERE id='pubtitle_materialize'").get(),
      edition:f.primary.prepare("SELECT * FROM publishing_edition_drafts WHERE id='pubedition_materialize'").get()};
    snapshot.aiDisclosure={...snapshot.aiDisclosure,id:'pubai_revision',revision:2};insert('publishing_ai_disclosures',snapshot.aiDisclosure);
    const json=JSON.stringify(snapshot);
    insert('publishing_submission_snapshots',{id:'pubsub_revision',edition_id:'pubedition_materialize',account_id:'puba_materialize',revision:2,
      snapshot_json:json,snapshot_sha256:sha(json),status:'approved',submitted_by_user_id:'publisher_materialize',submitted_at:at});
    insert('publishing_submission_reviews',{id:'pubreview_revision',submission_id:'pubsub_revision',reviewer_user_id:'staff_materialize',decision:'approve',created_at:at});
    return previous;
  }
  const updated=fixture();const old=await secondRevision(updated);
  const oldGrant=updated.primary.prepare("SELECT id FROM rights_grants").get().id;
  updated.primary.prepare("INSERT INTO products(id,edition_id,sku,format,storefront_status,source_name,source_external_id,created_at,updated_at) VALUES('prd_other_shared_grant',?,'shared-grant','ebook','active','publisher','shared-grant',?,?)").run(old.editionId,at,at);
  assert.equal((await updated.post('/commercial/publish-verified',{productId:'prd_other_shared_grant',territory:'US',channel:'retail'})).status,200);
  const updateReceipt=await updated.materialize({submissionId:'pubsub_revision',operationId:'materialize:revision'});
  assert.equal(updateReceipt.status,200);assert.equal((await updateReceipt.json()).releaseState,'updated');
  assert.equal(updated.primary.prepare('SELECT status FROM rights_grants WHERE id=?').get(oldGrant).status,'revoked');
  const shared=await (await updated.post('/commercial/authorize-batch',{ids:['prd_other_shared_grant'],territory:'US',channel:'retail'})).json();
  assert.deepEqual(shared.rows,[],"Retired rights must deny every product sharing them");
  assert.equal(updated.owned.prepare("SELECT COUNT(*) n FROM cove_commercial_subject_denials WHERE subject_kind='contract'").get().n,0,
    "A retained assigned contract must not be terminally withdrawn");
  const stagedUpdate=fixture();await secondRevision(stagedUpdate,{future:true});
  const staged=await stagedUpdate.materialize({submissionId:'pubsub_revision',operationId:'materialize:scheduled-revision'});
  assert.equal(staged.status,200);assert.equal((await staged.json()).releaseState,'scheduled');
  assert.equal(stagedUpdate.owned.prepare('SELECT COUNT(*) n FROM cove_commercial_subject_denials').get().n,0,
    "Preparing a future revision must preserve current rights");
  const automated=fixture();automated.env.FORE_PUBLISHING_AUTO_APPROVE_LOW_RISK='true';
  automated.primary.prepare("INSERT INTO publishing_automated_reviews(id,submission_id,policy_version,outcome,risk_score,created_at) VALUES('autoreview_materialize','pubsub_materialize','fore-trust-v2','pass',0,?)").run(at);
  const policy=automated.primary.prepare("SELECT id FROM risk_policy_versions WHERE domain='publisher' LIMIT 1").get().id;
  automated.primary.prepare("INSERT INTO risk_assessments(id,domain,subject_type,subject_id,policy_version_id,score,level,action,created_at) VALUES('risk_materialize','publisher','publishing_account','puba_materialize',?,0,'low','allow',?)").run(policy,at);
  automated.primary.prepare("INSERT INTO publishing_lifecycle_events(id,lifecycle_id,to_state,trigger_type,reason_code,metadata_json,created_at) VALUES('autoapproval_materialize','publife_materialize','approved','automation','automated_low_risk_approval','{\"submissionId\":\"pubsub_materialize\"}',?)").run(at);
  assert.equal((await automated.materialize({reviewerUserId:'system:automated-review'})).status,200,
    "Automated approval requires independent owner policy, review, risk and exact lifecycle evidence");
  const locked=fixture();
  const enrolled=api.bindPublicationOwner(api.makeStageLegalWriterLock(locked.DB),{owner:locked.port,secret,territory:"US",currency:"USD"});
  const published=await api.materializePublishingSubmission({DB:enrolled},"pubsub_materialize","staff_materialize");
  assert.ok(published.publicationVersionId);assert.ok(published.product_id.startsWith("prd_"));
  await assert.rejects(()=>api.materializePublishingSubmissionOwned({DB:enrolled},"pubsub_materialize","staff_materialize"));
  assert.equal((await locked.post("/commercial/deny-next",{productId:published.product_id,operationId:"withdraw:after-materialization"})).status,200);
  assert.equal((await locked.materialize({operationId:"materialize:after-withdrawal"})).status,503,"Old published evidence cannot erase a withdrawal");
  console.log("PASS: "+writeCount+" injected primary failures; owner/marker lost acknowledgements; scheduler recovery; scheduled preparation; byte corruption/races; reviewer/compliance/withdrawal denials; original caller with legal SQL locked");
} finally {
  for(const db of databases)db.close();rmSync(dir,{recursive:true,force:true});
}
