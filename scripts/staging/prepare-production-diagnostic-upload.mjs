/* eslint-disable prettier/prettier -- Zero-traffic, canonical version-upload guard. */
/**
 * Prepare exact production persistence config using the EXISTING production
 * workflow's heredoc, not another independently maintained resource list.
 * Upload creates a stored version only; it MUST NOT deploy traffic.
 */
import assert from "node:assert/strict";
import {readFileSync,writeFileSync,mkdirSync} from "node:fs";
import {spawnSync} from "node:child_process";
const ACCOUNT="d26430caa63ec55f6612e32f36aca5e9";
const WORKER="cove-persistence-backend";
const OLD="401f2af2-6e69-4611-8110-1d127af6eecf";
const SOURCE_COMMIT="c959eaed64c58f7d9675c0c8b6852c70f4914dec";
const DB="4bd657ac-8789-403e-a28c-93aba8d0a989";
const BUCKET="cove-production-media";
assert.equal(process.env.CLOUDFLARE_ACCOUNT_ID,ACCOUNT);
assert.match(process.env.GITHUB_RUN_ID||"",/^[0-9]{8,15}$/);
assert.match(process.env.GITHUB_RUN_ATTEMPT||"",/^[1-9][0-9]{0,2}$/);
assert.ok(process.env.CLOUDFLARE_API_TOKEN);
const changed=spawnSync("git",["diff","--name-only",SOURCE_COMMIT,"HEAD","--",
  "src","drizzle","package.json","package-lock.json","scripts/build-persistence-backend.mjs"],{
  encoding:"utf8",timeout:15000
});
assert.equal(changed.status,0,"Cannot verify reviewed source commit");
assert.equal(changed.stdout.trim(),"","Backend source differs from reviewed #714 production context diagnostics");
const workflow=readFileSync(".github/workflows/deploy-persistence-backend.yml","utf8");
const begin="      - name: Write deployment config\n";
const end="      # Worker secrets are owned by Cloudflare.";
assert.equal(workflow.split(begin).length,2);
assert.equal(workflow.split(end).length,2);
const segment=workflow.split(begin)[1].split(end)[0];
const run=segment.split("        run: |\n");
assert.equal(run.length,2);
const shell=run[1].split("\n").map(line=>
  line.startsWith("          ")?line.slice(10):line).join("\n");
assert.match(shell,/cat > wrangler\.backend\.deploy\.toml <<EOF/);
assert.match(shell,/\[\[durable_objects\.bindings\]\]/);
const env={...process.env,WORKER_NAME:WORKER,D1_DATABASE_ID:DB,
  D1_DATABASE_NAME:"cove-production",R2_BUCKET_NAME:BUCKET,
  PUBLIC_URL:"https://cove-puce-theta.vercel.app"};
const executed=spawnSync("bash",["-c",shell],{env,encoding:"utf8",timeout:15000});
assert.equal(executed.status,0,"Original production config generation failed");
const config=readFileSync("wrangler.backend.deploy.toml","utf8");
assert.match(config,/name = "cove-persistence-backend"/);
assert.match(config,/database_id = "4bd657ac-8789-403e-a28c-93aba8d0a989"/);
assert.match(config,/script_name = "cove-legal-authority-production"/);
assert.match(config,/compatibility_date = "2026-09-01"/);
assert.match(config,/dataset = "cove_public_http_ops"/);
assert.match(config,/FORE_ENVIRONMENT = "production"/);
assert.match(config,/keep_vars = true/);
assert.doesNotMatch(config,/cove-qa|staging-route|routes = \[/i);
mkdirSync("artifacts/production-diagnostic-upload",{recursive:true});
async function call(path){
  const r=await fetch("https://api.cloudflare.com/client/v4"+path,{
    headers:{authorization:"Bearer "+process.env.CLOUDFLARE_API_TOKEN},
    signal:AbortSignal.timeout(15000)});
  if(!r.ok)throw Error("Read-only Cloudflare preflight failed "+r.status);
  const j=await r.json();
  assert.equal(j.success,true);
  return j.result;
}
const base="/accounts/"+ACCOUNT+"/workers/scripts/"+WORKER;
const [deployments,current,versions]=await Promise.all([
  call(base+"/deployments"),call(base+"/versions/"+OLD),call(base+"/versions?per_page=20")
]);
const head=deployments.deployments?.[0];
assert.equal(head?.id,"8f386a7f-5be8-4977-bcbf-2307cce75177",
  "Production deployment drift; abort without uploading");
assert.equal(head?.versions?.length,1);
assert.equal(head.versions[0].version_id,OLD);
assert.equal(head.versions[0].percentage,100);
assert.equal(current.number,451);
const bindings=current.resources?.bindings||[];
assert.ok(bindings.some(x=>x.name==="DB"&&x.type==="d1"&&x.database_id===DB));
assert.ok(bindings.some(x=>x.name==="LEGAL_AUTHORITY"&&
  x.type==="durable_object_namespace"&&x.script_name==="cove-legal-authority-production"));
assert.ok(bindings.some(x=>x.name==="OPS_ANALYTICS"&&x.type==="analytics_engine"&&
  x.dataset==="cove_public_http_ops"));
const before={old:OLD,headDeploymentId:head.id,
  versionIds:(versions.items||[]).map(x=>x.id),run:process.env.GITHUB_RUN_ID,
  attempt:process.env.GITHUB_RUN_ATTEMPT,sourceCommit:SOURCE_COMMIT};
writeFileSync("artifacts/production-diagnostic-upload/before.json",JSON.stringify(before),
  {mode:0o600});
console.log(JSON.stringify({event:"cove_production_diagnostic_upload_preflight",
  activeVersion:451,trafficOnBaseline:100,sourceReviewed:true,
  migrationsRun:false,releaseCertified:false}));
