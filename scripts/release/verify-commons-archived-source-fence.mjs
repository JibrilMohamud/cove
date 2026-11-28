/* eslint-disable prettier/prettier -- Fail-closed read-only provider authorization fence. */
import {pathToFileURL} from "node:url";
import {createPhysicalWriterReadTransport} from "./physical-d1-writer-read-transport.mjs";
import {inspectUserTokenEvidence} from "./certify-exclusive-primary-d1.mjs";
import {inspectSinglePrincipalCoverage} from "./single-principal-coverage.mjs";

const ACCOUNT="d26430caa63ec55f6612e32f36aca5e9";
const BROAD="1c79fb61dbad11f320c96f6a03413e84";
const accountResource="com.cloudflare.api.account."+ACCOUNT;
const safeBuckets=new Set(["cove-production-media","strife-stage-delivery","strife-stage-source"]
  .map(name=>"com.cloudflare.edge.r2.bucket."+ACCOUNT+"_default_"+name));
const readGroups=new Map([
  ["192192df92ee43ac90f2aeeffce67e35","D1 Read"],
  ["eb56a6953c034b9d97dd838155666f06","Account API Tokens Read"],
  ["c1fde68c7bcc44588cbb6ddbc16d6480","Account Settings Read"],
  ["b4992e1108244f5d8bfbd5744320c2e1","Workers R2 Storage Read"],
  ["1a71c399035b4950a1bd1466bbe4f420","Workers Scripts Read"],
  ["da1261c3d38544a4bba805b22566f8b6","Workers Metadata Read-Only"],
  ["1b68681d11f443a4979c6d08c3211f13","Individual Workers Content Read-Only"],
]);
// The immutable orphan only issues direct D1 REST and R2 object calls.
// These two reviewed deployment grants cannot authorize those calls. They
// are NOT safe for the separate physical primary writer-exclusivity gate.
const directRestExcludedDeployGroups=new Map([
  ["e086da7e2179491d91ee5f35b3ca210a","Workers Scripts Write"],
  ["7e79ec33834341f28dd431ab73884400","Individual Workers Editor"],
]);
const ID=/^[a-f0-9]{32}$/;
function require(ok,code){if(!ok)throw Error(code);}
function completePage(payload){
  const rows=payload?.result,info=payload?.result_info;
  require(payload?.success===true&&Array.isArray(rows)&&info?.page===1&&
    info.count===rows.length&&info.total_count===rows.length&&
    (info.total_pages===undefined||info.total_pages===1)&&rows.length>0,
    "commons_token_inventory_incomplete");
  const seen=new Set();
  for(const row of rows){
    require(ID.test(row?.id||"")&&!seen.has(row.id)&&
      ["active","disabled","expired","revoked"].includes(row.status),"commons_token_identity_invalid");
    seen.add(row.id);
  }
  return rows;
}
export function assertArchivedSourceAccountFence(payload){
  const rows=completePage(payload);
  for(const token of rows){
    if(token.status==="revoked"||token.status==="expired")continue;
    // A disabled credential can be re-enabled; do not treat it as revoked.
    require(token.id!==BROAD&&token.name!=="Cove GitHub Deployments","commons_broad_token_not_revoked");
    require(token.status==="active"&&Array.isArray(token.policies)&&token.policies.length>0,
      "commons_token_policy_unknown");
    for(const p of token.policies){
      require(p?.effect==="allow"&&p.resources&&typeof p.resources==="object"&&
        !Array.isArray(p.resources)&&Object.keys(p.resources).length>0&&
        Array.isArray(p.permission_groups)&&p.permission_groups.length>0,"commons_token_policy_unknown");
      for(const g of p.permission_groups){
        if(readGroups.get(g?.id)===g?.name&&readGroups.has(g.id))continue;
        if(directRestExcludedDeployGroups.get(g?.id)===g?.name&&
          directRestExcludedDeployGroups.has(g.id))continue;
        if(g?.id==="2efd5506f9c8494dacb1fa10a3e7d5b6"&&g.name==="Workers R2 Storage Bucket Item Write"){
          require(Object.entries(p.resources).every(([k,v])=>safeBuckets.has(k)&&v==="*"),
            "commons_archived_bucket_write_grant");
          continue;
        }
        throw Error("commons_unreviewed_direct_write_grant");
      }
    }
  }
  return true;
}
export async function verifyFence(get,accountToken,userToken){
  require(typeof accountToken==="string"&&accountToken.length>=20&&
    typeof userToken==="string"&&userToken.length>=20&&accountToken!==userToken,
    "commons_distinct_audit_tokens_required");
  const read=()=>get("/accounts/"+ACCOUNT+"/tokens",accountToken);
  assertArchivedSourceAccountFence(await read());
  const coverage=await inspectSinglePrincipalCoverage(get,accountToken,userToken);
  require(coverage.verified===true,"commons_user_principal_coverage_unverified");
  const user=await inspectUserTokenEvidence(get,userToken);
  require(user.verified===true,"commons_user_token_write_fence_unverified");
  assertArchivedSourceAccountFence(await read());
  return true;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  try{
    const {get}=createPhysicalWriterReadTransport();
    await verifyFence(get,process.env.COVE_CF_ACCOUNT_TOKEN_INVENTORY_READ_TOKEN,
      process.env.COVE_CF_USER_TOKENS_AUDIT_READ_TOKEN);
    console.log("COMMONS_ARCHIVED_SOURCE_FENCED");
  }catch{
    console.error("COMMONS_ARCHIVED_SOURCE_FENCE_UNVERIFIED");
    process.exitCode=1;
  }
}
