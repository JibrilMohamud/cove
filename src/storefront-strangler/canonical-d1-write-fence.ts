/* eslint-disable prettier/prettier -- Security boundary deliberately minimizes the exposed D1 API. */
/**
 * Transitional execution fence, NOT production authorizing ownership.
 *
 * Used only after independent production owner certification. Protects the
 * entire persistence backend entrypoint (HTTP and scheduled cron) against
 * accidental fallback into any direct canonical D1 mutation. SQL is never
 * passed to the owner, and this fence NEVER enables an owner command.
 *
 * This must never be treated as proof that legacy writer findings are retired:
 * the reviewed SQL remains until callers use independently verified owner
 * commands and direct Cloudflare D1 capabilities are physically removed.
 */
const PRODUCTION_D1="4bd657ac-8789-403e-a28c-93aba8d0a989";
export const EXCLUSIVE_WRITER_FENCE="COVE_OWNER_EXCLUSIVE_WRITER_FENCE";

type Statement = {
  bind(...values:unknown[]):Statement;
  first<T=unknown>():Promise<T|null>;
  all<T=unknown>():Promise<{results:T[]}>;
  run():Promise<unknown>;
};
type D1={prepare(sql:string):Statement;batch(statements:Statement[]):Promise<unknown>};
type FenceEnv={
  DB:D1;
  COVE_OWNER_EXCLUSIVE_WRITER_FENCE?:string;
  COVE_CANONICAL_LEGAL_WRITE_LOCK?:string;
  COVE_LEGAL_WRITER_PRIMARY_ID?:string;
  COVE_LEGAL_CONSUMER_STAGE_ENABLED?:string;
  COVE_SSR_STAGING?:string;
};
const safeSelect=(sql:unknown)=>typeof sql==="string"&&
  /^\s*SELECT\s/i.test(sql)&&!sql.includes(";")&&
  !/--|\/\*/.test(sql);

/**
 * Closed, deliberately incomplete D1 facade: a raw DB binding, mutable SQL,
 * arbitrary D1 method, unrecognized prepared statement or CTE cannot cross
 * the exclusive owner cutover. No weak allowlist of mutating SQL is exposed.
 */
export function readOnlyCanonicalD1<DB extends D1>(db:DB):DB {
  const prepared=new WeakMap<object,Statement>();
  function wrap(original:Statement):Statement {
    const exposed:Statement=Object.freeze({
      bind(...args:unknown[]){return wrap(original.bind(...args));},
      first<T=unknown>(){return original.first<T>();},
      all<T=unknown>(){return original.all<T>();},
      run(){return original.run();}
    });
    prepared.set(exposed,original);
    return exposed;
  }
  return Object.freeze({
    prepare(sql:string){
      if(!safeSelect(sql))throw Error("canonical_d1_nonowner_mutation_denied");
      return wrap(db.prepare(sql));
    },
    batch(statements:Statement[]){
      if(!Array.isArray(statements)||statements.length<1||statements.length>100)
        throw Error("canonical_d1_untrusted_batch_denied");
      const originals=statements.map(statement=>{
        if(!statement||typeof statement!=="object")throw Error("canonical_d1_foreign_statement_denied");
        const original=prepared.get(statement);
        if(!original)throw Error("canonical_d1_foreign_statement_denied");
        return original;
      });
      return db.batch(originals);
    }
  }) as unknown as DB;
}

/** Defaults to an exact no-op in every existing deployment. Never enable this
 * flag until live production owner route + rollback and all caller conversion
 * have been independently certified. A malformed/partially enabled flag is
 * rejected, rather than silently restoring a legacy writer fallback. */
export function scopeExclusiveCanonicalD1<T extends FenceEnv>(env:T):T {
  const flag=env.COVE_OWNER_EXCLUSIVE_WRITER_FENCE;
  if(flag===undefined||flag==="0")return env;
  if(flag!=="1"||
     env.COVE_CANONICAL_LEGAL_WRITE_LOCK!=="1"||
     env.COVE_LEGAL_WRITER_PRIMARY_ID!==PRODUCTION_D1||
     env.COVE_LEGAL_CONSUMER_STAGE_ENABLED==="1"||
     env.COVE_SSR_STAGING==="1"||
     !env.DB||typeof env.DB.prepare!=="function"||
     typeof env.DB.batch!=="function")
    throw Error("canonical_d1_exclusive_cutover_not_certified");
  return {...env,DB:readOnlyCanonicalD1(env.DB)};
}
