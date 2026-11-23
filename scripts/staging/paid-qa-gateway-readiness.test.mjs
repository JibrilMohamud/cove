/* eslint-disable prettier/prettier -- Bounded hosted first-contact test, no real D1. */
import assert from "node:assert/strict";
import {test} from "node:test";
import {awaitPaidQaGatewayReadiness,retryableQaBootstrapRead,qaPrimaryBootstrapSql} from "./paid-qa-gateway-readiness.mjs";

const schemaSql="SELECT type,name,tbl_name,sql FROM sqlite_master WHERE sql IS NOT NULL AND type IN ('table','index') ORDER BY CASE type WHEN 'table' THEN 0 ELSE 1 END,name LIMIT 40 OFFSET ?";
const origin="https://cove-paid-d1-gateway-45000012345-1.cove-qa-reads.workers.dev";
const gate="c".repeat(64);
const success=data=>new Response(JSON.stringify(data),{status:200});
const queryOk=()=>success({success:true,result:[{success:true,results:[]}]});
const healthOk=()=>success({ready:true});

test("only exact source metadata and primary metadata SELECT may receive transient route retry",()=>{
  const schema="/d1/database/schema-id/query",primary="/d1/database/qa-id/query";
  const yes=(r,b)=>retryableQaBootstrapRead(r,b,schema,primary,schemaSql);
  assert.equal(yes(schema,{sql:schemaSql,params:[0]}),true);
  assert.equal(yes(schema,{sql:schemaSql,params:[40]}),true);
  assert.equal(yes(primary,{sql:qaPrimaryBootstrapSql,params:[]}),true);
  for(const x of [
    [primary,{sql:"UPDATE entitlements SET status='active'",params:[]}],
    [primary,{sql:"SELECT * FROM entitlements",params:[]}],
    [schema,{sql:schemaSql,params:[1]}],
    [schema,{sql:schemaSql,params:[1200]}],
    [schema,{sql:schemaSql+"; DELETE FROM entitlements",params:[0]}],
    [primary,{sql:qaPrimaryBootstrapSql,params:[1]}],
    [primary,{sql:"WITH x AS (DELETE FROM entitlements) SELECT * FROM x",params:[]}],
    ["/d1/database/production/query",{sql:qaPrimaryBootstrapSql,params:[]}],
  ]) assert.equal(yes(x[0],x[1]),false,JSON.stringify(x));
});

test("three successive positive health, schema POST and primary POST proofs are required",async()=>{
  let primaryCalls=0,rounds=0;
  const trace=[];
  const fetchImpl=async(url,options)=>{
    assert.equal(options.headers.authorization,"Bearer "+gate);
    const route=new URL(url).pathname;
    if(route==="/__health"){
      assert.equal(options.method,"GET");rounds++;
      return healthOk();
    }
    assert.equal(route,"/__query");
    assert.equal(options.method,"POST");
    const request=JSON.parse(options.body);
    assert.deepEqual(Object.keys(request).sort(),["database","params","sql"]);
    if(request.database==="schema"){
      assert.equal(request.sql,schemaSql);
      assert.deepEqual(request.params,[0]);
      trace.push("schema");return queryOk();
    }
    assert.equal(request.database,"qa");
    assert.equal(request.sql,qaPrimaryBootstrapSql);
    assert.deepEqual(request.params,[]);
    trace.push("primary");
    primaryCalls++;
    return primaryCalls===1?new Response("",{status:404}):queryOk();
  };
  const x=await awaitPaidQaGatewayReadiness({
    origin,gate,schemaSql,fetchImpl,sleep:async()=>{},attempts:8
  });
  assert.equal(primaryCalls,4);
  assert.equal(rounds,4);
  assert.equal(x.passes,3);
  assert.equal(x.transient["primary:HTTP_404"],1);
  assert.deepEqual(trace,["schema","primary","schema","primary","schema","primary","schema","primary"]);
});

test("gateway must fail closed on permanent credential errors; never attempt a mutation",async()=>{
  const calls=[];
  const fetchImpl=async(url,opts)=>{
    const route=new URL(url).pathname;
    calls.push(route);
    if(route==="/__health")return healthOk();
    return new Response("",{status:401});
  };
  await assert.rejects(()=>awaitPaidQaGatewayReadiness({
    origin,gate,schemaSql,fetchImpl,sleep:async()=>{}
  }),/qa_gateway_readiness_unexpected_schema_HTTP_401/);
  assert.deepEqual(calls,["/__health","/__query"]);
});

test("intermittent 503 and invalid 200 cannot be counted as consecutive good rounds",async()=>{
  let calls=0;
  const x=await awaitPaidQaGatewayReadiness({
    origin,gate,schemaSql,attempts:9,sleep:async()=>{},
    fetchImpl:async(url,opts)=>{
      if(new URL(url).pathname==="/__health"){calls++;return healthOk();}
      const body=JSON.parse(opts.body);
      if(body.database==="schema"&&calls===2)
        return new Response("",{status:503});
      if(body.database==="qa"&&calls===3)
        return success({success:false});
      return queryOk();
    }
  });
  assert.equal(x.passes,3);
  assert.equal(calls,6);
  assert.equal(x.transient["schema:HTTP_503"],1);
  assert.equal(x.transient["primary:INVALID"],1);
});

test("invalid origin and gate are denied before contacting a Worker",async()=>{
  let calls=0;
  const fetchImpl=async()=>{calls++;return healthOk();};
  for(const input of [{origin:"https://covereads.com",gate},{origin,gate:"bad"}]){
    await assert.rejects(()=>awaitPaidQaGatewayReadiness({
      ...input,schemaSql,fetchImpl,sleep:async()=>{}
    }));
  }
  assert.equal(calls,0);
});
