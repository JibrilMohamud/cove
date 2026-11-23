/**
 * Isolated-QA-only D1 read transport for a caller with NO native D1 binding.
 *
 * This is a constrained transport prototype, NOT production authorization.
 * Production has no enrolled route, rollout flag, or acceptable synthetic QA
 * owner lease. The actual legal-owner handler must independently apply the
 * private QA lease to serveQaOwnerPrimaryRead; never expose it publicly.
 *
 * No SQL writes, raw handles, arbitrary D1 APIs or session simulation.
 * In particular, pretending that separate remote requests share D1's
 * first-primary session would be unsound: reject withSession until actual
 * consistency semantics can be proved under withdrawal and retry races.
 */
export const QA_OWNER_PRIMARY_READ_SCHEMA = "cove.qa.owner-primary-read.v1";
export const QA_OWNER_PRIMARY_READ_ROUTE = "/qa/private-primary-read";
const MAX_OPS = 24;
const MAX_QUERY_CHARS = 16384;
const MAX_BODY_CHARS = 196608;
const MAX_RESULT_CHARS = 2_097_152;
const NO_STORE = {"cache-control":"no-store","x-content-type-options":"nosniff"};
const deny = () => {throw Error("qa_owner_read_denied");};

function plainObject(x) {
  return x!==null&&typeof x==="object"&&!Array.isArray(x)&&Object.getPrototypeOf(x)===Object.prototype;
}
function exactKeys(x, expected) {
  return plainObject(x)&&Object.keys(x).sort().join(",")===expected.slice().sort().join(",");
}
export function checkedQaOwnerReadSql(sql) {
  if(typeof sql!=="string"||sql.length<1||sql.length>MAX_QUERY_CHARS)deny();
  // No WITH/CTE, PRAGMA, EXPLAIN, DML, DDL, stacked statements, comments,
  // trigger expressions or semicolon-terminated queries. False positives fail
  // closed; preserving existing queries is the acceptance test, not a reason
  // to loosen this boundary.
  if(!/^\s*SELECT\b/i.test(sql)||/[;\u0000]/.test(sql)||
     /--|\/\*|\*\//.test(sql)||
     /\b(?:INSERT|UPDATE|DELETE|REPLACE|UPSERT|CREATE|ALTER|DROP|ATTACH|DETACH|PRAGMA|VACUUM|REINDEX|ANALYZE|TRIGGER|LOAD_EXTENSION)\b/i.test(sql))deny();
  return sql;
}
export function checkedQaOwnerReadParams(params) {
  if(!Array.isArray(params)||params.length>64)deny();
  for(const value of params) {
    if(value===null||typeof value==="boolean")continue;
    if(typeof value==="number"&&Number.isFinite(value))continue;
    if(typeof value==="string"&&value.length<=8192)continue;
    deny();
  }
  return params;
}
function checkedOps(ops) {
  if(!Array.isArray(ops)||ops.length<1||ops.length>MAX_OPS)deny();
  let total=0;
  return ops.map(op=>{
    if(!exactKeys(op,["sql","params","mode"])||
       !["first","all"].includes(op.mode))deny();
    const sql=checkedQaOwnerReadSql(op.sql);
    const params=checkedQaOwnerReadParams(op.params);
    total+=sql.length;
    if(total>MAX_BODY_CHARS)deny();
    return {sql,params,mode:op.mode};
  });
}
function json(body,status=200) {
  return Response.json(body,{status,headers:NO_STORE});
}

/** Called only inside the separately leased QA legal owner, never from a
 * public Worker endpoint or production's disabled-authority exception. */
export async function serveQaOwnerPrimaryRead(request, primary, secret, qaLeaseLive) {
  if(qaLeaseLive!==true||!primary||typeof primary.prepare!=="function")
    return json({error:"qa_owner_read_not_enrolled"},503);
  if(typeof secret!=="string"||!/^[a-f0-9]{64}$/.test(secret))
    return json({error:"qa_owner_read_secret_invalid"},503);
  if(request.headers.get("authorization")!=="Bearer "+secret)
    return json({error:"qa_owner_read_unauthorized"},401);
  if(new URL(request.url).pathname!==QA_OWNER_PRIMARY_READ_ROUTE)
    return json({error:"qa_owner_read_not_found"},404);
  if(request.method!=="POST"||
     request.headers.get("content-type")?.split(";")[0]?.trim()!=="application/json")
    return json({error:"qa_owner_read_method_denied"},405);
  let input;
  try {
    const body=await request.text();
    if(body.length>MAX_BODY_CHARS)return json({error:"qa_owner_read_too_large"},413);
    input=JSON.parse(body);
    if(!exactKeys(input,["schema","ops"])||input.schema!==QA_OWNER_PRIMARY_READ_SCHEMA)
      return json({error:"qa_owner_read_bad_schema"},400);
    const ops=checkedOps(input.ops);
    const statements=ops.map(op=>primary.prepare(op.sql).bind(...op.params));
    const result=[];
    // D1 batch is used only for all() statements. A mixed batch must not
    // masquerade as an atomic session: execute per-request and never claim a
    // transaction when calls need first()/all() shape parity.
    if(ops.length>1) {
      if(ops.some(op=>op.mode!=="all")||typeof primary.batch!=="function")
        return json({error:"qa_owner_read_mixed_batch_denied"},400);
      const batch=await primary.batch(statements);
      if(!Array.isArray(batch)||batch.length!==ops.length)
        return json({error:"qa_owner_read_result_mismatch"},503);
      result.push(...batch);
    } else {
      const statement=statements[0];
      result.push(ops[0].mode==="first"?await statement.first():await statement.all());
    }
    const output=JSON.stringify({schema:QA_OWNER_PRIMARY_READ_SCHEMA,result});
    if(output.length>MAX_RESULT_CHARS)
      return json({error:"qa_owner_read_result_too_large"},503);
    return new Response(output,{status:200,headers:{...NO_STORE,"content-type":"application/json"}});
  } catch {
    return json({error:"qa_owner_read_failed_closed"},503);
  }
}

export function createQaOwnerReadOnlyD1(owner,secret) {
  if(typeof owner?.fetch!=="function"||typeof secret!=="string"||
     !/^[a-f0-9]{64}$/.test(secret))deny();
  const issued=new WeakMap();
  async function send(ops) {
    checkedOps(ops);
    const response=await owner.fetch(new Request(
      "https://cove-owner.internal"+QA_OWNER_PRIMARY_READ_ROUTE,{
        method:"POST",headers:{
          "authorization":"Bearer "+secret,
          "content-type":"application/json",
        },body:JSON.stringify({schema:QA_OWNER_PRIMARY_READ_SCHEMA,ops}),
      }));
    if(!response||response.status!==200||
       response.headers.get("cache-control")!=="no-store")deny();
    const body=await response.text();
    if(body.length>MAX_RESULT_CHARS)deny();
    let message;
    try {message=JSON.parse(body);}catch{deny();}
    if(!exactKeys(message,["schema","result"])||
       message.schema!==QA_OWNER_PRIMARY_READ_SCHEMA||
       !Array.isArray(message.result)||message.result.length!==ops.length)deny();
    return message.result;
  }
  function prepared(sql,params) {
    checkedQaOwnerReadSql(sql);
    checkedQaOwnerReadParams(params);
    const receipt=Object.freeze({
      bind(...values) {return prepared(sql,values);},
      async first() {return (await send([{mode:"first",sql,params}]))[0];},
      async all() {
        const value=(await send([{mode:"all",sql,params}]))[0];
        if(!exactKeys(value,["results"])&&!Array.isArray(value?.results))deny();
        return value;
      },
      run:deny,raw:deny,
    });
    issued.set(receipt,{mode:"all",sql,params});
    return receipt;
  }
  return Object.freeze({
    prepare(sql) {return prepared(sql,[]);},
    async batch(statements) {
      if(!Array.isArray(statements)||statements.length<1||
         statements.length>MAX_OPS)deny();
      const ops=statements.map(statement=>{
        if(!statement||typeof statement!=="object")deny();
        const op=issued.get(statement);
        if(!op)deny();
        return op;
      });
      return send(ops);
    },
    // An independent request is not a sticky primary session.
    withSession:deny,
    exec:deny,
  });
}
