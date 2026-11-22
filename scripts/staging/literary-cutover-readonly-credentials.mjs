/* eslint-disable prettier/prettier -- Restrict live literary preflight to exact read-only Cloudflare operations. */
import assert from "node:assert/strict";

const ACCOUNT="d26430caa63ec55f6612e32f36aca5e9";
const PRIMARY="4bd657ac-8789-403e-a28c-93aba8d0a989";
const CONTENT="400c3af3-5d40-41fd-83cc-98228e40ddac";
const WORKER="cove-literary-handoff-isolated-disabled";
const BACKEND="cove-persistence-backend";
const BUCKET="cove-literary-originals-isolated-20261024";

export function checkedLiteraryCutoverReadOnlyCredentials(env) {
  assert.equal(env?.CLOUDFLARE_ACCOUNT_ID,ACCOUNT);
  assert.equal(env?.CLOUDFLARE_API_TOKEN,undefined,
    "Broad production deployment token must never enter read-only cutover audit");
  const tokens={
    d1:env?.COVE_CF_PRODUCTION_AUDIT_READ_TOKEN,
    metadata:env?.COVE_CF_WORKERS_METADATA_READ_TOKEN,
    backendContent:env?.COVE_CF_WORKERS_VERSION_UPLOAD_TOKEN,
    r2:env?.COVE_CF_STAGE_DATA_PLANE_READ_TOKEN
  };
  assert.ok(Object.values(tokens).every(x=>typeof x==="string"&&x.length>=20),
    "Four independent scoped literary cutover principals are required");
  assert.equal(new Set(Object.values(tokens)).size,4,
    "Do not recycle a broad principal under multiple read-only secret names");
  return {account:ACCOUNT,tokens};
}
export function literaryCutoverTokenFor(method,path,credentials) {
  const root="/accounts/"+ACCOUNT;
  assert.ok(credentials?.tokens,"Checked credentials required");
  if(typeof path!=="string"||path.includes("?")||path.includes("#")||path.includes(".."))
    throw Error("literary_cutover_unapproved_path");
  if(method==="POST"&&[
    root+"/d1/database/"+PRIMARY+"/query",
    root+"/d1/database/"+CONTENT+"/query"
  ].includes(path))return credentials.tokens.d1;
  if(method==="GET"&&[
    root+"/workers/scripts/"+WORKER+"/settings",
    root+"/workers/scripts/"+WORKER+"/schedules",
    root+"/workers/scripts/"+BACKEND+"/schedules"
  ].includes(path))return credentials.tokens.metadata;
  // Existing one-Worker Editor principal can read only this backend script;
  // it must never be used for a PUT/POST or any other resource.
  if(method==="GET"&&path===root+"/workers/scripts/"+BACKEND)
    return credentials.tokens.backendContent;
  if(method==="GET"&&[
    root+"/r2/buckets/"+BUCKET+"/domains/managed",
    root+"/r2/buckets/"+BUCKET+"/domains/custom"
  ].includes(path))return credentials.tokens.r2;
  throw Error("literary_cutover_write_or_unreviewed_resource_denied");
}
