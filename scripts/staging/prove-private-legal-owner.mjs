/* eslint-disable prettier/prettier -- Restricted live QA service-binding proof and cleanup are security boundaries. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {randomBytes} from "node:crypto";
import {spawnSync} from "node:child_process";

const account=process.env.CLOUDFLARE_ACCOUNT_ID;
const token=process.env.CLOUDFLARE_API_TOKEN;
const runId=process.env.GITHUB_RUN_ID;
assert.match(account||"",/^[a-f0-9]{32}$/);
assert.ok(token&&/^\d{8,15}$/.test(runId||""));
const ownerCfg="wrangler.legal-authority.proof.jsonc";
const callerCfg="wrangler.legal-authority.proof-caller.jsonc";
const writerCfg="wrangler.legal-authority.proof-writer.jsonc";
const writerName="cove-legal-quarantine-qa-private";
const caller="cove-private-legal-proof-"+runId;
const origin="https://"+caller+".cove-jibrilmohamud.workers.dev";
const gate=randomBytes(32).toString("hex");
const secret=randomBytes(32).toString("hex");
const writerKey=randomBytes(32).toString("hex");
const sourceId=String((Number(runId)%800000000)+100000000);
const evidenceSourceId=String(Number(sourceId)+1);
const retractIds=[String(Number(sourceId)+2),String(Number(sourceId)+3)];
const paidIds=["prd_commercial_"+runId+"_a","prd_commercial_"+runId+"_b"];
const evidenceId="gre_qa_"+evidenceSourceId+"_us";
const expires=Date.now()+12*60*1000;
let authorityEnabled=false,callerStarted=false,writerEnabled=false,seeded=false,seededEvidence=false,seededRetractions=false;
const cli=(args,input)=>{
  const result=spawnSync("npm",["exec","--yes","--package=wrangler@4.151.0","--","wrangler",...args],{
    input,encoding:"utf8",timeout:160000,
    env:{...process.env,CLOUDFLARE_SEND_METRICS:"false"}
  });
  if(result.status!==0)throw Error("wrangler_"+args[0]+"_failed: "+
    String(result.stderr||"").replace(/Bearer\s+\S+/g,"Bearer [masked]").slice(-600));
};
const api=async(method,path,body=undefined)=>{
  const response=await fetch("https://api.cloudflare.com/client/v4"+path,{
    method,headers:{authorization:"Bearer "+token,
      ...(body===undefined?{}:{"content-type":"application/json"})},
    body:body===undefined?undefined:JSON.stringify(body),
    signal:AbortSignal.timeout(15000)});
  const result=await response.json();
  if(!result.success)throw Error("cloudflare_control_"+method+"_"+response.status);
  return result.result;
};
const sleep=(ms)=>new Promise(resolve=>setTimeout(resolve,ms));
// Wrangler's --secrets-file publishes code and secrets atomically in ONE
// Worker version. "deploy" followed by three "secret put" calls exposed
// partially configured public QA routes across different Cloudflare colos.
const deployWithSecrets=(config,secrets)=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),"cove-qa-secret-"));
  const filename=path.join(directory,"secrets.json");
  try{
    fs.writeFileSync(filename,JSON.stringify(secrets),{mode:0o600,flag:"wx"});
    cli(["deploy","--config",config,"--secrets-file",filename]);
  }finally{fs.rmSync(directory,{recursive:true,force:true});}
};
const post=async(path,body,authorization=gate)=>{
  const r=await fetch(origin+path,{
    method:"POST",
    headers:{"authorization":"Bearer "+authorization,"content-type":"application/json"},
    body:JSON.stringify(body),signal:AbortSignal.timeout(10000)
  });
  const payload=r.status===200?await r.json():null;
  return {status:r.status,payload};
};
// A new workers.dev hostname can be live in one colo before another.
// Retry ONLY read-only assertions while an edge returns a transient route
// 404/503. A positive proof, denial or 401 remains mandatory at the end;
// never replay owner mutations, payment settlement or revocation writes.
// Test-only exact-operation replay on an edge-generated 404. All mutations
// are owner-idempotent by immutable operationId; a 200 still must carry and
// validate a durable receipt. Do not repeat 503, timeouts or unknown writes.
const postStableDenial=async(path,body)=>{
  assert.ok(["/deny-next","/deny-next-batch","/source/retract-batch",
    "/commercial/deny-next","/commercial/deny-batch",
    "/commercial/order/deny-next"].includes(path));
  const ops=Array.isArray(body?.operations)?body.operations:[body];
  assert.ok(ops.length>0&&ops.every(x=>
    typeof x?.operationId==="string"&&x.operationId.startsWith("qa:"+runId+":") ||
    typeof x?.operationId==="string"&&x.operationId.startsWith("order-refund:"+runId)
  ),"No mutable QA request may be retried without a stable operation ID");
  for(let attempt=0;attempt<10;attempt++){
    const result=await post(path,body);
    if(result.status!==404||attempt===9)return result;
    await sleep(1000);
  }
};
const readOwner=async(path,body,authorization=gate,expected=200)=>{
  assert.ok(["/verify","/authorize-batch","/commercial/authorize-batch"].includes(path));
  let reply;
  for(let i=0;i<8;i++){
    try{reply=await post(path,body,authorization);}
    catch(error){
      if(i===7)throw error;
      await sleep(750);continue;
    }
    if(reply.status===expected || ![404,503].includes(reply.status))return reply;
    if(i<7)await sleep(750);
  }
  return reply;
};
try{
  const owner=JSON.parse(fs.readFileSync("wrangler.legal-authority.example.jsonc","utf8"));
  assert.equal(owner.workers_dev,false);
  assert.deepEqual(owner.routes,[]);
  assert.equal(owner.d1_databases[0].database_id,"5e3a6b69-6f3d-4b19-b837-01f7aa56ce87");
  assert.equal(owner.vars.COVE_RIGHTS_OWNER_ENABLED,"0");
  owner.vars.COVE_RIGHTS_OWNER_ENABLED="1";
  owner.vars.COVE_RIGHTS_OWNER_TEST_EXPIRES_AT=String(expires);
  fs.writeFileSync(ownerCfg,JSON.stringify(owner));
  authorityEnabled=true;
  deployWithSecrets(ownerCfg,{COVE_RIGHTS_OWNER_SECRET:secret});

  const writer=JSON.parse(fs.readFileSync("wrangler.legal-quarantine-qa.example.jsonc","utf8"));
  assert.equal(writer.name,writerName);
  assert.equal(writer.workers_dev,false);
  assert.deepEqual(writer.routes,[]);
  assert.equal(writer.d1_databases[0].database_id,
    "5e3a6b69-6f3d-4b19-b837-01f7aa56ce87");
  assert.equal(writer.services[0].service,owner.name);
  assert.equal(writer.vars.COVE_LEGAL_WRITER_ENABLED,"0");
  writer.vars.COVE_LEGAL_WRITER_ENABLED="1";
  writer.vars.COVE_LEGAL_WRITER_EXPIRES_AT=String(expires);
  fs.writeFileSync(writerCfg,JSON.stringify(writer));
  writerEnabled=true;
  deployWithSecrets(writerCfg,{
    COVE_LEGAL_WRITER_SECRET:writerKey,COVE_RIGHTS_OWNER_SECRET:secret
  });

  const proxy=JSON.parse(fs.readFileSync("wrangler.legal-qa-caller.example.jsonc","utf8"));
  assert.equal(proxy.services[0].service,owner.name);
  proxy.services.push({binding:"LEGAL_WRITER",service:writerName});
  proxy.name=caller;
  proxy.workers_dev=true;
  proxy.vars.COVE_LEGAL_QA_CALLER_ENABLED="1";
  proxy.vars.COVE_LEGAL_QA_EXPIRES_AT=String(expires);
  fs.writeFileSync(callerCfg,JSON.stringify(proxy));
  callerStarted=true;
  deployWithSecrets(callerCfg,{
    COVE_LEGAL_QA_GATE:gate,COVE_RIGHTS_OWNER_SECRET:secret,
    COVE_LEGAL_WRITER_SECRET:writerKey
  });

  // Configuration/Workers metadata can precede propagation of a new
  // workers.dev hostname. The readiness poll is NOT part of a capacity
  // measurement and never warms the future hosted-capacity campaign.
  let ready=false;
  // Emit only HTTP status codes and exception classes on failure. Do not
  // disclose gate material, auth tokens, request bodies, or protected state.
  // Without these bounded diagnostics a 503 private-binding misconfiguration
  // is indistinguishable from a workers.dev DNS propagation delay.
  const readinessFailures=new Map();
  for(let i=0;i<32;i++){
    await sleep(2000);
    try{
      const result=await post("/verify",{sourceId,territory:"US"});
      if(result.status===200 && result.payload?.allowed===false){
        assert.equal(result.payload.revision,null,"Unseeded source must start denied");
        ready=true;break;
      }
      const key="http_"+result.status;
      readinessFailures.set(key,(readinessFailures.get(key)||0)+1);
    }catch(error){
      const key="network_"+(error instanceof Error?error.name:"unknown");
      readinessFailures.set(key,(readinessFailures.get(key)||0)+1);
    }
  }
  assert.ok(ready,"QA owner service-binding never became usable: "+
    JSON.stringify(Object.fromEntries(readinessFailures)));
  // This database is the minimal, isolated canonical-publication QA fixture,
  // not production. Seed one private synthetic row to prove the real writer
  // can modify canonical D1 ONLY after the same DO has fenced all countries.
  const qaD1="/accounts/"+account+
    "/d1/database/5e3a6b69-6f3d-4b19-b837-01f7aa56ce87/query";
  await api("POST",qaD1,{sql:
    "INSERT OR IGNORE INTO gutenberg_source_cache(id,source_id,title,rights_status,commercial_use_status,ingest_status) VALUES(?,'pg_us','Private QA rights revocation fixture','public-domain','approved','active')",
    params:[sourceId]});
  seeded=true;
  const before=await api("POST",qaD1,{sql:
    "SELECT rights_status,commercial_use_status FROM gutenberg_source_cache WHERE id=?",
    params:[sourceId]});
  assert.equal(before[0]?.results?.[0]?.rights_status,"public-domain");

  assert.equal((await readOwner("/verify",{sourceId,territory:"CA"})).payload?.allowed,false);
  const withdrawal=await postStableDenial("/deny-next",{
    sourceId,territory:"*",operationId:"qa:"+runId+":source:deny"
  });
  assert.equal(withdrawal.status,200,"Deny-first receipt must be durable");
  assert.equal(withdrawal.payload?.applied,true);
  assert.equal(withdrawal.payload?.revision,1);
  const replay=await postStableDenial("/deny-next",{
    sourceId,territory:"*",operationId:"qa:"+runId+":source:deny"
  });
  assert.equal(replay.status,200);
  assert.equal(replay.payload?.revision,1,"Repeated writer delivery retains original epoch");
  for(const territory of ["US","CA","AU"]){
    const decision=await readOwner("/verify",{sourceId,territory});
    assert.equal(decision.status,200);
    assert.deepEqual(decision.payload,{allowed:false,revision:1},
      "Same owner must deny every country after source-wide withdrawal");
  }
  const offerings=await readOwner("/authorize-batch",{
    ids:["prd_gutenberg_"+sourceId],territory:"US",currency:"USD"
  });
  assert.equal(offerings.status,200);
  assert.deepEqual(offerings.payload?.rows,[],"Denied source cannot expose stale free retail offer");
  const unauthorized=await readOwner("/verify",{sourceId,territory:"US"},"0".repeat(64));
  assert.equal(unauthorized.status,401);
  const quarantined=await post("/quarantine",{
    sourceId,operationId:"qa:"+runId+":quarantine:1",
    message:"independently-confirmed-qa-source-withdrawal"
  });
  assert.equal(quarantined.status,200,
    "Private writer must deny at strong owner then mutate canonical QA D1");
  assert.equal(quarantined.payload?.quarantined,true);
  const after=await api("POST",qaD1,{sql:
    "SELECT rights_status,commercial_use_status,ingest_status FROM gutenberg_source_cache WHERE id=?",
    params:[sourceId]});
  assert.deepEqual(after[0]?.results?.[0],{
    rights_status:"quarantined",commercial_use_status:"quarantined",
    ingest_status:"quarantined"
  },"Canonical source status changed only by the narrowly scoped writer");
  for(const territory of ["US","CA","AU"]) {
    const state=await readOwner("/verify",{sourceId,territory});
    assert.deepEqual(state.payload,{allowed:false,revision:2},
      "Writer's source-wide fence immediately precedes and dominates primary mutation");
  }
  const repeated=await post("/quarantine",{
    sourceId,operationId:"qa:"+runId+":quarantine:1",
    message:"independently-confirmed-qa-source-withdrawal"
  });
  assert.equal(repeated.status,200);
  assert.deepEqual((await readOwner("/verify",{sourceId,territory:"US"})).payload,
    {allowed:false,revision:2},"Duplicate writer event must not allocate another revision");
  console.log("PASS: LIVE QA: owner DENY -> private canonical writer -> D1 quarantine -> 3-country denial -> exact replay");
  // Separate source and market fixtures: US evidence can be withdrawn
  // without touching an otherwise-authorized CA grant on the SAME edition.
  seededEvidence=true;
  const now=new Date().toISOString();
  await api("POST",qaD1,{sql:
    "INSERT INTO gutenberg_rights_evidence(id,source_id,cache_id,determination,territory_code,evidence_url,evidence_hash,status) VALUES(?, 'pg_us', ?, 'public-domain', 'US', 'https://www.gutenberg.org/', 'qa-us-v1', 'approved')",
    params:[evidenceId,evidenceSourceId]});
  for(const country of ["US","CA"]){
    await api("POST",qaD1,{sql:
      "INSERT INTO rights_grants(edition_id,source,territory_code,decision,status,updated_at) VALUES(?, 'gutenberg-pg_us-public-domain', ?, 'allow', 'active', ?)",
      params:["ed_gutenberg_"+evidenceSourceId,country,now]});
  }
  const evidenceResult=await post("/evidence/revoke",{
    sourceId:evidenceSourceId,territory:"US",evidenceId,
    operationId:"qa:"+runId+":evidence-us:withdraw"
  });
  assert.equal(evidenceResult.status,200,
    "Evidence revocation must fence owner before atomic D1 country update");
  assert.equal(evidenceResult.payload?.evidenceRevoked,true);
  const evidenceState=await api("POST",qaD1,{sql:
    "SELECT status FROM gutenberg_rights_evidence WHERE id=?",params:[evidenceId]});
  assert.equal(evidenceState[0]?.results?.[0]?.status,"revoked");
  const grants=await api("POST",qaD1,{sql:
    "SELECT territory_code,status FROM rights_grants WHERE edition_id=? ORDER BY territory_code",
    params:["ed_gutenberg_"+evidenceSourceId]});
  assert.deepEqual(grants[0]?.results,[{territory_code:"CA",status:"active"},
    {territory_code:"US",status:"suspended"}],
    "US evidence withdrawal must not revoke Canada's independent grant");
  assert.deepEqual((await readOwner("/verify",{sourceId:evidenceSourceId,territory:"US"})).payload,
    {allowed:false,revision:1});
  assert.deepEqual((await readOwner("/verify",{sourceId:evidenceSourceId,territory:"CA"})).payload,
    {allowed:false,revision:null},
    "CA owner remains unseeded/denied, never implicitly granted by D1 alone");
  assert.equal((await post("/evidence/revoke",{
    sourceId:evidenceSourceId,territory:"US",evidenceId,
    operationId:"qa:"+runId+":evidence-us:withdraw"
  })).status,200);
  assert.equal((await readOwner("/verify",{sourceId:evidenceSourceId,territory:"US"})).payload?.revision,1,
    "Idempotent evidence replay must keep its original owner revision");
  console.log("PASS: LIVE QA: strong owner US evidence denial -> atomic D1 evidence+grant revoke; CA grant unaffected and no inferred owner allow");
  seededRetractions=true;
  for(const id of retractIds){
    await api("POST",qaD1,{sql:
      "INSERT INTO gutenberg_source_cache(id,source_id,title,rights_status,commercial_use_status,ingest_status) VALUES(?,'pg_us','Private QA staged source retraction','public-domain','approved','active')",
      params:[id]});
  }
  const withdrawals={operations:retractIds.map((id,i)=>({
    sourceId:id,operationId:"qa:"+runId+":source-batch:"+i
  }))};
  const sourceBatch=await postStableDenial("/source/retract-batch",withdrawals);
  assert.equal(sourceBatch.status,200,
    "Strong owner must atomically commit two source-wide denials before D1 mutation");
  assert.equal(sourceBatch.payload?.retracted,2);
  const sourceRows=await api("POST",qaD1,{sql:
    "SELECT id,rights_status,ingest_status,commercial_use_status FROM gutenberg_source_cache WHERE id IN (?,?) ORDER BY id",
    params:retractIds});
  assert.equal(sourceRows[0]?.results?.length,2);
  assert.ok(sourceRows[0]?.results?.every(x=>
    x.rights_status==="quarantined" && x.ingest_status==="stale" &&
    x.commercial_use_status==="quarantined"),
    "QA D1 rows must be made ineligible by the atomic source retraction");
  for(const id of retractIds){
    for(const country of ["US","CA","AU"])
      assert.deepEqual((await readOwner("/verify",{sourceId:id,territory:country})).payload,
        {allowed:false,revision:1});
  }
  assert.equal((await postStableDenial("/source/retract-batch",withdrawals)).status,200);
  assert.equal((await readOwner("/verify",{sourceId:retractIds[0],territory:"US"})).payload?.revision,1,
    "Idempotent replay may not advance source denial epoch");
  console.log("PASS: LIVE QA: one transaction withdraws multiple sources, one canonical D1 batch retracts, US/CA/AU deny and replay preserves revisions");

  // Commercial licensed editions are separate from Gutenberg proof rows.
  // The owner denies and atomically acknowledges two contract-affected
  // product IDs without requiring a fabricated positive grant/entitlement.
  const unseededPaid=await readOwner("/commercial/authorize-batch",{
    ids:paidIds,territory:"US",channel:"retail"
  });
  assert.equal(unseededPaid.status,200);
  assert.deepEqual(unseededPaid.payload,
    {schema:"cove.commercial-legal.v1",rows:[]},
    "No unverified paid offer may become authorized from missing primary rows");
  const paidOps={operations:paidIds.map((productId,i)=>({
    productId,operationId:"qa:"+runId+":commercial-withdrawal:"+i
  }))};
  const paidWithdrawal=await postStableDenial("/commercial/deny-batch",paidOps);
  assert.equal(paidWithdrawal.status,200,
    "Licensed products must be durably denied in one SQL DO transaction");
  assert.equal(paidWithdrawal.payload?.applied,true);
  assert.deepEqual(paidWithdrawal.payload?.receipts?.map(r=>r.epoch),[1,1]);
  const paidRetry=await postStableDenial("/commercial/deny-batch",paidOps);
  assert.equal(paidRetry.status,200);
  assert.deepEqual(paidRetry.payload?.receipts?.map(r=>r.epoch),[1,1]);
  assert.deepEqual((await readOwner("/commercial/authorize-batch",{
    ids:paidIds,territory:"US",channel:"retail"
  })).payload,{schema:"cove.commercial-legal.v1",rows:[]},
  "Owner denial must exclude paid products immediately, across replay");
  console.log("PASS: LIVE QA: commercial grants independently deny by product, atomic 2-product contract fence, zero default allowances and replay epochs");

  const paidOrderDenial={
    orderId:"order_refund_"+runId,
    operationId:"order-refund:"+runId
  };
  const wholeOrder=await postStableDenial("/commercial/order/deny-next",paidOrderDenial);
  assert.equal(wholeOrder.status,200);
  assert.deepEqual(wholeOrder.payload,{
    applied:true,orderId:paidOrderDenial.orderId
  },"One owner event must fence any number of refunded entitlements");
  assert.deepEqual((await postStableDenial("/commercial/order/deny-next",paidOrderDenial)).payload,
    wholeOrder.payload,"Retry cannot un-withdraw the whole paid order");
  console.log("PASS: LIVE QA: one strongly consistent whole-order buyer denial and replay regardless of order line count");

  // Verify the committed denial through a new version of the *actual* QA
  // Worker. This exercises provider persistence, not just an in-process
  // Node SQLite reopen test. Version publication is not a capacity probe.
  cli(["deploy","--config",ownerCfg]);
  let persistent=null;
  for(let i=0;i<8;i++){
    try {
      const reply=await readOwner("/verify",{sourceId,territory:"CA"});
      if(reply.status===200 && reply.payload?.revision===2){
        persistent=reply.payload;break;
      }
    }catch{}
    await sleep(1000);
  }
  assert.deepEqual(persistent,{allowed:false,revision:2},
    "Source-wide withdrawal must survive a real Cloudflare Worker redeploy");
  assert.deepEqual((await postStableDenial("/commercial/order/deny-next",
    paidOrderDenial)).payload,wholeOrder.payload,
    "Whole-order refund veto must persist through real Cloudflare Worker redeploy");
  const persistedPaid=await readOwner("/commercial/authorize-batch",{
    ids:paidIds,territory:"US",channel:"retail"
  });
  assert.deepEqual(persistedPaid.payload,{schema:"cove.commercial-legal.v1",rows:[]});
  console.log("PASS: live protected caller -> private service binding -> SQLite DO: unseeded denial, source withdrawal, replay, 3-territory withdrawal, offer hiding, access control and Worker version persistence");
}finally{
  const errors=[];
  if(writerEnabled){
    try{cli(["deploy","--config","wrangler.legal-quarantine-qa.example.jsonc"]);}
    catch(e){errors.push("writer_disable_"+String(e.message).slice(0,120));}
  }
  if(authorityEnabled){
    try{cli(["deploy","--config","wrangler.legal-authority.example.jsonc"]);}
    catch(e){errors.push("owner_disable_"+String(e.message).slice(0,120));}
  }
  if(authorityEnabled){
    // A disabled deployment is the first safety boundary. Removing the
    // short-lived QA signing secret is the independent second boundary.
    try{
      const response=await fetch(
        "https://api.cloudflare.com/client/v4/accounts/"+account+
        "/workers/scripts/cove-legal-authority-private-qa-example/secrets/COVE_RIGHTS_OWNER_SECRET",{
          method:"DELETE",headers:{authorization:"Bearer "+token},
          signal:AbortSignal.timeout(15000)
        }
      );
      if(!response.ok)throw Error("http_"+response.status);
      const payload=await response.json().catch(()=>null);
      if(payload && payload.success===false)
        throw Error("cloudflare_secret_delete_rejected");
    }catch(e){errors.push("owner_qa_secret_delete_"+String(e.message).slice(0,120));}
  }
  if(writerEnabled){
    // The writer's owner key and its independent caller key were deliberately
    // temporary, not permanent Cloudflare account configuration.
    try{
      const settings=await api("GET","/accounts/"+account+
        "/workers/scripts/"+writerName+"/settings");
      for(const name of ["COVE_LEGAL_WRITER_SECRET","COVE_RIGHTS_OWNER_SECRET"]){
        if(!settings.bindings?.some(b=>b.name===name))continue;
        const response=await fetch(
          "https://api.cloudflare.com/client/v4/accounts/"+account+
          "/workers/scripts/"+writerName+"/secrets/"+name,{
            method:"DELETE",headers:{authorization:"Bearer "+token},
            signal:AbortSignal.timeout(15000)
          }
        );
        if(!response.ok)throw Error("secret_delete_http_"+response.status+"_"+name);
      }
    }catch(e){errors.push("writer_qa_secret_delete_"+String(e.message).slice(0,120));}
  }
  if(seeded){
    try{
      await api("POST","/accounts/"+account+
        "/d1/database/5e3a6b69-6f3d-4b19-b837-01f7aa56ce87/query",{
          sql:"DELETE FROM gutenberg_source_cache WHERE id=?",params:[sourceId]
        });
    }catch(e){errors.push("synthetic_source_cleanup_"+String(e.message).slice(0,120));}
  }
  if(seededRetractions){
    try {
      await api("POST","/accounts/"+account+
        "/d1/database/5e3a6b69-6f3d-4b19-b837-01f7aa56ce87/query",{
          sql:"DELETE FROM gutenberg_source_cache WHERE id IN (?,?)",params:retractIds
        });
    }catch(e){errors.push("synthetic_retractions_cleanup_"+String(e.message).slice(0,120));}
  }
  if(seededEvidence){
    try{
      const qa="/accounts/"+account+
        "/d1/database/5e3a6b69-6f3d-4b19-b837-01f7aa56ce87/query";
      await api("POST",qa,{sql:"DELETE FROM gutenberg_rights_evidence WHERE id=?",params:[evidenceId]});
      await api("POST",qa,{sql:"DELETE FROM rights_grants WHERE edition_id=? AND source='gutenberg-pg_us-public-domain'",
        params:["ed_gutenberg_"+evidenceSourceId]});
    }catch(e){errors.push("synthetic_evidence_cleanup_"+String(e.message).slice(0,120));}
  }
  if(callerStarted){
    try{await api("DELETE","/accounts/"+account+"/workers/scripts/"+caller);}
    catch(e){errors.push("caller_remove_"+String(e.message).slice(0,120));}
  }
  // Never accept a green certificate based only on successful commands:
  // independently verify the *effective* current Worker configuration.
  try{
    const settings=await api("GET","/accounts/"+account+
      "/workers/scripts/cove-legal-authority-private-qa-example/settings");
    assert.equal(settings.bindings?.find(b=>b.name==="COVE_RIGHTS_OWNER_ENABLED")?.text,"0");
    assert.equal(settings.bindings?.some(b=>b.name==="COVE_RIGHTS_OWNER_SECRET"),false);
    if(writerEnabled){
      const w=await api("GET","/accounts/"+account+"/workers/scripts/"+writerName+"/settings");
      assert.equal(w.bindings?.find(b=>b.name==="COVE_LEGAL_WRITER_ENABLED")?.text,"0");
      assert.equal(w.bindings?.some(b=>b.name==="COVE_LEGAL_WRITER_SECRET"),false);
      assert.equal(w.bindings?.some(b=>b.name==="COVE_RIGHTS_OWNER_SECRET"),false);
    }
    const scripts=await api("GET","/accounts/"+account+"/workers/scripts");
    assert.equal(scripts?.some(worker=>worker.id===caller),false);
  }catch(e){errors.push("rollback_verification_"+String(e.message).slice(0,120));}
  for(const file of [ownerCfg,callerCfg,writerCfg])try{fs.unlinkSync(file);}catch{}
  if(errors.length)throw Error("legal_qa_rollback_failed:"+errors.join(","));
  console.log("PASS: legal owner and quarantine writer disabled, both secrets deleted, synthetic D1 row cleaned and public QA caller deleted");
}
