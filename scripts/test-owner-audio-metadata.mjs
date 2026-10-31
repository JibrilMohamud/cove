/* eslint-disable prettier/prettier -- Isolated actual SQLite lease and authorizing audio metadata owner. */
import assert from "node:assert/strict";
import {DatabaseSync} from "node:sqlite";
import {build} from "esbuild";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {pathToFileURL} from "node:url";
const folder=mkdtempSync(join(tmpdir(),"cove-audio-private-"));
const primary=new DatabaseSync(":memory:"),durable=new DatabaseSync(":memory:");
try {
  const output=join(folder,"owner.mjs");
  await build({entryPoints:["src/storefront-strangler/legal-authority.worker.ts"],
    bundle:true,platform:"node",format:"esm",target:"node22",outfile:output,
    logLevel:"silent",plugins:[{name:"fake-cloudflare-host",setup(b){
      b.onResolve({filter:/^cloudflare:workers$/},()=>({path:"fake",namespace:"owner-host"}));
      b.onLoad({filter:/.*/,namespace:"owner-host"},()=>({contents:
        "export class DurableObject { constructor(ctx,env){this.ctx=ctx;this.env=env;} }"}));
    }}]});
  const {CoveLegalAuthority}=await import(pathToFileURL(output).href);
  primary.exec("PRAGMA foreign_keys=ON");
  for(const sql of [
    "CREATE TABLE publishing_titles(id TEXT PRIMARY KEY,account_id TEXT,title TEXT,subtitle TEXT,description TEXT)",
    "CREATE TABLE publishing_edition_drafts(id TEXT PRIMARY KEY,title_id TEXT,format TEXT,status TEXT,subscription_permitted INTEGER,territory_scope_json TEXT)",
    "CREATE TABLE publishing_account_members(account_id TEXT,user_id TEXT,status TEXT,role TEXT)",
    "CREATE TABLE commercial_audio_policy_versions(id TEXT PRIMARY KEY,status TEXT)",
    "CREATE TABLE publishing_rights_declarations(id TEXT PRIMARY KEY,edition_id TEXT)",
    "CREATE TABLE publishing_rights_evidence(id TEXT PRIMARY KEY,declaration_id TEXT,verification_status TEXT)",
    "CREATE TABLE commercial_audio_profiles(edition_id TEXT PRIMARY KEY,publishing_account_id TEXT,audio_publisher TEXT,copyright_notice TEXT,performance_rights_basis TEXT,performance_rights_evidence_id TEXT,identifier_type TEXT,identifier_value TEXT,credits_json TEXT,territory_scope_json TEXT,subscription_eligible INTEGER,offline_eligible INTEGER,cover_asset_version_id TEXT,active_policy_id TEXT,qc_status TEXT,rights_status TEXT,agreements_status TEXT,updated_at TEXT,created_at TEXT)",
    "CREATE TABLE commercial_audio_narrators(id TEXT PRIMARY KEY,edition_id TEXT,display_name TEXT,narration_type TEXT,synthetic_voice_label TEXT,billing_order INTEGER,created_at TEXT)",
    "CREATE TABLE narration_agreements(id TEXT PRIMARY KEY,edition_id TEXT,narrator_id TEXT,agreement_type TEXT,evidence_id TEXT,territories_json TEXT,permitted_uses_json TEXT,signed_at TEXT,expires_at TEXT,status TEXT,attested_by_user_id TEXT,created_at TEXT)",
    "CREATE TABLE narration_agreement_terminations(id TEXT PRIMARY KEY,agreement_id TEXT,disposition TEXT,effective_at TEXT,replacement_agreement_id TEXT,reason TEXT,actor_user_id TEXT,created_at TEXT)"
  ])primary.exec(sql);
  const ownerId="publisher_owner_qa",intruder="publisher_other_qa",editionId="pubed_qa123",
    accountId="pubacct_qa123";
  primary.prepare("INSERT INTO publishing_titles VALUES('pubtitle_qa123',?,'QA','', '')").run(accountId);
  primary.prepare("INSERT INTO publishing_edition_drafts VALUES(?,'pubtitle_qa123','audiobook','draft',0,?)").run(editionId,'{"mode":"worldwide"}');
  primary.prepare("INSERT INTO publishing_account_members VALUES(?,?, 'active','owner')").run(accountId,ownerId);
  primary.prepare("INSERT INTO commercial_audio_policy_versions VALUES('capol_qa','active')").run();
  primary.prepare("INSERT INTO publishing_rights_declarations VALUES('rightsdecl_qa',?)").run(editionId);
  primary.prepare("INSERT INTO publishing_rights_evidence VALUES('rightsev_qa','rightsdecl_qa','verified')").run();
  const db={prepare(sql){return {bind(...args){return {
    async first(){return primary.prepare(sql).get(...args)||null;},
    async all(){return {results:primary.prepare(sql).all(...args)};},
    async run(){return {meta:{changes:primary.prepare(sql).run(...args).changes}};}
  };}};},async batch(statements){
    primary.exec("BEGIN");try {for(const s of statements)await s.run();primary.exec("COMMIT");}
    catch(e){primary.exec("ROLLBACK");throw e;}
  }};
  const storageSql={exec(sql,...args){const q=durable.prepare(sql);
    const rows=q.columns().length?q.all(...args):(q.run(...args),[]);
    return {toArray:()=>rows};
  }};
  const secret="a".repeat(64),env={PRIMARY_DB:db,COVE_RIGHTS_OWNER_ENABLED:"1",
    COVE_RIGHTS_OWNER_PRIMARY_ID:"7c7ab994-f6b3-419d-a72d-71eb9ea22e7e",
    COVE_RIGHTS_OWNER_TEST_EXPIRES_AT:String(Date.now()+600000),
    COVE_RIGHTS_OWNER_SECRET:secret};
  const owner=new CoveLegalAuthority({storage:{sql:storageSql,transactionSync(fn){return fn();}}},env);
  const request=(action,userId,payload,operationId,token=secret)=>owner.fetch(new Request(
    "https://legal-authority.internal/publishing/audio/metadata",{
      method:"POST",headers:{"content-type":"application/json","authorization":"Bearer "+token},
      body:JSON.stringify({action,userId,payload,operationId})
    }));
  const profile={
    editionId,audioPublisher:"QA Publishing",copyrightNotice:"(c) 2026 QA",
    performanceRightsBasis:"Verified independent signed audio permission",
    performanceRightsEvidenceId:"rightsev_qa",
    identifierType:"isbn13",identifierValue:"9780306406157",
    territoryScope:{mode:"worldwide"},subscriptionEligible:false,offlineEligible:false
  };
  assert.equal((await request("profile",intruder,profile,"audio:forged")).status,403);
  assert.equal(primary.prepare("SELECT COUNT(*) n FROM commercial_audio_profiles").get().n,0);
  assert.equal((await request("profile",ownerId,{...profile,performanceRightsEvidenceId:"nonexistent"},"audio:bad-evidence")).status,409);
  assert.equal((await request("profile",ownerId,profile,"audio:wrong-secret","b".repeat(64))).status,401);
  let response=await request("profile",ownerId,profile,"audio:profile");
  assert.equal(response.status,200);assert.equal((await response.json()).result.saved,true);
  assert.equal(primary.prepare("SELECT rights_status FROM commercial_audio_profiles WHERE edition_id=?").get(editionId).rights_status,"verified");
  response=await request("profile",ownerId,profile,"audio:profile");
  assert.equal(response.status,200);
  assert.equal((await response.json()).result.saved,true,"exact owner replay preserves receipt");
  assert.equal((await request("profile",ownerId,{...profile,audioPublisher:"collision"},"audio:profile")).status,409,
    "reusing an operationId with a different payload must deny");
  const narrators={editionId,narrators:[{displayName:"QA Narrator",narrationType:"human",syntheticVoiceLabel:""}]};
  response=await request("narrators",ownerId,narrators,"audio:narrators");
  assert.equal(response.status,200);
  assert.equal(primary.prepare("SELECT COUNT(*) n FROM commercial_audio_narrators").get().n,1);
  assert.equal((await request("narrators",ownerId,{editionId,narrators:[
    {displayName:"Unlabeled",narrationType:"synthetic",syntheticVoiceLabel:""}
  ]},"audio:invalid-voice")).status,400);
  assert.equal(primary.prepare("SELECT COUNT(*) n FROM commercial_audio_narrators").get().n,1,
    "Invalid replacement cannot delete validated narrators");
  const narratorId=primary.prepare("SELECT id FROM commercial_audio_narrators").get().id;
  const agreement={editionId,narratorId,agreementType:"license",evidenceId:"rightsev_qa",
    territories:["US"],permittedUses:["retail"],signedAt:new Date().toISOString()};
  assert.equal((await request("agreement-add",intruder,agreement,"audio:fake-agreement")).status,403);
  response=await request("agreement-add",ownerId,agreement,"audio:agreement");
  assert.equal(response.status,200);
  const agreementId=(await response.json()).result.id;
  response=await request("agreement-add",ownerId,agreement,"audio:agreement");
  assert.equal(response.status,200);
  assert.equal((await response.json()).result.id,agreementId);
  assert.equal(primary.prepare("SELECT COUNT(*) n FROM narration_agreements").get().n,1,
    "exact signed owner replay must not duplicate narrator agreements");
  assert.equal(primary.prepare("SELECT agreements_status FROM commercial_audio_profiles WHERE edition_id=?").get(editionId).agreements_status,"verified");
  const termination={agreementId,disposition:"terminated",reason:"QA owner independently revoked this contract",
    effectiveAt:new Date(Date.now()-1000).toISOString()};
  response=await request("agreement-end",ownerId,termination,"audio:termination");
  assert.equal(response.status,200);
  assert.equal(primary.prepare("SELECT agreements_status FROM commercial_audio_profiles WHERE edition_id=?").get(editionId).agreements_status,"pending");
  env.COVE_RIGHTS_OWNER_ENABLED="0";
  assert.equal((await request("profile",ownerId,profile,"audio:disabled")).status,503);
  assert.equal(primary.prepare("SELECT COUNT(*) n FROM narration_agreement_terminations").get().n,1);
  console.log("PASS: QA commercial audio owner verifies publisher role, evidence, draft, synthetic voice validation, agreement termination and owner disable");
}finally{primary.close();durable.close();rmSync(folder,{recursive:true,force:true});}
