/* eslint-disable prettier/prettier -- Legal QA must run only in the distinct Cove QA account, never with a production bearer. */
import assert from "node:assert/strict";
import {QA_ACCOUNT,QA_LEGAL_D1,PRODUCTION_ACCOUNT,PRODUCTION_D1} from "./paid-qa-cloudflare-credentials.mjs";

export function checkedPrivateLegalQaCredentials(env){
  assert.notEqual(QA_ACCOUNT,PRODUCTION_ACCOUNT);
  assert.notEqual(QA_LEGAL_D1,PRODUCTION_D1);
  assert.equal(env?.CLOUDFLARE_ACCOUNT_ID,QA_ACCOUNT,
    "Private legal-owner QA requires the independent Cloudflare account");
  assert.match(String(env?.GITHUB_RUN_ID||""),/^\d{8,15}$/);
  const workers=env?.COVE_CF_QA_WORKERS_DEPLOY_TOKEN;
  assert.ok(typeof workers==="string"&&workers.length>=20,
    "Private legal QA needs a dedicated QA-only Worker deployment token");
  assert.equal(env?.CLOUDFLARE_API_TOKEN,workers,
    "Wrangler must use exactly the scoped QA Worker credential, not broad production token");
  assert.equal(env?.COVE_CF_QA_D1_MUTATION_TOKEN,undefined,
    "Legal QA must access D1 only through signed temporary Worker binding");
  return {workers,run:env.GITHUB_RUN_ID};
}
export function legalQaTokenFor(method,path,c){
  if(typeof path!=="string"||path.includes("..")||path.includes("?")||
     path.includes(PRODUCTION_D1))
    throw Error("legal_qa_path_not_reviewed");
  const root="/accounts/"+QA_ACCOUNT;
  if(path.startsWith(root+"/d1/"))throw Error("legal_qa_direct_d1_forbidden_use_synthetic_gateway");
  const prefix=root+"/workers/scripts";
  if(path===prefix&&method==="GET")return c.workers;
  if(!path.startsWith(prefix+"/"))throw Error("legal_qa_resource_not_reviewed");
  const tail=path.slice(prefix.length+1);
  const segments=tail.split("/");
  const worker=segments[0],suffix=segments.slice(1).join("/");
  const allowed=new Set(["cove-legal-authority-private-qa-example",
    "cove-legal-quarantine-qa-private","cove-private-legal-proof-"+c.run,
    "cove-legal-d1-gateway-"+c.run]);
  if(!allowed.has(worker))throw Error("legal_qa_worker_not_reviewed");
  if(method==="GET"&&["","settings","subdomain","deployments"].includes(suffix))return c.workers;
  if(method==="POST"&&["subdomain","deployments"].includes(suffix))return c.workers;
  if(method==="DELETE"&&suffix==="")return c.workers;
  if(method==="PUT"&&/^secrets\/[A-Z0-9_]{4,120}$/.test(suffix))return c.workers;
  throw Error("legal_qa_verb_not_reviewed");
}
