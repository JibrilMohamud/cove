/* eslint-disable prettier/prettier -- All paid QA privileges are isolated in the separate Cove QA Cloudflare account. */
import assert from "node:assert/strict";
import {basename} from "node:path";

export const PRODUCTION_ACCOUNT="d26430caa63ec55f6612e32f36aca5e9";
export const QA_ACCOUNT="f51e8ccbc394e2d6016ff8c2c303d54b";
export const QA_PAID_D1="969f1ea0-5f57-4f3a-aa25-9c74e58f5af3";
export const QA_LEGAL_D1="3ffb3c0b-72b2-4a47-b63a-18aaf77762ea";
export const QA_SCHEMA_SOURCE_D1="d6f616c2-c832-439c-8f4f-e1454ab88c64";
export const PRODUCTION_D1="4bd657ac-8789-403e-a28c-93aba8d0a989";
const RUN=/^\d{8,15}-\d{1,5}$/;
const QA_WORKER=/^\/workers\/scripts\/(?:cove-paid-legal-owner|cove-paid-legal-writer|cove-paid-legal-caller|cove-paid-settlement-qa|cove-paid-d1-gateway|cove-paid-business-gateway)-(\d{8,15}-\d{1,5})(?:\/(settings|deployments|subdomain|versions\/[a-f0-9-]{36}))?$/;

export function checkedPaidQaCredentials(env) {
  assert.notEqual(QA_ACCOUNT,PRODUCTION_ACCOUNT);
  assert.equal(env?.CLOUDFLARE_ACCOUNT_ID,QA_ACCOUNT,
    "Paid QA refuses any Cloudflare account except dedicated Cove QA");
  assert.equal(env?.CLOUDFLARE_API_TOKEN,undefined,
    "Never inject the production-account broad bearer into paid QA");
  const run=String(env?.GITHUB_RUN_ID||"")+"-"+String(env?.GITHUB_RUN_ATTEMPT||"1");
  assert.match(run,RUN);
  const tokens={
    workers:env?.COVE_CF_QA_WORKERS_DEPLOY_TOKEN,
    d1:env?.COVE_CF_QA_D1_MUTATION_TOKEN,
    r2:env?.COVE_CF_QA_R2_STORAGE_TOKEN,
  };
  assert.ok(Object.values(tokens).every(x=>typeof x==="string"&&x.length>=20),
    "All three independent QA credential secrets are required");
  assert.equal(new Set(Object.values(tokens)).size,3,
    "Worker, D1 and R2 QA principals must all be independent");
  return {run,tokens};
}
export function paidQaApiTokenFor(method,resource,credentials) {
  if(typeof resource!=="string" || resource.includes("?") ||
     resource.includes("#") || resource.includes(".."))
    throw Error("paid_qa_unreviewed_control_plane_path");
  const base="/d1/database/";
  if(resource.includes(PRODUCTION_D1) || resource.startsWith(base))
    throw Error("paid_qa_direct_d1_api_forbidden_use_synthetic_gateway");
  const match=QA_WORKER.exec(resource);
  if(!match || match[1]!==credentials.run)
    throw Error("paid_qa_rejects_unreviewed_worker");
  const section=match[2]||"";
  if(method==="GET"&&section==="settings")return credentials.tokens.workers;
  if(method==="GET"&&["deployments","subdomain"].includes(section))return credentials.tokens.workers;
  if(method==="GET"&&section.startsWith("versions/"))return credentials.tokens.workers;
  if(method==="POST"&&section==="deployments")return credentials.tokens.workers;
  if(method==="DELETE"&&section==="")return credentials.tokens.workers;
  throw Error("paid_qa_method_not_authorized");
}
export function paidQaWranglerTokenFor(args,credentials) {
  assert.ok(Array.isArray(args)&&args.length>=1);
  const names=["owner-proof","writer-proof","caller-proof","settlement-proof","d1-gateway","business-gateway"];
  if(args[0]==="deploy"&&args[1]==="--config"&&
     args[3]==="--secrets-file"&&typeof args[4]==="string"&&
     names.some(n=>basename(args[2])===".cove-paid-"+n+"-"+credentials.run+".jsonc"))
    return credentials.tokens.workers;
  throw Error("paid_qa_wrangler_operation_not_reviewed");
}
