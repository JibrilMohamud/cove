/* eslint-disable prettier/prettier -- Security regression matrix: never relax a canonical writer fence. */
import assert from "node:assert/strict";
import {build} from "esbuild";
import {mkdtempSync,rmSync} from "node:fs";
import path from "node:path";
import os from "node:os";
import {pathToFileURL} from "node:url";

const directory=mkdtempSync(path.join(os.tmpdir(),"cove-legal-mutation-fence-"));
try {
  const artifact=path.join(directory,"lock.mjs");
  await build({entryPoints:["src/storefront-strangler/legal-primary-write-lock.ts"],
    outfile:artifact,format:"esm",platform:"node",bundle:true,target:"node22",logLevel:"silent"});
  const {classifyProtectedLegalSql,guardProtectedLegalSql,
    makeStageLegalWriterLock,scopeStageLegalWriterEnv}=await import(pathToFileURL(artifact).href);

  const deny=[
    "UPDATE rights_grants SET status='revoked' WHERE id=?",
    "WITH old AS (SELECT 1) UPDATE rights_grants SET status='active' WHERE id=?",
    "INSERT INTO gutenberg_rights_evidence(id) VALUES(?)",
    "INSERT OR IGNORE INTO offers(id) VALUES(?)",
    "DELETE FROM rights_grant_territories WHERE grant_id=?",
    "REPLACE INTO editions(id) VALUES(?)",
    "CREATE TABLE gutenberg_source_cache(id TEXT)",
    "UPDATE products SET storefront_status='inactive'",
    "UPDATE catalog_search_documents SET suppressed=0 WHERE product_id=?",
    "INSERT INTO retail_product_availability_rows(product_id) VALUES(?)",
    "UPDATE storefront_markets SET market_status='active' WHERE country_code=?",
    "INSERT INTO entitlements(id) VALUES(?)",
    "DELETE FROM offline_epub_licenses WHERE id=?",
    "UPDATE commerce_orders SET status='paid' WHERE id=?",
    "UPDATE commerce_order_items SET entitlement_status='granted' WHERE id=?",
    "UPDATE commerce_refunds SET status='succeeded' WHERE id=?",
    "INSERT INTO commercial_delivery_grants(id) VALUES(?)",
    "UPDATE commercial_entitlement_delivery_usage SET download_count=download_count+1",
    "INSERT INTO entitlement_ownership_records(entitlement_id) VALUES(?)",
    "DELETE FROM risk_holds WHERE subject_id=?",
    "UPDATE publication_versions SET status='active' WHERE id=?",
    "UPDATE digital_assets SET drm_status='none' WHERE id=?",
    "UPDATE asset_versions SET publication_status='live' WHERE id=?",
    "UPDATE commercial_audio_profiles SET rights_status='verified' WHERE edition_id=?",
    "INSERT INTO commercial_audio_chapters(id) VALUES(?)",
    "UPDATE commercial_audio_files SET object_key=? WHERE id=?",
    "DELETE FROM commercial_audio_narrators WHERE id=?",
    "UPDATE commercial_audio_qc_jobs SET status='passed' WHERE id=?",
    "INSERT INTO narration_agreements(id) VALUES(?)",
    "UPDATE narration_agreement_terminations SET status='reinstated' WHERE id=?",
    "UPDATE commercial_biosync_links SET verification_status='verified' WHERE id=?",
    "INSERT INTO audio_offline_licenses(id) VALUES(?)",
    "INSERT INTO subscriptions(id) VALUES(?)",
    "UPDATE subscription_catalog SET product_id=? WHERE id=?",
    "INSERT INTO licenses(id) VALUES(?)",
    "UPDATE devices SET revoked_at=NULL WHERE id=?",
    "INSERT INTO commercial_entitlement_devices(entitlement_id,device_id) VALUES(?,?)",
    "INSERT INTO commerce_webhook_events(provider_event_id) VALUES(?)",
    "UPDATE commerce_disputes SET status='won'",
    "INSERT INTO commerce_checkout_quotes(id) VALUES(?)",
    "UPDATE commerce_customers SET user_id=?",
    "UPDATE commerce_balance_reservations SET status='consumed'",
    "UPDATE commerce_gift_cards SET status='active'",
    "UPDATE commerce_gift_card_ledger SET amount_minor=?",
    "UPDATE commerce_store_credit_ledger SET amount_minor=?",
    "UPDATE commerce_promo_codes SET redemptions=0",
    "UPDATE commerce_promo_redemptions SET status='applied'",
    "INSERT INTO finance_parties(id) VALUES(?)",
    "UPDATE finance_royalty_contract_versions SET status='active'",
    "UPDATE finance_royalty_contract_splits SET share_bps=10000",
    "INSERT INTO finance_royalty_events(id) VALUES(?)",
    "INSERT INTO publishing_outbox(id) VALUES(?)",
    "UPDATE publishing_rights_declarations SET status='approved' WHERE id=?",
    "DELETE FROM publishing_rights_evidence WHERE id=?",
    "UPDATE publishing_publication_versions SET status='active' WHERE id=?",
    "UPDATE publishing_release_lifecycles SET current_publication_version_id=? WHERE id=?",
    "INSERT INTO publishing_publication_activations(id) VALUES(?)",
    "UPDATE publishing_publications SET status='live' WHERE id=?",
    "UPDATE publisher_contract_assignments SET status='active' WHERE id=?",
    "INSERT INTO publishing_submission_snapshots(id) VALUES(?)",
    "UPDATE publishing_edition_drafts SET status='approved' WHERE id=?",
    "UPDATE finance_royalty_contracts SET status='active' WHERE id=?",
    "-- legal review\n UPDATE rights_contracts SET status='active'",
    "SELECT 1; UPDATE offers SET active=1",
    "UPDATE main.\"rights_grants\" SET status='active' WHERE id=?",
    "INSERT INTO \"main\".\"offers\"(id) VALUES(?)",
    "DELETE FROM [main].[entitlements] WHERE id=?",
    "CREATE TRIGGER regrant AFTER INSERT ON cove_arch_load BEGIN UPDATE rights_grants SET status='active'; END",
    "PRAGMA writable_schema=ON",
    "UPDATE/* owner audit */entitlements SET status='active'",
    "INSERT/* forensic note */INTO rights_grants(id) VALUES(?)",
    "WITH v AS(SELECT 1) UPDATE/* grant */rights_contracts SET status='active'",
    "SELECT '--not a comment' AS comment_text; UPDATE/*hidden*/offers SET active=1",
    "SELECT 1; -- ordinary note\nUPDATE entitlements SET status='active'",
    "CREATE/*audit*/TRIGGER regrant AFTER INSERT ON x BEGIN INSERT INTO entitlements(id) VALUES(?); END",
    "PRAGMA/*audit*/writable_schema=ON",
  ];
  for(const sql of deny){
    assert.ok(classifyProtectedLegalSql(sql).length>0,"Fails to recognize: "+sql);
    assert.throws(()=>guardProtectedLegalSql(sql),
      /canonical_legal_write_requires_owner_fence/);
  }
  const allow=[
    "SELECT * FROM rights_grants WHERE edition_id=?",
    "SELECT product_id FROM offers WHERE active=1",
    "UPDATE cove_arch_load SET payload=? WHERE run_id=?",
    "INSERT INTO recommendation_events(id) VALUES(?)"
  ];
  for(const sql of allow)assert.deepEqual(classifyProtectedLegalSql(sql),[],
    "Non-legal statement must not be classified as authoritatively mutating");
  const reviewedAudioProgress=[
    "DELETE FROM commercial_audio_playback WHERE user_id=? AND product_id=? AND version=?",
    "UPDATE commercial_audio_playback SET chapter_id=?,seconds=?,speed=?,version=?,updated_at=? WHERE user_id=? AND product_id=? AND version=?",
    "INSERT INTO commercial_audio_playback(user_id,product_id,chapter_id,seconds,speed,version,updated_at) VALUES(?,?,?,?,?,?,?)"
  ];
  for(const sql of reviewedAudioProgress){
    assert.deepEqual(classifyProtectedLegalSql(sql),[],
      "Exactly scoped audiobook position updates are not authorization");
    assert.doesNotThrow(()=>guardProtectedLegalSql(sql));
  }
  for(const sql of [
    "DELETE FROM commercial_audio_playback WHERE product_id=? AND version=?",
    "UPDATE commercial_audio_playback SET version=?,updated_at=? WHERE product_id=?",
    "INSERT INTO commercial_audio_playback(user_id,product_id) VALUES(?,?)",
    reviewedAudioProgress[1]+"; UPDATE entitlements SET status='active'",
    "/* authorized progress */ "+reviewedAudioProgress[1],
    reviewedAudioProgress[2]+" -- user approved",
    reviewedAudioProgress[0].replace("user_id=?","user_id='other_buyer'")
  ]){
    assert.ok(classifyProtectedLegalSql(sql).length>0,
      "Any alteration to a reviewed playback SQL statement must require an owner: "+sql);
    assert.throws(()=>guardProtectedLegalSql(sql),
      /canonical_legal_write_requires_owner_fence/);
  }
  assert.throws(()=>classifyProtectedLegalSql(
    "SELECT 1; /* unclosed owner audit"),/invalid_legal_sql/,
    "Malformed block comments must not be allowed to suppress protected writes");
  assert.throws(()=>classifyProtectedLegalSql(
    "SELECT 'unfinished quoted audit"),/invalid_legal_sql/,
    "Malformed SQL literals must fail closed");
  assert.deepEqual(classifyProtectedLegalSql(
    "SELECT '--' AS harmless_literal; -- legal comment\nUPDATE cove_arch_load SET revision=1"),[],
    "Quoted comment delimiters and real line comments must preserve safe SQL");
  let nativeBatches=0, nativePrepareCalls=0;
  const native={
    prepare(sql){
      nativePrepareCalls++;
      return {sql,bind(...args){return {...this,args}},async all(){return {results:[]}},
        async first(){return null},async run(){return {success:true}}};
    },
    async batch(stmts){nativeBatches++;return stmts.map(s=>({sql:s.sql}))},
    exec(sql){throw Error("Raw SQL exec must be blocked in the audit: "+sql)},
    withSession(){return this;}
  };
  const scoped=scopeStageLegalWriterEnv({
    COVE_SSR_STAGING:"1",COVE_CANONICAL_LEGAL_WRITE_LOCK:"1",DB:native
  });
  assert.notEqual(scoped.DB,native,"Staging closure must wrap the raw binding");
  assert.equal(nativePrepareCalls,0);
  for(const sql of reviewedAudioProgress)
    assert.doesNotThrow(()=>scoped.DB.prepare(sql),
      "Stage may persist safe progress without owner approval");
  const select=scoped.DB.prepare("SELECT * FROM rights_grants WHERE id=?").bind("r1");
  const synthetic=scoped.DB.prepare("UPDATE cove_arch_load SET sequence=? WHERE id=?").bind(1,"run");
  const batched=await scoped.DB.batch([select,synthetic]);
  assert.equal(nativeBatches,1);
  assert.equal(batched.length,2);
  for(const sql of deny) assert.throws(()=>scoped.DB.prepare(sql),
    /canonical_legal_write_requires_owner_fence/);
  assert.throws(()=>scoped.DB.batch([native.prepare("SELECT 1")]),
    /unfenced_legal_batch_statement/);
  assert.throws(()=>scoped.DB.exec("UPDATE offers SET active=1"),
    /unfenced_legal_sql_exec/);
  assert.throws(()=>scoped.DB.withSession("first-unconstrained")
    .prepare("DELETE FROM rights_grants"),/canonical_legal_write_requires_owner_fence/);
  assert.throws(()=>scopeStageLegalWriterEnv({
    COVE_SSR_STAGING:"0",COVE_CANONICAL_LEGAL_WRITE_LOCK:"1",DB:native
  }),/production_legal_writer_cutover_not_certified/);
  assert.equal(scopeStageLegalWriterEnv({
    COVE_SSR_STAGING:"0",DB:native
  }).DB,native,"Production release flag off must preserve existing primary DB");
  console.log("PASS: legacy API/cron legal write barrier blocks D1 upserts, SQL injection via batches, and unverified production cutover");
}finally{rmSync(directory,{force:true,recursive:true});}
