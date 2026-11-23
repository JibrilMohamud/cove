/* eslint-disable prettier/prettier -- Exact per-run staging Worker/D1 principal isolation. */
import assert from "node:assert/strict";
export const ACCOUNT="d26430caa63ec55f6612e32f36aca5e9";
export const STAGING_D1="e4cbb0ef-6288-4fa1-9dbb-fb42fe01d4f3";
export const PRODUCTION_D1="4bd657ac-8789-403e-a28c-93aba8d0a989";

export function checkedStranglerAcceptanceCredentials(env){
  assert.equal(env?.CLOUDFLARE_ACCOUNT_ID,ACCOUNT);
  assert.match(String(env?.GITHUB_RUN_ID||""),/^\d{8,15}$/);
  const workers=env?.COVE_CF_STAGE_WORKERS_DEPLOY_TOKEN;
  const d1=env?.COVE_CF_STAGE_D1_READ_TOKEN;
  assert.ok(typeof workers==="string"&&workers.length>=20);
  assert.ok(typeof d1==="string"&&d1.length>=20);
  assert.notEqual(workers,d1,"Cloudflare staging deployment and D1 Read principals must differ");
  assert.equal(env?.CLOUDFLARE_API_TOKEN,workers,
    "Wrangler must receive the same existing scoped Workers principal, never a broad token");
  return {run:String(env.GITHUB_RUN_ID),workers,d1};
}
export function stranglerAcceptanceTokenFor(method,path,credentials){
  assert.ok(credentials?.run&&credentials?.workers&&credentials?.d1);
  if(path==="/accounts/"+ACCOUNT+"/d1/database/"+STAGING_D1+"/query"&&method==="POST")
    return credentials.d1;
  const worker=/^\/accounts\/d26430caa63ec55f6612e32f36aca5e9\/workers\/scripts\/cove-strangler-perf-(\d{8,15})-([1-3])(?:\/deployments|(\?force=true))?$/;
  const match=typeof path==="string"?worker.exec(path):null;
  if(!match||match[1]!==credentials.run)
    throw Error("strangler_acceptance_unreviewed_worker_or_database");
  if(method==="GET"&&path.endsWith("/deployments"))return credentials.workers;
  if(method==="DELETE"&&match[3]==="?force=true")return credentials.workers;
  throw Error("strangler_acceptance_mutation_forbidden");
}
