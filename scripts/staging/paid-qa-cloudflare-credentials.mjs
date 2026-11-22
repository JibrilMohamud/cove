/* eslint-disable prettier/prettier -- Closed-path QA controls must not route production D1 through CI. */
import assert from "node:assert/strict";

export const QA_ACCOUNT="d26430caa63ec55f6612e32f36aca5e9";
export const QA_PAID_D1="7c7ab994-f6b3-419d-a72d-71eb9ea22e7e";
export const QA_SCHEMA_SOURCE_D1="e4cbb0ef-6288-4fa1-9dbb-fb42fe01d4f3";
export const PRODUCTION_D1="4bd657ac-8789-403e-a28c-93aba8d0a989";
const RUN=/^\d{8,15}-\d{1,5}$/;
const QA_WORKER=/^\/workers\/scripts\/(?:cove-paid-legal-owner|cove-paid-legal-writer|cove-paid-legal-caller|cove-paid-settlement-qa)-(\d{8,15}-\d{1,5})(?:\/(settings|deployments|subdomain|versions\/[a-f0-9-]{36}))?$/;

export function checkedPaidQaCredentials(env) {
  assert.equal(env?.CLOUDFLARE_ACCOUNT_ID,QA_ACCOUNT,
    "Paid QA refuses an unreviewed Cloudflare account");
  const run=String(env?.GITHUB_RUN_ID||"")+"-"+String(env?.GITHUB_RUN_ATTEMPT||"1");
  assert.match(run,RUN);
  const tokens={
    workers:env?.CLOUDFLARE_API_TOKEN,
    d1:env?.COVE_CF_PAID_QA_D1_WRITE_TOKEN,
    r2:env?.COVE_CF_PAID_QA_R2_WRITE_TOKEN,
    metadata:env?.COVE_CF_WORKERS_METADATA_READ_TOKEN,
  };
  assert.ok(Object.values(tokens).every(x=>typeof x==="string"&&x.length>=20),
    "Missing distinct scoped synthetic-D1, R2, Workers or metadata QA credential");
  assert.equal(new Set(Object.values(tokens)).size,4,
    "Private paid QA must use distinct Cloudflare principals");
  return {run,tokens};
}
export function paidQaApiTokenFor(method,resource,credentials) {
  if(typeof resource!=="string" || resource.includes("?") ||
     resource.includes("#") || resource.includes(".."))
    throw Error("paid_qa_unreviewed_control_plane_path");
  const base="/d1/database/";
  if(resource===base+QA_PAID_D1+"/query" && method==="POST")return credentials.tokens.d1;
  if(resource===base+QA_SCHEMA_SOURCE_D1+"/query" && method==="POST")return credentials.tokens.d1;
  if(resource.includes(PRODUCTION_D1) || resource.startsWith(base))
    throw Error("paid_qa_rejects_unreviewed_d1");
  const match=QA_WORKER.exec(resource);
  if(!match || match[1]!==credentials.run)
    throw Error("paid_qa_rejects_unreviewed_worker");
  const section=match[2]||"";
  if(method==="GET"&&section==="settings")return credentials.tokens.metadata;
  if(method==="GET"&&["deployments","subdomain"].includes(section))return credentials.tokens.workers;
  if(method==="GET"&&section.startsWith("versions/"))return credentials.tokens.workers;
  if(method==="POST"&&section==="deployments")return credentials.tokens.workers;
  if(method==="DELETE"&&section==="")return credentials.tokens.workers;
  throw Error("paid_qa_method_not_authorized");
}
export function paidQaWranglerTokenFor(args,credentials) {
  assert.ok(Array.isArray(args)&&args.length>=1);
  if(args[0]==="deploy")return credentials.tokens.workers;
  if(args[0]==="r2" && ["bucket","object"].includes(args[1]) &&
    ["create","delete","put","get"].includes(args[2]||""))
    return credentials.tokens.r2;
  throw Error("paid_qa_wrangler_operation_not_reviewed");
}
