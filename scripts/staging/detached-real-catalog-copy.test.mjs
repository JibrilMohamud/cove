/* eslint-disable prettier/prettier -- Detached catalog transfer boundary. */
import assert from "node:assert/strict";
import {test} from "node:test";
import {readFileSync} from "node:fs";
import * as legacy from "./real-catalog-copy-plan.mjs";
import * as detached from "./detached-real-catalog-copy-plan.mjs";
import worker from "./detached-real-catalog-copy.worker.mjs";
import {verifyReceipt} from "./detached-real-catalog-copy-receipt.mjs";
test("same reviewed public projection, distinct provider account and immutable database",()=>{
  assert.equal(detached.plan,legacy.plan);assert.equal(detached.source,legacy.source);
  assert.equal(detached.sourceAccount,legacy.account);assert.notEqual(detached.account,legacy.account);
  assert.notEqual(detached.target,legacy.target);assert.notEqual(detached.target,detached.source);
  const config=JSON.parse(readFileSync("wrangler.detached-real-catalog-snapshot.jsonc","utf8"));
  assert.equal(config.account_id,detached.account);
  assert.deepEqual(config.d1_databases,[{binding:"SNAPSHOT",database_id:detached.target,database_name:detached.targetName,migrations_dir:"drizzle"}]);
});
test("detached importer refuses old target and primary before SQL",async()=>{
  const gate="a".repeat(64);
  const request=()=>new Request("https://fixture.invalid/copy",{method:"POST",headers:{authorization:"Bearer "+gate},body:JSON.stringify({operation:"probe"})});
  const env={GATE:gate,TARGET:detached.target,RUN:"12345678-1",EXPIRES:String(Date.now()+60000),SNAPSHOT:{prepare(){throw Error("unexpected SQL");}}};
  assert.equal((await worker.fetch(request(),env)).status,204);
  for(const TARGET of [legacy.target,legacy.source])assert.equal((await worker.fetch(request(),{...env,TARGET})).status,403);
});
test("legacy snapshot receipt does not certify detached transfer",()=>{
  const digest="a".repeat(64),sha="b".repeat(40);
  const receipt={run_id:"12345678",run_attempt:"1",sha,manifest_digest:"c".repeat(64),transfer_digest:digest,products:82247,editions:82247};
  const run={id:12345678,run_attempt:1,path:".github/workflows/provision-detached-real-catalog-snapshot.yml",head_sha:sha,event:"workflow_dispatch",head_branch:"main",conclusion:"success"};
  const job={name:"populate-isolated-snapshot",conclusion:"success",steps:[{name:"Remove isolated importer even if interrupted",conclusion:"success"}]};
  assert.equal(verifyReceipt(receipt,run,[job],digest),true);
  assert.throws(()=>verifyReceipt(receipt,{...run,path:".github/workflows/provision-real-catalog-snapshot.yml"},[job],digest));
});
