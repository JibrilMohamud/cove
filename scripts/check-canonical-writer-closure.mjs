/* eslint-disable prettier/prettier -- Strict, intentionally conservative canonical-writer release inventory. */
/**
 * Scans the actual checked-out source files, not a hand-written "done" list.
 * Run --audit to inventory still-unowned D1 writers (exit 0).
 * Run --release-gate to REFUSE owner-only production storefront mode until
 * there are no direct legal/commerce/publication writes outside a reviewed,
 * fenced writer executor, and all dynamic SQL has been resolved.
 *
 * Static search is a lower bound: JS-generated SQL, external deployments and
 * operator access cannot be certified by scanning alone. Zero findings here
 * is necessary, never sufficient, for production canonical ownership.
 */
import {readdirSync,readFileSync,statSync,writeFileSync,mkdirSync} from "node:fs";
import {join,relative,resolve} from "node:path";
import {fileURLToPath} from "node:url";
import assert from "node:assert/strict";
import {canonicalWriterDrift} from "./canonical-writer-baseline.mjs";
const root=resolve(fileURLToPath(new URL("..",import.meta.url)));
const sources=["src","scripts","worker","workers"];
const protectedTables=[
  "rights_grants","rights_grant_territories","rights_grant_territory_scopes",
  "rights_grant_scope_snapshots","rights_contracts","rights_contract_languages",
  "rights_contract_versions","rights_parties","rights_decisions",
  "rights_configuration_audit","territory_sets","territory_set_rules",
  "territory_set_members","gutenberg_rights_evidence","gutenberg_source_cache",
  "gutenberg_source_states","offers","products","editions",
  "catalog_search_documents","retail_product_availability_rows",
  "storefront_markets","entitlements","delivery_grants","offline_epub_licenses",
  "commerce_orders","commerce_order_items","commerce_refunds",
  "commerce_ledger_entries","commerce_webhook_events","commerce_disputes",
  "commerce_checkout_quotes","commerce_customers","commerce_balance_reservations",
  "commerce_gift_cards","commerce_gift_card_ledger","commerce_store_credit_ledger",
  "commerce_promo_codes","commerce_promo_redemptions","commerce_payment_attempts",
  "commercial_delivery_grants","commercial_entitlement_delivery_usage",
  "commercial_entitlement_devices","commercial_download_audit",
  "entitlement_ownership_records","risk_holds","asset_versions",
  "digital_assets","publication_versions","publication_version_distribution_controls",
  "publication_version_distribution_events","commercial_audio_profiles",
  "commercial_audio_narrators","commercial_audio_chapters",
  "commercial_audio_files","commercial_audio_qc_jobs","commercial_audio_qc_runs",
  "narration_agreements","narration_agreement_terminations",
  "commercial_biosync_links","audio_offline_licenses","audio_offline_license_events",
  "publishing_rights_declarations","publishing_rights_evidence",
  "publishing_publication_versions","publishing_release_lifecycles",
  "publishing_publications","publishing_publication_activations",
  "publishing_submission_snapshots","publishing_edition_drafts",
  "publishing_owner_version_events","publishing_entitlement_version_pins",
  "publishing_outbox","publishing_asset_versions","publishing_assets",
  "publisher_contract_assignments","publisher_catalog_mappings",
  "finance_royalty_contracts","finance_royalty_contract_versions",
  "finance_royalty_contract_splits","finance_royalty_events",
  "subscriptions","subscription_catalog","licenses","devices",
  "finance_parties","publishing_accounts","publishing_titles","publishing_validation_jobs",
  "publishing_lifecycle_events","preorders","commercial_audio_playback",
  // Legal version rules, evidence disputes, trust gates and financial receipts
  // also influence authorization. Never omit their direct writers.
  "rights_contract_version_territories", "rights_contract_version_formats", "rights_contract_version_channels", "rights_contract_audit", "rights_disputes", "rights_dispute_events", "rights_notification_jobs", "copyright_notices", "copyright_counter_notices", "copyright_court_actions", "commercial_delivery_policies", "commercial_audio_policy_versions", "commercial_audio_submission_snapshots", "finance_royalty_allocations", "finance_usage_events", "finance_usage_pools", "royalty_holds", "publishing_validation_results", "publishing_accessibility_declarations", "publishing_rights_evidence_scan_jobs", "publisher_partner_credentials", "publisher_feed_submissions", "publisher_feed_items", "publisher_feed_assets", "publisher_validation_responses", "publishing_identity_verifications", "publishing_content_policy_assessments", "publishing_account_members",
];
const legal=new Set(protectedTables);
assert.equal(legal.size,protectedTables.length,"Duplicate canonical legal table in audit registry");
const mutating=/\b(INSERT\s+(?:OR\s+\w+\s+)?INTO|REPLACE\s+INTO|UPDATE(?:\s+OR\s+\w+)?|DELETE\s+FROM|DROP\s+TABLE|ALTER\s+TABLE)\s+(?:(?:["'\x60\[]?[a-z_][a-z0-9_]*["'\x60\]]?\s*\.\s*))?["'\x60\[]?([a-z_][a-z0-9_]*)/gi;
const ignore=(name,path)=>
  name==="node_modules" || name===".git"||name==="dist"||
  name==="build"||name==="coverage"||name===".wrangler"||
  path.startsWith("scripts/staging/")||path.startsWith("scripts/check-")||
  path.startsWith("scripts/test-")||
  path.includes("__tests__")||path.endsWith(".test.ts")||
  path.endsWith(".spec.ts")||path.endsWith(".d.ts")||
  path.startsWith("src/storefront-strangler/legal-quarantine-qa.writer.ts")||
  path.startsWith("src/storefront-strangler/legal-authority.worker.ts");
const include=(name)=>/\.(?:[cm]?[jt]s|tsx)$/.test(name);
function walk(dir,out=[]){
  let items;
  try{items=readdirSync(join(root,dir),{withFileTypes:true});}catch{return out;}
  for(const item of items){
    const name=dir+"/"+item.name;
    if(ignore(item.name,name))continue;
    if(item.isDirectory())walk(name,out);
    else if(item.isFile()&&include(item.name))out.push(name);
  }
  return out;
}
function classOf(table){
  if(/^commerce_|^finance_|^preorders$/.test(table))return "financial";
  if(/^publishing_|^publication_|^rights_|^territory_|^storefront_markets$|^offers$|^products$|^editions$|^retail_product_/.test(table))return "publication_rights";
  if(/^entitlement|^licenses$|^subscriptions$|^subscription_catalog$|^devices$|^risk_holds$/.test(table))return "customer_permission";
  if(/audio|delivery|assets|offline|download/.test(table))return "protected_media";
  return "source_catalog";
}
function scan(path,text){
  const findings=[];
  for(const match of text.matchAll(mutating)){
    const table=match[2].toLowerCase();
    if(!legal.has(table))continue;
    const line=text.slice(0,match.index).split("\n").length;
    findings.push({file:path,line,table,operation:match[1].toUpperCase().replace(/\s+/g," "),domain:classOf(table)});
  }
  return findings;
}
const sourceFiles=sources.flatMap(dir=>walk(dir)).sort();
const findings=sourceFiles.flatMap(path=>scan(path,readFileSync(join(root,path),"utf8")))
  .sort((a,b)=>a.file.localeCompare(b.file)||a.line-b.line||a.table.localeCompare(b.table));
const summary={schema:"cove.canonical-writer-inventory.v1",
  generatedFrom:"checked-out-source",
  staticScanOnly:true,
  scannedFiles:sourceFiles.length,
  unresolvedDirectWrites:findings.length,
  byDomain:{},byFile:{},
  findings};
for(const row of findings){
  summary.byDomain[row.domain]=(summary.byDomain[row.domain]||0)+1;
  summary.byFile[row.file]=(summary.byFile[row.file]||0)+1;
}
const output=process.env.COVE_WRITER_AUDIT_OUTPUT;
if(output){
  const path=resolve(output);
  mkdirSync(join(path,".."),{recursive:true});
  writeFileSync(path,JSON.stringify(summary,null,2)+"\n",{mode:0o600});
}
console.log("Canonical writer scan: "+sourceFiles.length+" source files, "+
  findings.length+" unverified SQL mutations across "+
  Object.keys(summary.byFile).length+" files.");
console.log("Unverified by domain: "+JSON.stringify(summary.byDomain));
console.log("Top direct writer files: "+JSON.stringify(
  Object.entries(summary.byFile).sort((a,b)=>b[1]-a[1]).slice(0,18)));
if(process.argv.includes("--no-new-writers")) {
  // Keeping the existing 460 known direct writes visible is NOT production
  // owner-first certification. Prevent additional unreviewed sources from
  // silently joining the inventory during the migration.
  const drift=canonicalWriterDrift(findings);
  if(drift.length) {
    console.error("BLOCKED: new unverified canonical SQL writers since reviewed 460-site baseline.");
    console.error("Unreviewed new mutations: "+JSON.stringify(drift));
    process.exitCode=1;
  } else {
    console.log("PASS: no new direct canonical writer candidates since reviewed baseline. "+
      "Existing "+findings.length+" source candidates STILL BLOCK owner-only release.");
  }
}
const release=process.argv.includes("--release-gate");
if(release){
  // No flag, signed string, owner snapshot, branch name, successful staging
  // test or self-asserted certificate can override unresolved direct writes.
  if(findings.length){
    console.error("BLOCKED: production owner-only anonymous read is unsafe. "+
      findings.length+" direct canonical mutations remain unverified; this is a lower-bound inventory.");
    process.exitCode=1;
  }else{
    // Even a zero-match static scan cannot certify external cron/direct DB
    // access, operator mutations, SQL generated at runtime or deployed owner
    // routing. Explicitly require an independent release procedure.
    console.error("BLOCKED: source-only scan cannot certify deployed writer ownership, "+
      "positive proof or provider transport. Production acceptance requires external certification.");
    process.exitCode=1;
  }
}
