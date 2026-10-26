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
  // A commercial sale needs an independent paid grant proof, never a
  // Gutenberg public-domain substitute.
  let paidCalls=0;
  const paidOwner={getByName(name){
    assert.equal(name,"cove-staged-legal-global-v1");
    return {async fetch(request){
      paidCalls++;
      assert.equal(new URL(request.url).pathname,"/commercial/authorize-batch");
      const body=await request.json();
      assert.deepEqual(body,{ids:["prd_commercial_a17"],territory:"US",channel:"retail"});
      return Response.json({schema:"cove.commercial-legal.v1",rows:[{
        product_id:"prd_commercial_a17",edition_id:"ed_commercial_a17",
        grant_id:"right_valid_17",contract_id:"rcontract_17",
        contract_version_id:"rcv_17",
        valid_until:new Date(Date.now()+100000).toISOString(),epoch:3
      }]});
    }};
  }};
  await requireStageLegalConsumerProof(
    {...active,LEGAL_AUTHORITY:paidOwner},
    [{id:"prd_commercial_a17",source_name:"commercial"}],"US","USD");
  assert.equal(paidCalls,1,"Paid proof is independently obtained from commercial owner");
  await requireStageLegalConsumerProof({...active,LEGAL_AUTHORITY:paidOwner},[{
    id:"prd_commercial_a17",source_name:"commercial",
    expectedEditionId:"ed_commercial_a17",
    expectedGrantId:"right_valid_17",
    expectedContractVersionId:"rcv_17",
  }],"US","USD");
  assert.equal(paidCalls,2);
  await assert.rejects(requireStageLegalConsumerProof({...active,LEGAL_AUTHORITY:paidOwner},[{
    id:"prd_commercial_a17",source_name:"commercial",
    expectedEditionId:"ed_commercial_a17",
    expectedGrantId:"right_revoked_11",
    expectedContractVersionId:"rcv_17",
  }],"US","USD"),e=>e.status===503,
    "Stale canonical pricing cannot borrow a newer grant's owner proof");
  await assert.rejects(requireStageLegalConsumerProof({...active,LEGAL_AUTHORITY:paidOwner},[{
    id:"prd_commercial_a17",source_name:"commercial",
    expectedEditionId:"ed_commercial_a17",
    expectedGrantId:"right_valid_17",
    expectedContractVersionId:"rcv_older",
  }],"US","USD"),e=>e.status===503,
    "Changed contract version invalidates old pricing decisions");

  assert.equal(calls,1,"Paid product must NEVER be certified by free owner");
  await assert.rejects(
    requireStageLegalConsumerProof(active,[{id:"prd_commercial_a17",source_name:"commercial"}],"US","USD"),
    e=>e.status===503,"Wrong proof response schema from the free owner fails closed");
  assert.equal(calls,2);
  const commercialDenied={getByName:()=>({async fetch(){
    return Response.json({schema:"cove.commercial-legal.v1",rows:[]});
  }})};
  await assert.rejects(requireStageLegalConsumerProof(
    {...active,LEGAL_AUTHORITY:commercialDenied},
    [{id:"prd_commercial_a17",source_name:"commercial"}],"US","USD"),
    e=>e.status===451,"A withdrawn paid grant must block purchase");
  const commercialForged={getByName:()=>({async fetch(){
    return Response.json({schema:"cove.commercial-legal.v1",rows:[{
      product_id:"prd_commercial_a17",edition_id:"ed_commercial_a17",
      grant_id:"right_valid_17",contract_id:"rcontract_17",
      contract_version_id:"rcv_17",
      valid_until:new Date(Date.now()-100).toISOString(),epoch:3
    }]});
  }})};
  await assert.rejects(requireStageLegalConsumerProof(
    {...active,LEGAL_AUTHORITY:commercialForged},
    [{id:"prd_commercial_a17",source_name:"commercial"}],"US","USD"),
    e=>e.status===503,"Expired owner proof cannot issue new delivery grants");

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
  assert.equal(calls,2,"Personal imports never issue additional public catalog rights requests");
  console.log("PASS: staging book/detail, checkout and protected license consumer fence uses exact owner proof, denies paid, withdrawn, forged, wrong-market and unavailable owner");
}finally{rmSync(dir,{recursive:true,force:true});}
