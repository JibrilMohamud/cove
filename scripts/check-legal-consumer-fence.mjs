/* eslint-disable prettier/prettier -- This test proves a missing owner cannot grant reading or payment. */
import assert from "node:assert/strict";
import {build} from "esbuild";
import {mkdtempSync,rmSync} from "node:fs";
import path from "node:path";
import os from "node:os";
import {pathToFileURL} from "node:url";

const dir=mkdtempSync(path.join(os.tmpdir(),"cove-owner-consumer-"));
try{
  const bundle=path.join(dir,"consumer.mjs");
  await build({entryPoints:["src/storefront-strangler/legal-consumer-fence.server.ts"],
    outfile:bundle,bundle:true,platform:"node",format:"esm",target:"node22",
    logLevel:"silent"});
  const {requireStageLegalConsumerProof}=await import(pathToFileURL(bundle).href);
  const input={id:"prd_gutenberg_2701",source_name:"gutenberg",source_external_id:"2701"};
  const config={
    COVE_SSR_STAGING:"1",COVE_CANONICAL_LEGAL_WRITE_LOCK:"1",
    COVE_LEGAL_CONSUMER_STAGE_ENABLED:"1",
    COVE_LEGAL_WRITER_PRIMARY_ID:"5e3a6b69-6f3d-4b19-b837-01f7aa56ce87",
    COVE_RIGHTS_OWNER_SECRET:"e".repeat(64)
  };
  let calls=0;
  const owner={getByName(name){
    assert.equal(name,"cove-staged-legal-global-v1");
    return {async fetch(request){
      calls++;
      assert.equal(request.headers.get("authorization"),"Bearer "+"e".repeat(64));
      const command=await request.json();
      assert.deepEqual(command,{ids:["prd_gutenberg_2701"],territory:"US",currency:"USD"});
      return Response.json({schema:"cove.legal-authorized.v1",rows:[{
        product_id:"prd_gutenberg_2701",
        edition_id:"ed_gutenberg_2701",
        offer_json:JSON.stringify({type:"public-domain",currency:"USD",amountMinor:0})
      }]});
    }};
  }};
  const active={...config,LEGAL_AUTHORITY:owner};
  await requireStageLegalConsumerProof({},[{id:"paid",source_name:"commercial"}],"US","USD");
  assert.equal(calls,0,"Existing production code never contacts experimental QA owner");
  await requireStageLegalConsumerProof(active,[input],"US","USD");
  assert.equal(calls,1);
  await assert.rejects(
    requireStageLegalConsumerProof(active,[{id:"prd_001",source_name:"commercial"}],"US","USD"),
    e=>e.status===503);
  assert.equal(calls,1,"Paid product must NOT be certified by a free owner");
  await assert.rejects(requireStageLegalConsumerProof(
    {...active,COVE_CANONICAL_LEGAL_WRITE_LOCK:"0"},[input],"US","USD"),
    e=>e.status===503);
  await assert.rejects(requireStageLegalConsumerProof(
    {...active,COVE_SSR_STAGING:"0"},[input],"US","USD"),
    e=>e.status===503);
  await assert.rejects(requireStageLegalConsumerProof(
    {...active,COVE_LEGAL_WRITER_PRIMARY_ID:"4bd657ac-8789-403e-a28c-93aba8d0a989"},
    [input],"US","USD"),e=>e.status===503);
  const denied={getByName:()=>({async fetch(){
    return Response.json({schema:"cove.legal-authorized.v1",rows:[]});
  }})};
  await assert.rejects(
    requireStageLegalConsumerProof({...active,LEGAL_AUTHORITY:denied},[input],"US","USD"),
    e=>e.status===451);
  await assert.rejects(
    requireStageLegalConsumerProof({...active,LEGAL_AUTHORITY:{getByName:()=>({
      async fetch(){throw Error("owner_unreachable");}
    })}},[input],"US","USD"),e=>e.status===503);
  const forged={getByName:()=>({async fetch(){
    return Response.json({schema:"cove.legal-authorized.v1",rows:[{
      product_id:"prd_gutenberg_2701",edition_id:"ed_gutenberg_2701",
      offer_json:JSON.stringify({type:"public-domain",currency:"USD",amountMinor:999})
    }]});
  }})};
  await assert.rejects(
    requireStageLegalConsumerProof({...active,LEGAL_AUTHORITY:forged},[input],"US","USD"),
    e=>e.status===503);
  const wrongEdition={getByName:()=>({async fetch(){
    return Response.json({schema:"cove.legal-authorized.v1",rows:[{
      product_id:"prd_gutenberg_2701",edition_id:"ed_gutenberg_9999",
      offer_json:JSON.stringify({type:"public-domain",currency:"USD",amountMinor:0})
    }]});
  }})};
  await assert.rejects(
    requireStageLegalConsumerProof({...active,LEGAL_AUTHORITY:wrongEdition},[input],"US","USD"),
    e=>e.status===503);
  await requireStageLegalConsumerProof(active,[
    {id:"upload_8abced12",source_name:"upload"}],"US","USD");
  assert.equal(calls,1,"Personal imports never use public catalog rights grants");
  console.log("PASS: staging book/detail, checkout and protected license consumer fence uses exact owner proof, denies paid, withdrawn, forged, wrong-market and unavailable owner");
}finally{rmSync(dir,{recursive:true,force:true});}
