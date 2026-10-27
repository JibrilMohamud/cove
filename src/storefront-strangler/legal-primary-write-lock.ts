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
  "finance_royalty_events", "publishing_outbox"
] as const;

// Detect mutating SQL anywhere in the statement, not merely at position 0:
// writable CTEs, nested statements and multi-statement strings also fail.
// Conservative false positives are safe on an opt-in write-closure audit.
const MUTATION = /\b(?:INSERT\s+(?:OR\s+\w+\s+)?INTO|REPLACE\s+INTO|UPDATE(?:\s+OR\s+\w+)?|DELETE\s+FROM|DROP\s+TABLE|ALTER\s+TABLE|CREATE\s+(?:TEMP\s+|TEMPORARY\s+)?TABLE)\s+(?:["'`\x5b]?[a-z_][a-z0-9_]*["'`\]]?\s*\.\s*)?["'`\x5b]?([a-z_][a-z0-9_]*)/gi;
const PRIVILEGED_DDL = /\b(?:CREATE\s+(?:TEMP\s+)?TRIGGER|DROP\s+TRIGGER|ATTACH\s+DATABASE|DETACH\s+DATABASE|PRAGMA\s+writable_schema)\b/i;
const legal=new Set<string>(LEGAL_TABLES);
export function classifyProtectedLegalSql(sql:string) {
  if (typeof sql!=="string" || sql.length>32768)
    throw Error("invalid_legal_sql");
  // Fail even on a statement with comments before a mutating query. Parsing
  // the complete SQL string avoids bypasses through WITH or a semicolon.
  if (PRIVILEGED_DDL.test(sql)) return ["privileged-sql"];
  const matches=[...sql.matchAll(MUTATION)]
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
