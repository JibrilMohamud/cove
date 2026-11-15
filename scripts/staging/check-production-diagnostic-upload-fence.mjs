/* eslint-disable prettier/prettier -- Unconditional live release fence after zero-traffic candidate upload. */
import assert from "node:assert/strict";
const token=process.env.CLOUDFLARE_API_TOKEN;
assert.ok(token);
const account="d26430caa63ec55f6612e32f36aca5e9";
assert.equal(process.env.CLOUDFLARE_ACCOUNT_ID,account);
const response=await fetch(
  "https://api.cloudflare.com/client/v4/accounts/"+account+
  "/workers/scripts/cove-persistence-backend/deployments",
  {headers:{authorization:"Bearer "+token},signal:AbortSignal.timeout(20000)}
);
assert.equal(response.ok,true,"Cannot independently confirm Worker deployment");
const body=await response.json();
assert.equal(body.success,true);
const head=body.result?.deployments?.[0];
assert.equal(head?.id,"86d49417-d6e5-40cb-a7e4-8245fbf26a09");
assert.deepEqual(head.versions,[{
  version_id:"401f2af2-6e69-4611-8110-1d127af6eecf",
  percentage:100,
}],"Unexpected customer-facing Worker version change");
console.log(JSON.stringify({event:"cove_diagnostic_upload_rollback_fence",
  activeVersion:451,customerTrafficPercent:100,
  uploadOnly:true,releaseCertified:false}));
