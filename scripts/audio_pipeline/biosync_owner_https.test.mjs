/* eslint-disable prettier/prettier -- fixed request and response fixtures */
import {test} from "node:test";
import assert from "node:assert/strict";
import {endpoint,sendOwner,commitOwner,refusalCode} from "./biosync_owner_https.mjs";
const payload={editionId:"pg-19504",trackId:"02",jobId:"align-pg-19504-02-7fb5b7e4c4a400b1",mapSha256:"a".repeat(64)};
const token="b".repeat(64),headers={"cache-control":"no-store","x-content-type-options":"nosniff"};
const receipt={...payload,schema:"cove.owner-biosync-checked-publication.v1",committed:true,replay:true};
test("publisher and activation use identical fixed Node HTTP boundary; no redirect or retry",async()=>{
  let calls=0;
  const result=await commitOwner(payload,token,async(url,opts)=>{
    calls++;assert.equal(url,endpoint);assert.equal(opts.method,"POST");assert.equal(opts.redirect,"error");
    assert.equal(opts.headers.authorization,"Bearer "+token);assert.deepEqual(JSON.parse(opts.body),payload);
    return Response.json(receipt,{headers});
  });
  assert.deepEqual(result,receipt);assert.equal(calls,1);
  await assert.rejects(sendOwner({...payload,sql:"DELETE"},token,async()=>{throw Error("must not call");}),/invalid_command/);
});
test("edge 403 and application 403 distinguishable without leaking response",async()=>{
  for(const [h,code] of [[{},"edge_or_transport"],[{"cf-mitigated":"challenge"},"edge_challenge"],[headers,"application"]]){
    let calls=0;
    await assert.rejects(commitOwner(payload,token,async()=>{calls++;return new Response("private provider body",{status:403,headers:h});}),new RegExp("biosync_owner_"+code+"_http_403"));
    assert.equal(calls,1);
  }
  assert.equal(refusalCode(new Response(null,{status:503,headers})),"biosync_owner_application_http_503");
});
test("rejects mismatched or unbounded receipts and no-store violations",async()=>{
  await assert.rejects(commitOwner(payload,token,async()=>Response.json({...receipt,trackId:"wrong"},{headers})),/receipt_mismatch/);
  await assert.rejects(commitOwner(payload,token,async()=>new Response("x".repeat(4097),{headers})),/receipt_bound/);
  await assert.rejects(commitOwner(payload,token,async()=>Response.json(receipt)),/edge_or_transport_http_200/);
});
