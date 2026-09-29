import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

const root=process.cwd(), db=new DatabaseSync(':memory:');
const migrations=fs.readdirSync(path.join(root,'drizzle')).filter(x=>/^\d{4}_.+\.sql$/.test(x)).sort();
for(const name of migrations) db.exec(fs.readFileSync(path.join(root,'drizzle',name),'utf8').replaceAll('--> statement-breakpoint',';'));
db.exec('PRAGMA foreign_keys=ON');
assert.ok(migrations.includes('0037_catalog_identity_discovery_seo.sql'),'catalog identity migration missing');
assert.ok(migrations.length>=38,'publishing build should include the catalog identity migration chain');

const tables=new Set(db.prepare("select name from sqlite_master where type='table'").all().map(x=>x.name));
for(const name of [
  'publishing_accounts','publishing_account_members','publishing_addresses','publishing_pen_names',
  'publishing_identity_verifications','publishing_tax_profiles','publishing_payout_accounts',
  'publishing_titles','publishing_edition_drafts','publishing_edition_contributors','publishing_assets',
  'publishing_asset_versions','publishing_validation_jobs','publishing_validation_results',
  'publishing_duplicate_matches','publishing_submission_snapshots','publishing_submission_reviews',
  'publishing_publications','publishing_audit_events','publishing_outbox',
  'publishing_release_lifecycles','publishing_publication_versions','publishing_lifecycle_events','publishing_automated_reviews',
  'publishing_entitlement_version_pins','publishing_owner_version_events','publishing_publication_activations','staff_principals','staff_roles','staff_role_permissions','staff_principal_roles',
  'staff_audit_events','moderation_cases','moderation_case_reports','moderation_notes','moderation_signals','moderation_actions','moderation_appeals','moderation_sanctions','copyright_complaints',
  'publishing_rights_declarations','publishing_rights_evidence','publishing_rights_evidence_scan_jobs','publishing_ai_disclosures','publishing_content_policy_assessments','publishing_asset_fingerprints','publishing_similarity_matches','publishing_account_risk_links','publishing_risk_clusters','publishing_risk_cluster_members','publishing_identity_similarity_matches','rights_disputes','copyright_notices','copyright_counter_notices','rights_dispute_events','royalty_holds','publisher_infringement_incidents','repeat_infringer_policy_state','rights_notification_jobs','publishing_policy_versions','copyright_court_actions','publishing_publication_disclosures'
]) assert(tables.has(name),`missing ${name}`);

const columns=(table)=>new Set(db.prepare(`pragma table_info(${table})`).all().map(x=>String(x.name)));
const identityCols=columns('publishing_identity_verifications');
const taxCols=columns('publishing_tax_profiles');
const payoutCols=columns('publishing_payout_accounts');
for(const forbidden of ['document_bytes','document_image','ssn','passport_number','drivers_license_number']) assert(!identityCols.has(forbidden),`raw identity secret ${forbidden} must not be stored`);
for(const forbidden of ['tin','ssn','tax_id','form_bytes','w9','w8ben']) assert(!taxCols.has(forbidden),`raw tax secret ${forbidden} must not be stored`);
for(const forbidden of ['account_number','routing_number','iban','swift','bank_token_secret']) assert(!payoutCols.has(forbidden),`raw bank secret ${forbidden} must not be stored`);
for(const required of ['provider','provider_account_id','account_last4','payout_currency','payout_threshold_minor','status']) assert(payoutCols.has(required),`payout metadata missing ${required}`);

const at='2026-09-24T15:00:00.000Z';
db.prepare(`insert into publishing_accounts(id,account_type,legal_name,display_name,country_code,contact_email,status,identity_status,tax_status,payout_status,terms_version,terms_accepted_at,created_at,updated_at)
 values('acct','person','Legal Author','Public House','US','a@example.com','active','verified','verified','verified','v1',?,?,?)`).run(at,at,at);
db.prepare("insert into publishing_account_members(account_id,user_id,role,status,accepted_at,created_at,updated_at) values('acct','user','owner','active',?,?,?)").run(at,at,at);
db.prepare("insert into publishing_pen_names(id,account_id,display_name,sort_name,status,created_at,updated_at) values('pen','acct','A. Writer','Writer, A.','active',?,?)").run(at,at);
db.prepare(`insert into publishing_titles(id,account_id,title,description,language,audience,status,created_at,updated_at) values('title','acct','Foundation Book','A complete description','en','general','draft',?,?)`).run(at,at);
db.prepare(`insert into publishing_edition_drafts(id,title_id,format,language,rights_basis,territory_scope_json,list_currency,list_price_minor,drm_requirement,sales_channels_json,status,revision,created_at,updated_at)
 values('ped','title','ebook','en','owned','{"mode":"worldwide","exclude":[]}','USD',999,'none','["retail"]','submitted',1,?,?)`).run(at,at);
db.prepare("insert into publishing_edition_contributors(edition_id,pen_name_id,display_name,role,position) values('ped','pen','A. Writer','author',0)").run();
db.prepare(`insert into publishing_submission_snapshots(id,edition_id,account_id,revision,snapshot_json,snapshot_sha256,status,submitted_by_user_id,submitted_at)
 values('sub','ped','acct',1,'{"frozen":true}','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','submitted','user',?)`).run(at);
assert.throws(()=>db.prepare("update publishing_submission_snapshots set snapshot_json='{}' where id='sub'").run(),/immutable/i,'submission snapshot must be immutable');
assert.throws(()=>db.prepare("delete from publishing_submission_snapshots where id='sub'").run(),/cannot be deleted/i,'submission evidence must not be deletable');
assert.throws(()=>db.prepare("insert into publishing_account_members(account_id,user_id,role,status,created_at,updated_at) values('acct','bad','superuser','active',?,?)").run(at,at),/CHECK constraint failed/i,'organization roles must be constrained');

// Staff RBAC and moderation evidence must be structurally enforced by the database too.
const seededRoles=db.prepare("select count(*) count from staff_roles").get();
assert(Number(seededRoles.count)>=7,'commercial moderation roles were not seeded');
const adminPerms=db.prepare("select count(*) count from staff_role_permissions where role_id='role_moderation_admin'").get();
assert(Number(adminPerms.count)>=15,'moderation admin granular permissions were not seeded');
db.prepare("insert into publishing_release_lifecycles(id,publishing_edition_id,state,owner_update_policy,created_at,updated_at) values('life','ped','human_review','auto_update',?,?)").run(at,at);
db.prepare("insert into publishing_lifecycle_events(id,lifecycle_id,from_state,to_state,trigger_type,actor_user_id,reason_code,metadata_json,created_at) values('evt','life','submitted','human_review','automation','user','','{}',?)").run(at);
assert.throws(()=>db.prepare("update publishing_lifecycle_events set reason_code='rewrite' where id='evt'").run(),/append-only/i,'lifecycle audit events must be append-only');
db.prepare("insert into moderation_cases(id,subject_type,subject_id,publishing_account_id,category,queue,priority,status,source_type,source_ref,risk_score,report_count,summary,opened_at,updated_at) values('case','edition','ped','acct','publishing_risk','publishing','high','actioned','staff','',70,1,'case',?,?)").run(at,at);
db.prepare("insert into moderation_appeals(id,case_id,appellant_user_id,publishing_account_id,statement,evidence_json,status,submitted_at) values('appeal1','case','user','acct','A sufficiently detailed appeal statement.','[]','submitted',?)").run(at);
assert.throws(()=>db.prepare("insert into moderation_appeals(id,case_id,appellant_user_id,publishing_account_id,statement,evidence_json,status,submitted_at) values('appeal2','case','user','acct','Another sufficiently detailed appeal.','[]','in_review',?)").run(at),/UNIQUE constraint failed/i,'a case must not have two open appeals');
// Signed rights/AI declarations and dispute evidence are immutable legal/audit records.
db.prepare(`insert into publishing_rights_declarations(id,edition_id,account_id,revision,rights_basis,authority_type,rights_owner_name,territory_scope_json,authority_attestation,no_infringement_attestation,evidence_complete_attestation,signature_name,signed_by_user_id,signed_at,status,created_at) values('rd','ped','acct',1,'owned','copyright_owner','Legal Author','{"mode":"worldwide"}',1,1,1,'Legal Author','user',?,'signed',?)`).run(at,at);
assert.throws(()=>db.prepare("update publishing_rights_declarations set rights_owner_name='rewrite' where id='rd'").run(),/immutable/i,'signed rights declarations must be immutable');
db.prepare(`insert into publishing_ai_disclosures(id,edition_id,account_id,revision,text_origin,cover_origin,narration_origin,translation_origin,human_editorial_review_attestation,rights_responsibility_attestation,non_spam_attestation,signature_name,signed_by_user_id,signed_at,created_at) values('ai','ped','acct',1,'human','human','not_applicable','not_applicable',1,1,1,'Legal Author','user',?,?)`).run(at,at);
assert.throws(()=>db.prepare("update publishing_ai_disclosures set text_origin='ai_generated' where id='ai'").run(),/immutable/i,'signed AI disclosures must be immutable');
db.prepare("insert into rights_disputes(id,case_id,publishing_account_id,subject_type,subject_id,legal_regime,status,created_at,updated_at) values('dispute','case','acct','edition','ped','us_dmca','notice_received',?,?)").run(at,at);
db.prepare("insert into rights_dispute_events(id,dispute_id,event_type,actor_type,event_json,created_at) values('devent','dispute','notice_received','claimant','{}',?)").run(at);
assert.throws(()=>db.prepare("delete from rights_dispute_events where id='devent'").run(),/append-only/i,'rights dispute events must be append-only');

assert.throws(()=>db.prepare("update publishing_policy_versions set summary='rewritten' where policy_key='ai_content' and version='fore-ai-content-v1'").run(),/immutable/i,'published policy rules/text must be immutable');
db.prepare("update publishing_policy_versions set status='retired' where policy_key='ai_content' and version='fore-ai-content-v1'").run();
assert.equal(db.prepare("select status from publishing_policy_versions where policy_key='ai_content' and version='fore-ai-content-v1'").get().status,'retired','policy version lifecycle status must be retireable without rewriting its text');
db.prepare("update publishing_policy_versions set status='active' where policy_key='ai_content' and version='fore-ai-content-v1'").run();
const fingerprintIndexes=new Set(db.prepare("pragma index_list(publishing_asset_fingerprints)").all().map(x=>x.name));
for(const index of ['idx_asset_fingerprint_band0','idx_asset_fingerprint_band1','idx_asset_fingerprint_band2','idx_asset_fingerprint_band3']) assert(fingerprintIndexes.has(index),`missing indexed SimHash candidate band ${index}`);

// Queue semantics need to support horizontal workers and idempotent jobs.
const jobCols=columns('publishing_validation_jobs');
for(const name of ['execution_class','status','attempts','max_attempts','available_at','lease_owner','lease_expires_at','idempotency_key']) assert(jobCols.has(name),`validation queue missing ${name}`);
const jobIndexes=db.prepare("pragma index_list(publishing_validation_jobs)").all().map(x=>x.name);
assert(jobIndexes.includes('idx_publishing_validation_lease'),'validation queue lease index missing');

const server=fs.readFileSync('src/features/fore/publishing.server.ts','utf8');
const api=fs.readFileSync('src/features/fore/api.server.ts','utf8');
const ui=fs.readFileSync('src/features/fore/Publishing.tsx','utf8');
const routes=fs.readFileSync('src/routeTree.gen.ts','utf8');
const foundationMigration=fs.readFileSync('drizzle/0019_fore_publishing_foundation.sql','utf8');
const lifecycleMigration=fs.readFileSync('drizzle/0020_publishing_lifecycle_and_moderation.sql','utf8');
const activationMigration=fs.readFileSync('drizzle/0021_publishing_activation_and_staff_audit.sql','utf8');
const trustMigration=fs.readFileSync('drizzle/0022_rightsholder_disputes_and_ai_policy.sql','utf8');
const policyMigration=fs.readFileSync('drizzle/0023_rightsholder_operations_and_public_policy.sql','utf8');
const catalogModel=fs.readFileSync('src/features/fore/catalog-model.server.ts','utf8');
const trust=fs.readFileSync('src/features/fore/publishing-trust.server.ts','utf8');
const finance=fs.readFileSync('src/features/fore/finance.server.ts','utf8');
const royaltyEngine=fs.readFileSync('src/features/fore/royalty-engine.server.ts','utf8');
const stageSites=fs.readFileSync('scripts/stage-sites.mjs','utf8');
const moderation=fs.readFileSync('src/features/fore/moderation.server.ts','utf8');
const retail=fs.readFileSync('src/features/fore/retail.server.ts','utf8');
const bookUi=fs.readFileSync('src/features/fore/Book.tsx','utf8');
const policyUi=fs.readFileSync('src/features/fore/RightsholderPolicy.tsx','utf8');

for(const check of ['malware','archive_safety','epubcheck','metadata','cover','images','navigation','links','fonts','fixed_layout','accessibility','render','device_compatibility','duplicate']) assert(server.includes(`"${check}"`)||server.includes(`'${check}'`),`validator ${check} missing from publishing pipeline`);
assert.match(server,/publishing\/quarantine\//,'uploads must land in quarantine storage');
assert.match(server,/expanded \/ bytes\.byteLength > 120/,'archive-bomb ratio protection is missing');
assert.match(server,/expanded > 500 \* 1024 \* 1024/,'archive expanded-size protection is missing');
assert.match(server,/execution:\s*"external"|"external"/,'external fail-closed production validators must be represented');
assert.match(server,/j\.required=1 AND j\.status<>'passed'/,'submission readiness must fail closed on required validators');
assert.match(server,/publishing_submission_snapshots/,'immutable submission snapshot path missing');
assert.match(server,/Only an approved immutable submission can be materialized/,'publication must consume an approved snapshot only');
assert.match(server,/frozenContributors=snapshot\.contributors, frozenAssets=snapshot\.assets/,'publication must use frozen contributors/assets');
assert.match(server,/submitted asset no longer matches its immutable snapshot/i,'materialization must verify submitted asset identity');
assert.match(server,/existing\?\.status === "changes_requested".*revision/s,'changes requested must create a new draft revision');
assert.match(server,/Previous worker lease expired; retrying/,'expired worker leases must be recoverable');
assert.match(server,/attempts<max_attempts/,'validation workers must enforce retry budgets');
assert.match(server,/materializePublishingSubmission/,'catalog materialization missing');
assert.match(server,/publishing_publication_versions/,'immutable publication-version materialization missing');
assert.match(server,/pending_publication_version_id/,'scheduled update staging pointer missing');
assert.match(server,/rollbackPublishingVersion/,'publication rollback operation missing');
assert.match(server,/Rollback is blocked while the release is suppressed, taken down, or retired/,'rollback must not bypass enforcement state');
assert.match(server,/activatePublicationCommercialTerms/,'commercial terms must switch with publication-version activation');
assert.match(server,/Rights conflict at activation/,'publication activation must revalidate blocking rights conflicts');
assert.match(server,/status:"draft".*source:"fore-publishing"/s,'new publication rights must stage as draft before activation');
assert.match(server,/offers\(id,product_id,offer_type,currency,amount_minor,active.*VALUES\(\?,\?,'purchase',\?,\?,0/s,'future pricing offers must stage inactive');
assert.match(server,/finance_royalty_contracts.*'draft'/s,'royalty contracts must stage as draft');
assert.match(server,/publishing_publication_activations/,'append-only publication activation ledger missing');

assert.match(server,/owner_update_policy/,'owner update policy missing');
assert.match(server,/optInOwnedPublicationUpdate/,'manual owner update opt-in missing');
assert.match(server,/FORE_PUBLISHING_AUTO_APPROVE_LOW_RISK/,'automated low-risk approval gate missing');
assert.match(moderation,/identity\.aal !== "aal2"/,'staff MFA assurance enforcement missing');
assert.match(moderation,/sso_provider/,'staff SSO binding enforcement missing');
assert.match(moderation,/repeat_offender_pattern/,'repeat-offender detection missing');
assert.match(moderation,/copyright_takedown/,'copyright takedown workflow missing');
assert.match(moderation,/impersonation_remove/,'impersonation enforcement missing');
assert.match(moderation,/report_count=report_count\+1/,'repeat reports must aggregate into an existing active case');
assert.match(moderation,/selected moderation action is not appealable/i,'appeals must require a reversible moderation action');
assert.match(moderation,/action has already been appealed/i,'the same moderation action must not be appealed repeatedly');
assert.match(moderation,/staff_audit_events/,'staff provisioning and deprovisioning must be audited');
assert.match(api,/\/admin\/moderation\/action[\s\S]{0,220}moderation\.case\.read/,'moderation action routing must defer to granular action permissions instead of requiring generic case management');
assert.match(moderation,/verifiedSubjectPublishingAccount/,'user reports must resolve publisher ownership server-side');
assert.match(lifecycleMigration,/idx_moderation_appeals_one_open_per_case/,'duplicate open appeals must be prevented at the database layer');
assert.match(server,/upsertRightsGrant/,'publication must materialize territorial rights');
assert.match(server,/finance_royalty_contracts/,'publication must materialize a royalty contract');
assert.match(server,/publishing_outbox/,'publication/submission must emit durable asynchronous events');
assert.match(server,/rawBankCredentialsStoredByCove:\s*false/,'payout API must declare that Cove does not retain bank credentials');
assert.match(foundationMigration,/raw identity documents/i); assert.match(foundationMigration,/raw TINs\/forms/i); assert.match(foundationMigration,/Bank credentials are tokenized/i);
assert.match(lifecycleMigration,/publishing_release_lifecycles/); assert.match(lifecycleMigration,/publishing_publication_versions/); assert.match(lifecycleMigration,/publication versions are immutable/);
assert.match(lifecycleMigration,/staff_principals/); assert.match(lifecycleMigration,/staff_role_permissions/); assert.match(lifecycleMigration,/moderation_cases/); assert.match(lifecycleMigration,/moderation_appeals/); assert.match(lifecycleMigration,/copyright_complaints/);
assert.match(lifecycleMigration,/publishing_entitlement_version_pins/); assert.match(lifecycleMigration,/publishing_owner_version_events/);
assert.match(activationMigration,/publishing_publication_activations/); assert.match(activationMigration,/publication activation history is append-only/); assert.match(activationMigration,/staff_audit_events/);
assert.match(api,/FORE_STAFF_BOOTSTRAP_TOKEN/); assert.match(api,/requireStaffPermission/); assert.match(api,/requireServiceScope/); assert.match(api,/publishing\.worker/); assert.match(api,/\/admin\/staff\/principal/);
assert.doesNotMatch(api,/FORE_PUBLISHING_WORKER_TOKEN|FORE_PIPELINE_TOKEN|FORE_INGEST_TOKEN/,'publishing worker must use a scoped service principal, not shared operator secrets');
assert.doesNotMatch(ui,/FORE_PUBLISHING_ADMIN_TOKEN/,'staff console must not request a shared publishing bearer token');
assert.match(ui,/Moderation & appeals/,'publisher-facing moderation and appeal UI missing');
assert.match(ui,/Staff identities & access/,'staff identity administration UI missing');
assert.match(api,/\/publishing-worker\/jobs\/lease/); assert.match(api,/\/publishing-worker\/jobs\/complete/); assert.match(api,/\/publishing-worker\/releases\/tick/);
assert.match(api,/\/admin\/rights\/notice-validation/); assert.match(api,/\/admin\/rights\/counter-validation/); assert.match(api,/\/admin\/rights\/repeat-infringer/); assert.match(api,/rights\.repeat_infringer\.manage/); assert.match(api,/\/publishing-worker\/rights\/deadlines/); assert.match(api,/\/publishing\/rights-declaration/); assert.match(api,/\/publishing\/ai-disclosure/); assert.match(api,/\/publishing\/policies/); assert.match(api,/\/rights\/contact/,'public designated-agent contact endpoint missing');
assert.match(trust,/submitCopyrightNotice/); assert.match(trust,/submitCopyrightCounterNotice/); assert.match(trust,/counter_notice_resubmitted/); assert.match(trust,/restore_not_before_at/); assert.match(trust,/addBusinessDays\(base,10\)/); assert.match(trust,/addBusinessDays\(base,14\)/); assert.match(trust,/copyright_court_actions/); assert.match(trust,/litigation_hold/); assert.match(trust,/royalty_holds/); assert.match(trust,/forfeitRoyalties===true/,'copyright resolution must reject silent royalty forfeiture'); assert.match(trust,/royaltyDisposition/); assert.match(trust,/manageRepeatInfringerPolicy/); assert.match(trust,/repeat_infringer_policy_state/); assert.match(trust,/publishing_asset_fingerprints/); assert.match(trust,/simhash_band0/); assert.match(trust,/publishing_account_risk_links/); assert.match(trust,/shared_account_controller/); assert.match(trust,/publishing_identity_similarity_matches/); assert.match(trust,/fore-ai-content-v1/); assert.match(trust,/publicPublishingPolicies/); assert.match(trust,/requireActivePolicy/);
assert.match(royaltyEngine,/activeDisputeHold/); assert.match(royaltyEngine,/status = split.party_status === "hold" \|\| held \|\| !tax\.verified \? "held" : "accrued"/); assert.match(finance,/frozen by an active rights dispute/);
assert.match(server,/Sign the Cove publisher rights declaration/); assert.match(server,/staff-verified rights evidence record/,'licensed/public-domain submissions must require verified rights evidence'); assert.match(server,/FORE_RIGHTS_POLICY_VERSION/,'submission readiness must bind to the active rights policy'); assert.match(server,/FORE_AI_POLICY_VERSION/,'submission readiness must bind to the active AI policy'); assert.match(server,/Sign the Cove AI-content disclosure/); assert.match(server,/recordAssetFingerprint/); assert.match(server,/publishing_publication_disclosures/,'published versions must freeze customer-facing AI disclosures'); assert.match(server,/ai_generated_text/); assert.match(server,/ai_generated_translation/); assert.match(server,/synthetic_narration/); assert.match(catalogModel,/ai_disclosure_json/,'catalog reads must expose current publication disclosure'); assert.match(catalogModel,/aiDisclosure/); assert.match(moderation,/fore-trust-v2/);
assert.match(trustMigration,/copyright_counter_notices/); assert.match(trustMigration,/rights_notification_jobs/); assert.match(trustMigration,/notice_noncompliant/); assert.match(trustMigration,/court_action_recorded/); assert.match(trustMigration,/idx_asset_fingerprint_band0/); assert.match(trustMigration,/idx_asset_fingerprint_band3/); assert.match(trustMigration,/publishing_content_policy_assessments/); assert.match(trustMigration,/rights dispute events are append-only/); assert.match(policyMigration,/publishing_policy_versions/); assert.match(policyMigration,/publishing_publication_disclosures/); assert.match(policyMigration,/copyright_court_actions/); assert.match(policyMigration,/UPDATE OF policy_key,version,title,summary,rules_json/,'policy text must be immutable while status remains lifecycle-managed');
assert.match(api,/\/admin\/moderation\/status/); assert.match(api,/\/admin\/moderation\/appeal-decision/); assert.match(api,/\/moderation\/copyright-complaint/);
assert.match(api,/publishingUploadLimit/,'uploads must use bounded body limits');
assert.match(ui,/Repeat-infringer controls/); assert.match(ui,/royaltyDisposition:"continue_hold"/); assert.doesNotMatch(ui,/forfeitRoyalties:true/); assert.match(ui,/Pen names are public catalog identities/); assert.match(ui,/Legal address/); assert.match(ui,/ROYALTIES & PAYOUTS/); assert.match(server,/finance_statements WHERE party_id=\?/,'publisher dashboard must scope statements to its own finance party'); assert.match(ui,/Team access/); assert.match(ui,/Territory scope/); assert.match(ui,/Preorder opens/); assert.match(ui,/Cove subscription/); assert.match(ui,/Library distribution/);
assert.match(retail,/publishing_publication_disclosures/,'product detail must resolve disclosure from the active publication version'); assert.match(bookUi,/Content transparency/,'book detail must surface customer-facing generated-content labels'); assert.match(policyUi,/Copyright \/ DMCA notice/,'public rightsholder notice UI missing'); assert.match(policyUi,/AI, automated content & publishing integrity/,'public AI policy UI missing'); assert.match(policyUi,/10–14 business-day/,'public notice UI must explain the counter-notice restoration window');
assert.match(trust,/otherHold/,'restoration must respect overlapping active rights holds'); assert.match(trust,/publishing_edition_contributors/,'author-scoped copyright disputes must resolve affected publications');
for(const route of ['/publishing','/staff/publishing','/copyright','/publishing-policy']) assert(routes.includes(`'${route}'`),`missing ${route} route`);

assert.match(stageSites,/runPublishingReleaseMaintenance/,'scheduled deployment worker must advance publishing release schedules');
console.log(`Cove Publishing commercial trust regression: ${migrations.length} migrations; immutable submissions/publication versions, rights declarations/evidence, AI disclosures, fingerprint/similarity risk graph, DMCA notice/counter-notice restoration windows, scoped royalty holds, repeat-infringer controls, staff RBAC/audit, and enforcement-safe release operations verified.`);
