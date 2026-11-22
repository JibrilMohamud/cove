/* eslint-disable prettier/prettier -- Isolated legal QA must never obtain production D1 SQL authority. */
import assert from "node:assert/strict";
import {QA_ACCOUNT,PRODUCTION_D1} from "./paid-qa-cloudflare-credentials.mjs";
const QA_DB="5e3a6b69-6f3d-4b19-b837-01f7aa56ce87";
export function checkedPrivateLegalQaCredentials(env){
  assert.equal(env?.CLOUDFLARE_ACCOUNT_ID,QA_ACCOUNT);
  assert.match(String(env?.GITHUB_RUN_ID||""),/^\d{8,15}$/);
  const workers=env?.CLOUDFLARE_API_TOKEN,
    metadata=env?.COVE_CF_WORKERS_METADATA_READ_TOKEN;
  assert.ok([workers,metadata].every(x=>typeof x==="string"&&x.length>=20),
    "Private legal QA requires independent Workers and metadata credentials");
  assert.equal(new Set([workers,metadata]).size,2,
    "Private legal QA credential reuse is forbidden");
  return {workers,metadata,run:env.GITHUB_RUN_ID};
}
export function legalQaTokenFor(method,path,c){
  if(typeof path!=="string"||path.includes("..")||path.includes("?"))
    throw Error("legal_qa_path_not_reviewed");
  const root="/accounts/"+QA_ACCOUNT;
  
  if(path.startsWith(root+"/d1/")||path.includes(PRODUCTION_D1))
    throw Error("legal_qa_direct_d1_forbidden_use_synthetic_gateway");
  const prefix=root+"/workers/scripts";
  if(path===prefix&&method==="GET")return c.workers;
  if(!path.startsWith(prefix+"/"))throw Error("legal_qa_resource_not_reviewed");
  const tail=path.slice(prefix.length+1);
  const segments=tail.split("/");
  const worker=segments[0],suffix=segments.slice(1).join("/");
  const allowed=new Set(["cove-legal-authority-private-qa-example","cove-legal-quarantine-qa-private","cove-private-legal-proof-"+c.run,"cove-legal-d1-gateway-"+c.run]);
  if(!allowed.has(worker))throw Error("legal_qa_worker_not_reviewed");
  if(method==="GET"&&suffix==="settings")return c.metadata;
  if(method==="GET"&&["","subdomain","deployments"].includes(suffix))return c.workers;
  if(method==="POST"&&["subdomain","deployments"].includes(suffix))return c.workers;
  if(method==="DELETE"&&suffix==="")return c.workers;
  if(method==="PUT"&&/^secrets\/[A-Z0-9_]{4,120}$/.test(suffix))return c.workers;
  throw Error("legal_qa_verb_not_reviewed");
}
