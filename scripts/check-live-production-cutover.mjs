/* eslint-disable prettier/prettier -- Production release boundary: deliberately explicit. */
/**
 * Read-only Cloudflare production topology attestation.
 *
 * This is NOT a deployment, a rights-writer migration, a performance
 * certificate, or a rollback rehearsal. In audit mode it succeeds only when
 * the current deployment remains safely blocked from owner-only public SSR.
 * Release mode must fail closed until separately documented acceptance.
 */
import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {mkdtempSync,readFileSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join,resolve} from "node:path";
import {fileURLToPath} from "node:url";

export const PRODUCTION_D1="4bd657ac-8789-403e-a28c-93aba8d0a989";
export const QA_D1=new Set([
  "5e3a6b69-6f3d-4b19-b837-01f7aa56ce87",
  "7c7ab994-f6b3-419d-a72d-71eb9ea22e7e",
]);
const OWNER_SCRIPT="cove-legal-authority-production";
const OWNER_NAMESPACE="83d7eadf3957436389a7b072120a9829";
const PRIMARY="cove-persistence-backend";

function bindingSummary(settings) {
  return (settings?.bindings||[]).map(b=>({
    name:b.name,type:b.type,
    ...(b.type==="d1"?{id:b.id}:{}),
    ...(b.type==="service"?{service:b.service}:{}),
    ...(b.type==="durable_object_namespace"?{
      script_name:b.script_name,namespace_id:b.namespace_id,class_name:b.class_name}:{}),
  }));
}

export function coversPublicWww(pattern) {
  const host=String(pattern||"").toLowerCase().split("/")[0];
  return ["www.covereads.com","*.covereads.com","*covereads.com"].includes(host);
}

export function assessProductionCutover({
  canonicalCandidates,backend,frontend,owner,routes=[],domains=[],publicOrigin,
}) {
  const failures=[],blocks=[];
  const primary=bindingSummary(backend);
  const db=primary.find(b=>b.name==="DB");
  if(!backend)failures.push("production persistence Worker settings unavailable");
  else if(db?.type!=="d1"||db.id!==PRODUCTION_D1)
    failures.push("production persistence DB must point to the exact production D1");
  for(const [service,settings] of [
    [PRIMARY,backend],["cove",frontend],[OWNER_SCRIPT,owner]
  ]) {
    for(const b of bindingSummary(settings)) {
      if(b.type==="d1"&&QA_D1.has(b.id))
        failures.push(service+": synthetic QA D1 bound to production");
      if((b.name==="LEGAL_AUTHORITY"||b.name==="LEGAL_PRIVATE")&&
        /(?:private-qa|quarantine-qa|paid.*qa)/i.test(b.service||b.script_name||""))
        failures.push(service+": synthetic QA legal owner bound to production");
    }
  }
  const ownerBinding=primary.find(b=>b.name==="LEGAL_AUTHORITY");
  const correctOwner=!!ownerBinding&&(
    ownerBinding.type==="service"&&ownerBinding.service===OWNER_SCRIPT ||
    ownerBinding.type==="durable_object_namespace"&&
      ownerBinding.namespace_id===OWNER_NAMESPACE&&ownerBinding.class_name==="CoveLegalAuthority"&&
      (ownerBinding.script_name===undefined||ownerBinding.script_name===OWNER_SCRIPT)
  );
  if(ownerBinding&&!correctOwner)
    failures.push("LEGAL_AUTHORITY must point to the independently reviewed production owner");
  if(!correctOwner)blocks.push("production persistence LEGAL_AUTHORITY binding is absent or unverified");
  if(!owner)blocks.push("separate production legal-owner Worker is not deployed");
  const ownerEnabled=owner?.bindings?.find(b=>b.name==="COVE_RIGHTS_OWNER_ENABLED")?.text==="1";
  if(!ownerEnabled)blocks.push("production legal owner remains disabled or operational enablement is unverified");
  if(ownerEnabled&&canonicalCandidates>0)
    failures.push("production legal owner enabled before canonical writer migration is certified");
  if(canonicalCandidates!==0)
    blocks.push(canonicalCandidates+" unverified canonical SQL mutation sites");
  const liveWwwRoutes=routes.filter(r=>coversPublicWww(r.pattern));
  const liveWwwDomains=domains.filter(d=>String(d.hostname).toLowerCase()==="www.covereads.com");
  const publicWorkerAttached=liveWwwRoutes.length>0||liveWwwDomains.length>0;
  if(publicWorkerAttached&&canonicalCandidates>0)
    failures.push("unsafe public Cloudflare SSR cutover while canonical writers remain unverified");
  if(publicWorkerAttached&&!correctOwner)
    failures.push("unsafe public Cloudflare SSR cutover without production legal-owner binding");
  if(!publicWorkerAttached)blocks.push("owned public hostname is not routed to Cloudflare SSR Worker");
  if(publicOrigin?.server?.toLowerCase().includes("vercel")||
     publicOrigin?.vercelId)
    blocks.push("public homepage is still served by Vercel");
  else if(!publicOrigin?.server)blocks.push("public homepage origin was not independently identified");
  // A topology check cannot attest Stripe LIVE, purchase/revocation,
  // withdrawal, true 3-round cold, geographic capacity or rollback.
  blocks.push("strict hosted-capacity and geographic certification not independently present");
  blocks.push("production rollback rehearsal not independently present");
  return {safeToMaintainCurrentRoute:failures.length===0,
    certifiedForOwnerOnlyCutover:false,failures,blocks,
    evidence:{
      canonicalCandidates,
      persistenceD1:db?.type==="d1"?db.id:null,
      productionOwnerBound:correctOwner,
      productionOwnerDeployed:!!owner,
      productionOwnerEnabled:ownerEnabled,
      publicWorkerAttached,
      publicRoutePatterns:liveWwwRoutes.map(r=>r.pattern),
      publicDomainServices:liveWwwDomains.map(d=>d.service),
      publicServer:publicOrigin?.server||null,
    }};
}

async function cloudflareGet(path,token,{optional=false}={}) {
  const response=await fetch("https://api.cloudflare.com/client/v4"+path,{
    headers:{authorization:"Bearer "+token,accept:"application/json"},
    signal:AbortSignal.timeout(12000),
  });
  if(optional&&response.status===404)return null;
  if(!response.ok)throw Error("Cloudflare read failed (HTTP "+response.status+") on "+path.split("?")[0]);
  const json=await response.json();
  if(!json.success)throw Error("Cloudflare read returned API failure on "+path.split("?")[0]);
  return json.result;
}

function scanCanonicalWriters() {
  const temp=mkdtempSync(join(tmpdir(),"cove-production-owner-audit-"));
  try {
    const output=join(temp,"canonical-writers.json");
    const child=spawnSync(process.execPath,
      ["scripts/check-canonical-writer-closure.mjs","--audit"],{
        cwd:resolve(fileURLToPath(new URL("..",import.meta.url))),
        env:{...process.env,COVE_WRITER_AUDIT_OUTPUT:output},
        encoding:"utf8",timeout:30000,
      });
    if(child.error||child.status!==0)
      throw Error("Canonical source audit did not complete");
    const result=JSON.parse(readFileSync(output,"utf8"));
    assert.equal(result.staticScanOnly,true);
    assert.ok(Number.isSafeInteger(result.unresolvedDirectWrites));
    return result.unresolvedDirectWrites;
  } finally {rmSync(temp,{force:true,recursive:true});}
}

async function main() {
  const auditOnly=process.argv.includes("--audit");
  const release=process.argv.includes("--release-gate");
  if(auditOnly===release)throw Error("Specify exactly one of --audit or --release-gate");
  const token=process.env.CLOUDFLARE_API_TOKEN;
  const account=process.env.CLOUDFLARE_ACCOUNT_ID;
  const zone=process.env.CLOUDFLARE_ZONE_ID;
  if(!token||!/^[a-f0-9]{32}$/.test(account||"")||
     !/^[a-f0-9]{32}$/.test(zone||""))
    throw Error("Cloudflare API token and exact account/zone IDs are required");
  const base="/accounts/"+account;
  const [backend,frontend,owner,routes,domains]=await Promise.all([
    cloudflareGet(base+"/workers/scripts/"+PRIMARY+"/settings",token),
    cloudflareGet(base+"/workers/scripts/cove/settings",token,{optional:true}),
    cloudflareGet(base+"/workers/scripts/"+OWNER_SCRIPT+"/settings",token,{optional:true}),
    cloudflareGet("/zones/"+zone+"/workers/routes",token),
    cloudflareGet(base+"/workers/domains",token),
  ]);
  let publicOrigin=null;
  try {
    const response=await fetch("https://www.covereads.com/",{
      method:"HEAD",redirect:"follow",signal:AbortSignal.timeout(10000),
    });
    publicOrigin={server:response.headers.get("server"),
      vercelId:!!response.headers.get("x-vercel-id")};
  }catch{publicOrigin={server:null};}
  const result=assessProductionCutover({
    canonicalCandidates:scanCanonicalWriters(),backend,frontend,owner,
    routes,domains,publicOrigin,
  });
  console.log(JSON.stringify({schema:"cove.production-cutover-topology.v1",
    checkedAt:new Date().toISOString(),mode:release?"release-gate":"audit",...result},null,2));
  if(result.failures.length)process.exitCode=1;
  if(release){
    console.error("BLOCKED: topology alone never certifies production owner-first migration, strict geographically repeatable SSR capacity and rollback.");
    process.exitCode=1;
  }
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))
  main().catch(e=>{console.error("BLOCKED: "+e.message);process.exitCode=1;});

