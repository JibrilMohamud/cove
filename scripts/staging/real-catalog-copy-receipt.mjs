/* eslint-disable prettier/prettier -- Verify receipt against the successful protected Actions execution. */
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {readFileSync} from "node:fs";
import {account,target,targetName} from "./real-catalog-copy-plan.mjs";
export function transferDigest(){
  const digest=createHash("sha256");
  for(const f of ["real-catalog-copy-plan.mjs","real-catalog-copy.worker.mjs","real-catalog-copy.mjs","real-catalog-copy-budget.mjs","real-catalog-copy-resume.mjs"])digest.update(readFileSync("scripts/staging/"+f));
  return digest.digest("hex");
}
export function verifyReceipt(receipt,run,jobs,digest){
  assert.ok(receipt&&/^[1-9][0-9]{7,14}$/.test(receipt.run_id)&&/^[1-9][0-9]{0,3}$/.test(receipt.run_attempt),"No complete isolated catalog copy receipt");
  assert.match(receipt.sha,/^[a-f0-9]{40}$/);
  assert.match(receipt.manifest_digest,/^[a-f0-9]{64}$/);
  assert.equal(receipt.transfer_digest,digest,"Copy implementation changed; refresh the protected snapshot");
  assert.ok(Number.isSafeInteger(receipt.products)&&receipt.products>=82247&&receipt.editions===receipt.products);
  assert.equal(String(run.id),receipt.run_id);assert.equal(String(run.run_attempt),receipt.run_attempt);
  assert.equal(run.path,".github/workflows/provision-real-catalog-snapshot.yml");
  assert.equal(run.head_sha,receipt.sha);assert.equal(run.event,"workflow_dispatch");assert.equal(run.head_branch,"main");
  assert.equal(run.conclusion,"success");
  const completed=jobs.filter(x=>x.name==="populate-isolated-snapshot");
  assert.equal(completed.length,1);assert.equal(completed[0].conclusion,"success");
  assert.ok(completed[0].steps.some(x=>x.name==="Remove isolated importer even if interrupted"&&x.conclusion==="success"));
  return true;
}
export async function verifyHostedCatalogCopy(){
  assert.equal(process.env.COVE_REAL_CATALOG_SNAPSHOT_D1_ID,target);
  assert.equal(process.env.COVE_REAL_CATALOG_SNAPSHOT_D1_NAME,targetName);
  const read=process.env.COVE_CF_STAGE_DATA_PLANE_READ_TOKEN||"";
  const github=process.env.GH_TOKEN||"";
  assert.ok(read.length>=20&&github.length>=20);
  const response=await fetch("https://api.cloudflare.com/client/v4/accounts/"+account+"/d1/database/"+target+"/query",{method:"POST",headers:{authorization:"Bearer "+read,"content-type":"application/json"},body:JSON.stringify({sql:"SELECT * FROM cove_snapshot_copy_receipt WHERE singleton=1"}),redirect:"error",signal:AbortSignal.timeout(30000)});
  const data=await response.json();assert.ok(response.ok&&data.success&&data.result.length===1);
  const result=data.result[0];assert.equal(result.meta.changed_db,false);assert.equal(result.meta.changes,0);
  assert.equal(result.results.length,1,"Complete protected snapshot receipt is absent");
  const receipt=result.results[0];assert.match(receipt.run_id,/^[1-9][0-9]{7,14}$/);
  async function get(suffix){
    const r=await fetch("https://api.github.com/repos/JibrilMohamud/cove/actions/runs/"+receipt.run_id+suffix,{headers:{authorization:"Bearer "+github,accept:"application/vnd.github+json"},redirect:"error",signal:AbortSignal.timeout(30000)});
    assert.ok(r.ok,"Protected copy run evidence unavailable: "+r.status);return r.json();
  }
  const run=await get("");const resultJobs=await get("/jobs?filter=latest&per_page=100");
  assert.equal(resultJobs.total_count,resultJobs.jobs.length);
  verifyReceipt(receipt,run,resultJobs.jobs,transferDigest());
  console.log("PASS: verified successful protected catalog copy and importer cleanup; independent legal generation not certified.");
}
if(process.argv.includes("--verify"))await verifyHostedCatalogCopy();
