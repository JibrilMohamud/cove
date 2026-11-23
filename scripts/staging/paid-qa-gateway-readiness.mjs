/* eslint-disable prettier/prettier -- Isolated paid-QA route propagation and safe D1 SELECT bootstrap. */
import assert from "node:assert/strict";

// These are the ONLY first-contact D1 SELECT shapes eligible for a bounded
// Workers.dev routing retry. Never replay uncertain schema/commerce mutations.
export const qaPrimaryBootstrapSql="SELECT type,name FROM sqlite_master WHERE type IN ('table','index')";
export function retryableQaBootstrapRead(resource,body,schemaResource,primaryResource,schemaSql){
  if(!body||typeof body.sql!=="string"||!Array.isArray(body.params))return false;
  if(resource===schemaResource)return body.sql===schemaSql&&
    body.params.length===1&&Number.isSafeInteger(body.params[0])&&
    body.params[0]>=0&&body.params[0]<1200&&body.params[0]%40===0;
  return resource===primaryResource&&body.sql===qaPrimaryBootstrapSql&&
    body.params.length===0;
}

// A health 200 at one colo does not prove a just-deployed POST route works at
// subsequent colos. Require consecutive affirmative health, schema-source POST
// and PRIMARY POST responses before issuing ANY synthetic DDL/payment request.
// The only traffic here is authenticated, exact, read-only SQL and GET health.
// An unexpected 4xx is terminal; 404/5xx may recover within a bounded budget.
export async function awaitPaidQaGatewayReadiness({
  origin,gate,schemaSql,fetchImpl=fetch,sleep=ms=>new Promise(r=>setTimeout(r,ms)),
  attempts=24,consecutiveRequired=3
}){
  const endpoint=new URL(origin);
  assert.equal(endpoint.protocol,"https:");
  assert.equal(endpoint.origin,origin);
  assert.match(endpoint.hostname,/^cove-paid-d1-gateway-\d{8,15}-\d{1,5}\.cove-qa-reads\.workers\.dev$/);
  assert.match(gate,/^[a-f0-9]{64}$/);
  assert.match(schemaSql,/^SELECT type,name,tbl_name,sql FROM sqlite_master /);
  assert.ok(Number.isSafeInteger(attempts)&&attempts>=consecutiveRequired&&attempts<=40);
  assert.ok(Number.isSafeInteger(consecutiveRequired)&&consecutiveRequired>=2&&consecutiveRequired<=5);
  const headers={authorization:"Bearer "+gate};
  const seen=new Map();
  let consecutive=0;
  async function inspect(method,route,body,label){
    const response=await fetchImpl(origin+route,{
      method,headers:{...headers,...(body?{"content-type":"application/json"}:{})},
      ...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(10000)
    });
    let valid=false;
    if(response.status===200){
      const result=await response.json().catch(()=>null);
      valid=label==="health"?result?.ready===true:
        result?.success===true&&result?.result?.[0]?.success===true&&
        Array.isArray(result.result[0].results);
    }
    if(valid)return true;
    const code=valid?"ok":response.status===200?"INVALID":"HTTP_"+response.status;
    seen.set(label+":"+code,(seen.get(label+":"+code)||0)+1);
    if(![200,404,500,502,503,504].includes(response.status))
      throw Error("qa_gateway_readiness_unexpected_"+label+"_HTTP_"+response.status);
    return false;
  }
  for(let attempt=0;attempt<attempts;attempt++){
    let ready=false;
    try{
      const health=await inspect("GET","/__health",null,"health");
      if(health){
        const schema=await inspect("POST","/__query",
          {database:"schema",sql:schemaSql,params:[0]},"schema");
        if(schema){
          ready=await inspect("POST","/__query",
            {database:"qa",sql:qaPrimaryBootstrapSql,params:[]},"primary");
        }
      }
    }catch(error){
      if(error instanceof Error&&error.message.startsWith("qa_gateway_readiness_unexpected_"))
        throw error;
      const type=error instanceof Error?error.name:"unknown";
      seen.set("transport:"+type,(seen.get("transport:"+type)||0)+1);
    }
    consecutive=ready?consecutive+1:0;
    if(consecutive===consecutiveRequired){
      return {passes:consecutive,transient:Object.fromEntries(seen)};
    }
    if(attempt+1<attempts)await sleep(1200);
  }
  throw Error("qa_gateway_readiness_failed:"+JSON.stringify(Object.fromEntries(seen)));
}
