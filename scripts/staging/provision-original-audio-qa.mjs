/* eslint-disable prettier/prettier -- Explicit frozen synthetic audio fixture SQL follows private QA schema. */
/* Synthetic dual-format publisher fixture for deployed ISOLATED paid QA only.
 * Never call on live catalog, real customers or a production D1.
 * The same QA purchased SKU covers the original EPUB + generated audio.
 */
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
export async function provisionPublishedQaAudio(qaSql,{runId,productId,
  buyerId,objectKey,sha,sizeBytes,evidenceSha,evidenceSize}){
  assert.match(runId,/^[0-9]{8,15}-[0-9]{1,5}$/);
  assert.equal(productId,"prd_paid_qa_20261027");
  assert.equal(buyerId,"user_initial_qa_"+runId);
  assert.equal(objectKey,"qa/chapter.wav");
  assert.match(sha,/^[a-f0-9]{64}$/);
  assert.match(evidenceSha,/^[a-f0-9]{64}$/);
  assert.ok(Number.isSafeInteger(evidenceSize)&&evidenceSize>0);
  const digest=value=>createHash("sha256").update(value).digest("hex");
  const time=new Date().toISOString(), id=n=>"qa_"+n+"_"+runId;
  const catalog=(await qaSql(
    "SELECT p.edition_id,e.work_id FROM products p JOIN editions e ON e.id=p.edition_id WHERE p.id=?",
    [productId])).results[0];
  assert.ok(catalog?.edition_id&&catalog?.work_id);
  const account=id("audio_account"),title=id("audio_title"),
    edition=id("audio_draft"),submission=id("audio_submission"),
    publication=id("audio_publication"),lifecycle=id("audio_lifecycle"),
    version=id("audio_version"),narrator=id("audio_narrator"),
    agreement=id("audio_agreement"),chapter=id("audio_chapter");
  await qaSql("INSERT INTO publishing_accounts(id,account_type,legal_name,display_name,country_code,status,created_at,updated_at) VALUES(?,'company','Cove Generated QA','Cove Generated QA','US','active',?,?)",
    [account,time,time]);
  await qaSql("INSERT INTO publishing_titles(id,account_id,title,status,created_at,updated_at) VALUES(?,?,'Generated QA Narration','published',?,?)",
    [title,account,time,time]);
  await qaSql("INSERT INTO publishing_edition_drafts(id,title_id,format,status,catalog_product_id,catalog_edition_id,created_at,updated_at) VALUES(?,?,'audiobook','published',?,?,?,?)",
    [edition,title,productId,catalog.edition_id,time,time]);
  let policy=(await qaSql("SELECT id FROM commercial_audio_policy_versions WHERE status='active' LIMIT 1")).results?.[0];
  if(!policy){
    const policyId=id("audio_policy"),json=JSON.stringify({syntheticQa:true});
    await qaSql("INSERT INTO commercial_audio_policy_versions(id,policy_version,status,policy_json,policy_sha256,created_by_user_id,created_at) VALUES(?,?,'active',?,?,?,?)",
      [policyId,id("audio_policy_version"),json,digest(json),buyerId,time]);
    policy={id:policyId};
  }
  await qaSql("INSERT INTO commercial_audio_profiles(edition_id,publishing_account_id,audio_publisher,copyright_notice,performance_rights_basis,identifier_type,identifier_value,active_policy_id,qc_status,rights_status,agreements_status,created_at,updated_at) VALUES(?,?,'Cove Synthetic QA','Original generated silence','Isolated synthetic QA; no third-party recording','other',?,?,'passed','verified','verified',?,?)",
    [edition,account,edition,policy.id,time,time]);
  // The synthetic audiobook is independently attested in canonical
  // publishing rights records. Its evidence is an original QA text asset
  // uploaded to a private, short-lived R2 bucket by the parent script.
  const declaration=id("rights_declaration"),evidence=id("rights_evidence");
  await qaSql(
    "INSERT INTO publishing_rights_declarations(id,edition_id,account_id,revision,rights_basis,authority_type,rights_owner_name,authority_attestation,no_infringement_attestation,evidence_complete_attestation,signature_name,signed_by_user_id,signed_at,status,created_at) VALUES(?,?,?,1,'owned','copyright_owner','Original QA generated recordings',1,1,1,'QA only',?,?,'verified',?)",
    [declaration,edition,account,buyerId,time,time]
  );
  await qaSql(
    "INSERT INTO publishing_rights_evidence(id,declaration_id,account_id,evidence_type,description,original_filename,mime_type,size_bytes,object_key,sha256,scan_status,verification_status,issued_by,created_by_user_id,created_at) VALUES(?,?,?,'other','Test-generated audio and narration authorization only','qa-rights.txt','text/plain',?,?,?,'clean','verified','QA test fixture',?,?)",
    [evidence,declaration,account,evidenceSize,"qa/rights.txt",evidenceSha,buyerId,time]
  );
  await qaSql(
    "INSERT INTO commercial_audio_narrators(id,edition_id,display_name,narration_type,created_at) VALUES(?,?,'Generated QA Silence','synthetic',?)",
    [narrator,edition,time]
  );
  await qaSql(
    "INSERT INTO narration_agreements(id,edition_id,narrator_id,agreement_type,evidence_id,territories_json,permitted_uses_json,signed_at,status,attested_by_user_id,created_at) VALUES(?,?,?,'synthetic_voice_license',?,'[\"US\"]','[\"retail\",\"preview\",\"offline\"]',?,'active',?,?)",
    [agreement,edition,narrator,evidence,time,buyerId,time]
  );
  // A frozen test publisher's narrator license is input to production's
  // independent rights predicate; it is NOT an actual rights clearance.
  const audio={
    profile:{offlineEligible:true,subscriptionEligible:false,
      territoryScope:{mode:"single",territory:"US"},
      performanceRightsBasis:"Original generated QA WAV",
      audioPublisher:"Cove QA",copyrightNotice:"QA only"},
    narrators:[{id:narrator,display_name:"Generated QA Silence",
      narration_type:"synthetic"}],
    agreements:[{id:agreement,narrator_id:narrator,status:"active",permittedUses:[
      "retail","preview","offline"],territories:["US"]}],
    chapters:[{id:chapter,title:"Generated silence",object_key:objectKey,
      sha256:sha,mime_type:"audio/wav",size_bytes:sizeBytes,duration_ms:1000}]
  };
  const manifest=JSON.stringify({sourceSnapshot:{commercialAudio:audio}});
  const sum=digest(manifest);
  await qaSql("INSERT INTO publishing_submission_snapshots(id,edition_id,account_id,revision,snapshot_json,snapshot_sha256,status,submitted_by_user_id,submitted_at,published_at) VALUES(?,?,?,1,?,?,'published',?,?,?)",
    [submission,edition,account,manifest,sum,buyerId,time,time]);
  await qaSql("INSERT INTO publishing_publications(id,submission_id,publishing_account_id,work_id,edition_id,product_id,materialization_key,published_at) VALUES(?,?,?,?,?,?,?,?)",
    [publication,submission,account,catalog.work_id,catalog.edition_id,
      productId,"qa:audio:"+runId,time]);
  await qaSql("INSERT INTO publishing_release_lifecycles(id,publishing_edition_id,state,created_at,updated_at) VALUES(?,?,'live',?,?)",
    [lifecycle,edition,time,time]);
  await qaSql("INSERT INTO publishing_publication_versions(id,lifecycle_id,publication_id,submission_id,version_number,snapshot_sha256,manifest_json,release_state,created_by_user_id,created_at,activated_at) VALUES(?,?,?,?,?,?,?,'live',?,?,?)",
    [version,lifecycle,publication,submission,(Number(runId.split("-")[0])%1000000000)*1000+Number(runId.split("-")[1]),sum,manifest,buyerId,time,time]);
  await qaSql("UPDATE publishing_release_lifecycles SET current_publication_version_id=? WHERE id=?",
    [version,lifecycle]);
  console.log("QA original dual-format synthetic publisher/narrator/audio manifest provisioned");
}
