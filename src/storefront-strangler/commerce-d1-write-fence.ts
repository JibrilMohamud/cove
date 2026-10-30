/* eslint-disable prettier/prettier -- Domain security boundary: deny commerce SQL before the D1 driver. */
/**
 * Commerce-specific production cutover containment, disabled by default.
 *
 * This is an execution restriction, not a rights-owner authorization receipt.
 * The isolation fence deliberately permits non-commerce D1 operations so that
 * publishing/catalog migration can proceed independently from the 56-site
 * commerce legacy writer family. A production release STILL requires a
 * deployed owner with independent Stripe/rights verification, removal of
 * historical D1 principals, and a rollback rehearsal.
 *
 * D1 does not expose table-specific grants. The facade must be applied at
 * both HTTP and cron entrypoints and treats unknown SQL as unsafe. External
 * Workers/API credentials, triggers, and indirect executor calls require
 * separate deployment-level evidence before production certification.
 */
const PROD_D1="4bd657ac-8789-403e-a28c-93aba8d0a989";
export const COMMERCE_OWNER_D1_FENCE="COVE_COMMERCE_OWNER_D1_FENCE";

/** Protect financial transactions and their permission/royalty side effects.
 * A lexical match is intentionally wider than the 56 reviewed SQL sites:
 * mutations in other modules must not bypass the same domain boundary. */
const protectedSqlIdentifiers=/\b(?:commerce_[a-z0-9_]*|finance_[a-z0-9_]*|royalty_[a-z0-9_]*|creator_royalty_[a-z0-9_]*|stripe_[a-z0-9_]*|payment_[a-z0-9_]*|preorder_[a-z0-9_]*|entitlements|preorders|publishing_entitlement_version_pins|publishing_owner_version_events|publishing_outbox|audio_offline_licenses|commercial_delivery_grants|account_billing_methods)\b/i;
type Prepared={
  bind(...args:unknown[]):Prepared;
  first<T=unknown>():Promise<T|null>;
  all<T=unknown>():Promise<{results:T[]}>;
  run():Promise<unknown>;
};
type DB={prepare(sql:string):Prepared;batch(stmts:Prepared[]):Promise<unknown>};
type Env={DB:DB;COVE_COMMERCE_OWNER_D1_FENCE?:string;
  COVE_COMMERCE_OWNER_PRODUCTION_ENABLED?:string;
  COVE_RIGHTS_OWNER_ENABLED?:string;
  STRIPE_LIVEMODE?:string;
  COVE_CANONICAL_LEGAL_WRITE_LOCK?:string;
  COVE_LEGAL_WRITER_PRIMARY_ID?:string;
  COVE_SSR_STAGING?:string;COVE_LEGAL_CONSUMER_STAGE_ENABLED?:string;
  COVE_RIGHTS_OWNER_SECRET?:string;
  LEGAL_AUTHORITY?:{getByName(name:string):unknown};
};
const deny=():never=>{throw Error("canonical_d1_commerce_nonowner_write_denied");};

/** Hide values in single-quoted SQLite string literals, but retain all SQL
 * identifier tokens, including double quotes/backticks/square brackets.
 * Reject comments, stacked statements and unmatched literals before D1.
 * This is a deliberately restrictive lexical gate, NOT a full SQL parser. */
function checkedTokens(sql:unknown):string {
  if(typeof sql!=="string"||sql.length<1||sql.length>65536)return deny();
  let tokens="",state:"plain"|"single"|"double"|"tick"|"bracket"="plain";
  for(let i=0;i<sql.length;i++){
    const c=sql[i],next=sql[i+1]||"";
    if(state==="single"){
      if(c==="'"){
        if(next==="'"){i++;continue;}
        state="plain";tokens+=" ";
      }
      continue;
    }
    if(state==="double"||state==="tick"||state==="bracket"){
      if((state==="double"&&c==='"')||
         (state==="tick"&&c==="`")||
         (state==="bracket"&&c==="]")){
        if(next===c){i++;tokens+=c;continue;}
        state="plain";tokens+=" ";
      }else tokens+=c;
      continue;
    }
    if(c==="'"){state="single";tokens+=" ";continue;}
    if(c==='"'){state="double";tokens+=" ";continue;}
    if(c==="`"){state="tick";tokens+=" ";continue;}
    if(c==="["){state="bracket";tokens+=" ";continue;}
    if(c===";"||c==="\0"||c==="-"&&next==="-"||c==="/"&&next==="*")deny();
    tokens+=c;
  }
  if(state!=="plain")deny();
  return tokens;
}

function commerceSqlAllowed(sql:unknown):boolean {
  const tokens=checkedTokens(sql);
  const start=/^\s*(SELECT|INSERT|REPLACE|UPDATE|DELETE)\b/i.exec(tokens);
  if(!start)return deny(); // deny DDL, PRAGMA, WITH/CTE, ATTACH, EXPLAIN, VACUUM, etc
  if(start[1].toUpperCase()==="SELECT")return true;
  if(protectedSqlIdentifiers.test(tokens))deny();
  // This facade can only assert that the direct SQL statement is isolated.
  // Unrelated DML remains allowed; DB triggers and other principals must be
  // independently inventoried before live commerce owner-only activation.
  return true;
}

export function commerceRestrictedCanonicalD1<T extends DB>(db:T):T {
  const originals=new WeakMap<object,Prepared>();
  const wrap=(statement:Prepared):Prepared=>{
    const facade:Prepared=Object.freeze({
      bind(...args:unknown[]){return wrap(statement.bind(...args));},
      first<U=unknown>(){return statement.first<U>();},
      all<U=unknown>(){return statement.all<U>();},
      run(){return statement.run()}
    });
    originals.set(facade,statement);
    return facade;
  };
  return Object.freeze({
    prepare(sql:string){
      commerceSqlAllowed(sql);
      return wrap(db.prepare(sql));
    },
    batch(statements:Prepared[]){
      if(!Array.isArray(statements)||statements.length<1||statements.length>100)
        throw Error("canonical_d1_commerce_untrusted_batch_denied");
      const checked=statements.map(s=>{
        if(!s||typeof s!=="object")throw Error("canonical_d1_commerce_foreign_statement_denied");
        const original=originals.get(s);
        if(!original)throw Error("canonical_d1_commerce_foreign_statement_denied");
        return original;
      });
      return db.batch(checked);
    }
  }) as unknown as T;
}

/** Strict opt-in. Disabled deployments preserve original DB object identity
 * and business behavior. Malformed/partial activation is always a failure,
 * never permission to fall back to legacy commerce SQL. */
export function scopeCommerceProductionD1<T extends Env>(env:T):T {
  const setting=env.COVE_COMMERCE_OWNER_D1_FENCE;
  const activation=env.COVE_COMMERCE_OWNER_PRODUCTION_ENABLED;
  // Do not permit the legacy writer fallback if production enrollment is
  // requested while the database execution fence is missing.
  if(activation!==undefined&&activation!=="0"&&setting!=="1")
    throw Error("canonical_d1_commerce_activation_without_write_fence");
  if(setting===undefined||setting==="0")return env;
  if(setting!=="1"||
     activation!=="1"||
     env.COVE_RIGHTS_OWNER_ENABLED!=="1"||
     // The private settlement/refund owner uses strict "true" for Stripe\n     // livemode; accepting "1" here would admit a mode disagreement.\n     env.STRIPE_LIVEMODE!=="true"||
     env.COVE_CANONICAL_LEGAL_WRITE_LOCK!=="1"||
     env.COVE_LEGAL_WRITER_PRIMARY_ID!==PROD_D1||
     env.COVE_LEGAL_CONSUMER_STAGE_ENABLED==="1"||
     env.COVE_SSR_STAGING==="1"||
     !/^[a-f0-9]{64}$/.test(env.COVE_RIGHTS_OWNER_SECRET||"")||
     !env.LEGAL_AUTHORITY?.getByName||
     !env.DB||typeof env.DB.prepare!=="function"||
     typeof env.DB.batch!=="function")
    throw Error("canonical_d1_commerce_cutover_not_certified");
  return {...env,DB:commerceRestrictedCanonicalD1(env.DB)};
}
