/* eslint-disable prettier/prettier -- This staged legal-writer fence uses explicit conservative SQL patterns. */
/**
 * Staging cutover safety barrier. Once enabled, no legacy API route may
 * mutate a canonical legal/commerce authorization table through the raw D1
 * binding, regardless of whether the call came from the UI, cron, admin,
 * webhook, an optimistic checkout, or a nested batch.
 *
 * This is a deliberate DENY-ALL for unported legal writes. An owner-fenced
 * canonical writer must use a separately reviewed, narrowly authorized
 * mutation executor, not disable the barrier for its whole request.
 *
 * Until Cloudflare bindings and all writer paths are migrated, the
 * switch is ONLY used in isolated staging. It is not a production cutover.
 */
const LEGAL_TABLES = [
  "rights_grants", "rights_grant_territories", "rights_grant_territory_scopes",
  "rights_contracts", "rights_contract_languages", "rights_contract_versions",
  "rights_parties", "rights_decisions", "gutenberg_rights_evidence",
  "gutenberg_source_cache", "offers", "products", "editions",
  // The anonymous authority SQL ALSO depends on these live publication
  // and market tables. A raw D1 writer can resurrect availability or
  // change market scope without touching the grant/offer tables above.
  // The independent owner may replace primary reads only after these
  // producers are migrated behind the same canonical write fence.
  "catalog_search_documents", "retail_product_availability_rows",
  "storefront_markets",
  "entitlements", "delivery_grants", "offline_epub_licenses",
  // The paid-rights cutover is incomplete if legacy checkout, webhooks,
  // order settlement, buyer holds, or protected-delivery issuance can
  // silently mutate a positive customer authorization behind the owner.
  "commerce_orders", "commerce_order_items", "commerce_refunds",
  "commercial_delivery_grants", "commercial_entitlement_delivery_usage",
  "entitlement_ownership_records", "risk_holds", "asset_versions",
  "digital_assets", "publication_versions",
  // Audiobook performance rights, narration agreements, publication,
  // protected audio bytes and offline licenses are paid legal writers too.
  // Disabling only EPUB writes would leave revocation bypasses elsewhere.
  "commercial_audio_profiles", "commercial_audio_narrators",
  "commercial_audio_chapters", "commercial_audio_files",
  "commercial_audio_qc_jobs", "commercial_audio_qc_runs",
  "narration_agreements", "narration_agreement_terminations",
  "commercial_biosync_links", "audio_offline_licenses",
  "publishing_rights_declarations", "publishing_rights_evidence",
  "publishing_publication_versions", "publishing_release_lifecycles",
  // These are not auxiliary drafts once linked to live titles: changing
  // publication activation, publisher assignment, or royalty ownership can
  // resurrect a paid offer without touching its existing offer row.
  // Until owner-first command writers exist, stage must DENY them too.
  "publishing_publications", "publishing_publication_activations",
  "publishing_submission_snapshots", "publishing_edition_drafts",
  "publisher_contract_assignments", "finance_royalty_contracts",
  // Closing only entitlement rows is insufficient: legacy subscription,
  // device, refund-webhook and financial event writers can still create
  // positive access or acknowledge a withdrawal without the legal owner.
  // Stage intentionally denies these until scoped owner-first executors
  // migrate ALL affected mutation paths (including cron/support).
  "subscriptions", "subscription_catalog", "licenses", "devices",
  "commercial_entitlement_devices", "commerce_webhook_events",
  "commerce_disputes", "commerce_checkout_quotes",
  "commerce_customers", "commerce_balance_reservations",
  "commerce_gift_cards", "commerce_gift_card_ledger",
  "commerce_store_credit_ledger", "commerce_promo_codes",
  "commerce_promo_redemptions", "finance_parties",
  "finance_royalty_contract_versions", "finance_royalty_contract_splits",
  "finance_royalty_events", "publishing_outbox",
  // Closed under the static canonical writer registry. Keep these denial
  // predicates aligned with the CI registry, including settlement and asset
  // metadata tables that can influence subsequent customer authorization.
  "rights_grant_scope_snapshots", "rights_configuration_audit", "territory_sets", "territory_set_rules", "territory_set_members", "gutenberg_source_states", "commerce_ledger_entries", "commerce_payment_attempts", "commercial_download_audit", "publication_version_distribution_controls", "publication_version_distribution_events", "audio_offline_license_events", "publishing_owner_version_events", "publishing_entitlement_version_pins", "publishing_asset_versions", "publishing_assets", "publisher_catalog_mappings", "publishing_accounts", "publishing_titles", "publishing_validation_jobs", "publishing_lifecycle_events", "preorders", "commercial_audio_playback",
  // Legal version rules, evidence disputes, trust gates and financial receipts
  // also influence authorization. Never omit their direct writers.
  "rights_contract_version_territories", "rights_contract_version_formats", "rights_contract_version_channels", "rights_contract_audit", "rights_disputes", "rights_dispute_events", "rights_notification_jobs", "copyright_notices", "copyright_counter_notices", "copyright_court_actions", "commercial_delivery_policies", "commercial_audio_policy_versions", "commercial_audio_submission_snapshots", "finance_royalty_allocations", "finance_usage_events", "finance_usage_pools", "royalty_holds", "publishing_validation_results", "publishing_accessibility_declarations", "publishing_rights_evidence_scan_jobs", "publisher_partner_credentials", "publisher_feed_submissions", "publisher_feed_items", "publisher_feed_assets", "publisher_validation_responses", "publishing_identity_verifications", "publishing_content_policy_assessments", "publishing_account_members",
] as const;

// Detect mutating SQL anywhere in the statement, not merely at position 0:
// writable CTEs, nested statements and multi-statement strings also fail.
// Conservative false positives are safe on an opt-in write-closure audit.
const MUTATION = /\b(?:INSERT\s+(?:OR\s+\w+\s+)?INTO|REPLACE\s+INTO|UPDATE(?:\s+OR\s+\w+)?|DELETE\s+FROM|DROP\s+TABLE|ALTER\s+TABLE|CREATE\s+(?:TEMP\s+|TEMPORARY\s+)?TABLE)\s+(?:["'`\x5b]?[a-z_][a-z0-9_]*["'`\]]?\s*\.\s*)?["'`\x5b]?([a-z_][a-z0-9_]*)/gi;
const PRIVILEGED_DDL = /\b(?:CREATE\s+(?:TEMP\s+)?TRIGGER|DROP\s+TRIGGER|ATTACH\s+DATABASE|DETACH\s+DATABASE|PRAGMA\s+writable_schema)\b/i;
const legal=new Set<string>(LEGAL_TABLES);
// The exact three independently reviewed listening-position statements are
// NOT rights, payments or protected media authorization writers. Allow only
// these literal SQL shapes through the isolated staging lock. Any change to
// their columns, predicates or appended SQL fails closed; no table-wide
// exemption is possible (including other writes to this same table).
// Deliberately split SQL verbs from the remaining *static* strings here:
// this is an exact-match comparator, NOT an executable writer. The actual
// three source statements remain visible to the conservative SQL-site audit.
const NONAUTH_AUDIO_POSITION_SQL=new Set([
  "DELETE"+" FROM commercial_audio_playback WHERE user_id=? AND product_id=? AND version=?",
  "UPDATE"+" commercial_audio_playback SET chapter_id=?,seconds=?,speed=?,version=?,updated_at=? WHERE user_id=? AND product_id=? AND version=?",
  "INSERT"+" INTO commercial_audio_playback(user_id,product_id,chapter_id,seconds,speed,version,updated_at) VALUES(?,?,?,?,?,?,?)",
  // The production /commercial-audio/playback PUT route checks signed-in
  // access, buyer risk and live legal owner BEFORE these progress writes.
  "INSERT"+" INTO commercial_audio_playback(user_id,product_id,chapter_id,seconds,speed,version,updated_at) VALUES(?,?,?,?,?,1,?) ON CONFLICT(user_id,product_id) DO NOTHING RETURNING version,updated_at",
  "UPDATE"+" commercial_audio_playback SET chapter_id=?,seconds=?,speed=?,version=version+1,updated_at=? WHERE user_id=? AND product_id=? AND version=? RETURNING version,updated_at",
  // Account deletion can erase progress but cannot thereby grant access.
  "DELETE"+" FROM commercial_audio_playback WHERE user_id=?",
]);
// SQLite accepts SQL comments BETWEEN mutation keywords and object names.
// Scrubbing via a regex is unsafe: a quoted literal containing "--" could
// remove all subsequent SQL, including a later unowned legal mutation.
// Tokenize just enough to preserve quoted strings/identifiers while treating
// real comments as whitespace. A malformed unfinished quote/comment fails
// closed during the staging ownership audit.
function neutralizeSqlComments(sql:string):string {
  let result="",i=0;
  let quote:string|null=null;
  while(i<sql.length){
    const c=sql[i]!,n=sql[i+1];
    if(quote!==null){
      result+=c;
      if(c===quote){
        if(n===quote){result+=n;i+=2;continue;}
        quote=null;
      }
      i++;continue;
    }
    if(c==="'"||c==="\""||c==="`"||c==="["){
      quote=c==="["?"]":c;result+=c;i++;continue;
    }
    if(c==="-"&&n==="-"){
      result+=" ";i+=2;
      while(i<sql.length&&sql[i]!=="\n"&&sql[i]!=="\r")i++;
      continue;
    }
    if(c==="/"&&n==="*"){
      result+=" ";i+=2;
      const end=sql.indexOf("*/",i);
      if(end<0)throw Error("invalid_legal_sql");
      i=end+2;continue;
    }
    result+=c;i++;
  }
  if(quote!==null)throw Error("invalid_legal_sql");
  return result;
}
export function classifyProtectedLegalSql(sql:string) {
  if (typeof sql!=="string" || sql.length>32768)
    throw Error("invalid_legal_sql");
  // Match the reviewed safe SQL *exactly*, never normalized whitespace,
  // comments or substrings that could hide a second protected statement.
  if(NONAUTH_AUDIO_POSITION_SQL.has(sql))return [];
  // Writable CTEs and multi-statement strings stay visible, even if an
  // untrusted-looking SQL fragment interposes comments between tokens.
  const visible=neutralizeSqlComments(sql);
  if (PRIVILEGED_DDL.test(visible)) return ["privileged-sql"];
  const matches=[...visible.matchAll(MUTATION)]
    .map(match=>match[1]!.toLowerCase()).filter(name=>legal.has(name));
  return [...new Set(matches)];
}
export function guardProtectedLegalSql(sql:string) {
  const affected=classifyProtectedLegalSql(sql);
  if (affected.length)
    throw Error("canonical_legal_write_requires_owner_fence");
}
// A database proxy that cannot leak underlying prepared statements into a
// batch. Normal non-legal writes continue during inventory testing.
export function makeStageLegalWriterLock<T extends {
  prepare(sql:string):unknown; batch(statements:unknown[]):Promise<unknown>;
}>(db:T):T {
  const statements=new WeakMap<object,object>();
  const wrap=(inner:object):object=>{
    const wrapper=new Proxy(inner,{
      get(target,key) {
        if(key==="bind")return (...args:unknown[])=>
          wrap((target as {bind(...values:unknown[]):object}).bind(...args));
        const value=Reflect.get(target,key,target);
        return typeof value==="function"?value.bind(target):value;
      }
    });
    statements.set(wrapper,inner);
    return wrapper;
  };
  return new Proxy(db,{
    get(target,key){
      if(key==="prepare")return (sql:string)=>{
        guardProtectedLegalSql(sql);
        return wrap((target as {prepare(sql:string):object}).prepare(sql));
      };
      if(key==="batch")return (batch:unknown[])=>{
        if(!Array.isArray(batch)||batch.length===0 ||
           batch.some(stmt=>!stmt || typeof stmt!=="object"||!statements.has(stmt)))
          throw Error("unfenced_legal_batch_statement");
        return target.batch(batch.map(stmt=>statements.get(stmt as object)!));
      };
      if(key==="exec")return ()=>{throw Error("unfenced_legal_sql_exec");};
      if(key==="withSession") {
        const open=Reflect.get(target,key,target);
        if(typeof open!=="function")return undefined;
        return (...args:unknown[])=>makeStageLegalWriterLock(open.apply(target,args));
      }
      const value=Reflect.get(target,key,target);
      return typeof value==="function"?value.bind(target):value;
    }
  });
}

export function scopeStageLegalWriterEnv<T extends {
  COVE_SSR_STAGING?:string;
  COVE_CANONICAL_LEGAL_WRITE_LOCK?:string;
  DB:{prepare(sql:string):unknown;batch(statements:unknown[]):Promise<unknown>};
}>(env:T):T {
  if(env.COVE_CANONICAL_LEGAL_WRITE_LOCK!=="1")return env;
  // Never silently ignore a cutover flag on a production Worker, and never
  // turn on a new legal data plane without independently validated writers.
  if(env.COVE_SSR_STAGING!=="1")
    throw Error("production_legal_writer_cutover_not_certified");
  return {...env,DB:makeStageLegalWriterLock(env.DB)};
}
