/* eslint-disable prettier/prettier -- Exact isolated paid QA identity boundary regression. */
import assert from "node:assert/strict";
import {isPaidOwnerQaSchemaTable} from "./staging/paid-owner-schema-policy.mjs";
assert.equal(isPaidOwnerQaSchemaTable("auth_accounts"),true);
assert.equal(isPaidOwnerQaSchemaTable("auth_sessions"),false);
assert.equal(isPaidOwnerQaSchemaTable("auth_tokens"),false);
import {build} from "esbuild";
import {mkdtempSync,rmSync} from "node:fs";
import os from "node:os";
import path from "node:path";
import {pathToFileURL} from "node:url";

// Exercise the real deployed-stage Worker entrypoint, not a reimplemented
// regex or a mock authorization function. No Cloudflare or Stripe resources.
const dir=mkdtempSync(path.join(os.tmpdir(),"cove-paid-stage-identity-"));
try{
  const outfile=path.join(dir,"stage.mjs");
  await build({entryPoints:["src/storefront-strangler/paid-settlement-stage-qa.worker.ts"],
    outfile,bundle:true,format:"esm",platform:"node",target:"node22",logLevel:"silent"});
  const {default:worker}=await import(pathToFileURL(outfile).href);
  let dbReads=0,ownerCalls=0;
  const run="40764579032-2";
  const initialOrder="order_initial_qa_"+run;
  const initialBuyer="user_initial_qa_"+run;
  const env={
    COVE_PAID_STAGE_QA_ENABLED:"1",
    COVE_SSR_STAGING:"1",COVE_CANONICAL_LEGAL_WRITE_LOCK:"1",
    COVE_LEGAL_CONSUMER_STAGE_ENABLED:"1",
    COVE_LEGAL_WRITER_PRIMARY_ID:"7c7ab994-f6b3-419d-a72d-71eb9ea22e7e",
    COVE_PAID_STAGE_QA_GATE:"a".repeat(64),
    COVE_RIGHTS_OWNER_SECRET:"b".repeat(64),
    COVE_PAID_STAGE_QA_EXPIRES_AT:String(Date.now()+60000),
    COVE_PAID_INITIAL_ORDER:initialOrder,COVE_PAID_INITIAL_BUYER:initialBuyer,
    LEGAL_PRIVATE:{async fetch(){ownerCalls++;throw Error("unpaid buyer must not invoke owner");}},
    PRIMARY_DB:{prepare(sql){
      assert.match(sql,/SELECT e.id FROM entitlements e/);
      return {bind(...params){
        assert.deepEqual(params.slice(0,2),[initialOrder,initialBuyer]);
        return {async all(){dbReads++;return {results:[]};}};
      }};
    }}
  };
  const probe=async(orderId,userId,scope=env)=>{
    const request=new Request("https://private.stage.invalid/authorize-initial",{
      method:"POST",headers:{"content-type":"application/json",
        authorization:"Bearer "+scope.COVE_PAID_STAGE_QA_GATE},
      body:JSON.stringify({orderId,userId})
    });
    return (await worker.fetch(request,scope)).status;
  };
  assert.equal(await probe(initialOrder,initialBuyer),451,
    "Fresh attempt-scoped unpaid buyer must be denied as unpaid, not rejected as an invalid fixture");
  assert.equal(dbReads,1,"Valid prepayment denial must read the canonical entitlement");
  assert.equal(await probe("order_initial_qa_40764579032", "user_initial_qa_40764579032"),400,
    "Old non-attempt fixture identities must not be accepted");
  assert.equal(await probe("order_initial_qa_40764579032-1",initialBuyer),400,
    "Another run attempt cannot borrow the current buyer scope");
  assert.equal(await probe(initialOrder,"user_initial_qa_40764579032-3"),400,
    "A mismatched buyer must not reach entitlement authorization");
  assert.equal(await probe(initialOrder,initialBuyer,{...env,COVE_PAID_INITIAL_BUYER:"user_initial_qa_40764579032-3"}),400,
    "A mixed deployment config must reject the buyer");
  assert.equal(dbReads,1,"Only the exact scoped unpaid buyer may reach D1");
  assert.equal(ownerCalls,0,"No unpaid or malformed buyer should reach the owner");
  console.log("PASS: real paid QA Worker rejects cross-run/buyer identities and denies attempt-scoped unpaid delivery");
}finally{rmSync(dir,{recursive:true,force:true});}
