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
  "entitlements", "delivery_grants", "offline_epub_licenses"
] as const;

// Detect mutating SQL anywhere in the statement, not merely at position 0:
// writable CTEs, nested statements and multi-statement strings also fail.
// Conservative false positives are safe on an opt-in write-closure audit.
const MUTATION = /\b(?:INSERT\s+(?:OR\s+\w+\s+)?INTO|REPLACE\s+INTO|UPDATE(?:\s+OR\s+\w+)?|DELETE\s+FROM|DROP\s+TABLE|ALTER\s+TABLE|CREATE\s+(?:TEMP\s+|TEMPORARY\s+)?TABLE)\s+["'`]?([a-z_][a-z0-9_]*)/gi;
const legal=new Set<string>(LEGAL_TABLES);
export function classifyProtectedLegalSql(sql:string) {
  if (typeof sql!=="string" || sql.length>32768)
    throw Error("invalid_legal_sql");
  // Fail even on a statement with comments before a mutating query. Parsing
  // the complete SQL string avoids bypasses through WITH or a semicolon.
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
