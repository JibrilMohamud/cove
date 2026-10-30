/* eslint-disable prettier/prettier -- Live mode is owner-only; replay and journal guarantees are asserted in the private owner test. */
import assert from "node:assert/strict";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {pathToFileURL} from "node:url";
import {build} from "esbuild";
import "./check-owner-stripe-webhook.mjs";

const temp=mkdtempSync(join(tmpdir(),"cove-private-stripe-webhook-"));
try {
  const outfile=join(temp,"commerce.mjs");
  await build({entryPoints:["src/features/fore/commerce.server.ts"],outfile,bundle:true,
    platform:"node",format:"esm",target:"node22",logLevel:"silent"});
  const {stripeWebhook}=await import(pathToFileURL(outfile).href);
  let d1Calls=0;
  const DB={prepare(){d1Calls++;throw Error("legacy_d1_execution");}};
  const req=new Request("https://cove.test/stripe/webhook",{
    method:"POST",headers:{"stripe-signature":"t=1,v1=fake"},
    body:JSON.stringify({id:"evt_denied",type:"payment_intent.succeeded",livemode:true})});
  for(const flag of [undefined,"0","false","enabled"]){
    const env={DB,COVE_LEGAL_CONSUMER_STAGE_ENABLED:flag,STRIPE_WEBHOOK_SECRET:"whsec_fixture"};
    await assert.rejects(()=>stripeWebhook(env,req),e=>e.status===503&&/private commerce owner/.test(e.message));
  }
  assert.equal(d1Calls,0,"Production-disabled webhook must not claim, settle or modify any D1 row");
  console.log("PASS: signed webhook journal replay is private-owner tested; unenrolled public webhook denies before any D1 or Stripe financial side effect");
}finally {rmSync(temp,{recursive:true,force:true});}
