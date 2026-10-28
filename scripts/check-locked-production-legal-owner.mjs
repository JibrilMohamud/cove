/* eslint-disable prettier/prettier -- Fail-closed production owner provisioning invariant. */
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";

export const PROD_D1="4bd657ac-8789-403e-a28c-93aba8d0a989";
const QA_D1=["5e3a6b69-6f3d-4b19-b837-01f7aa56ce87","7c7ab994-f6b3-419d-a72d-71eb9ea22e7e"];
export const CONFIG="wrangler.legal-authority.production-locked.jsonc";

/**
 * This validates provisioning of a NON-OPERATIONAL production owner namespace.
 * No owner-only read, paid-access issuance, or protected mutation is enabled.
 * Removing the QA-only lease gate requires a separate reviewed migration,
 * canonical writer closure, revocation/replay proofs and release certification.
 */
export function verifyLockedOwnerConfig(config,source){
  assert.equal(config.name,"cove-legal-authority-production");
  assert.equal(config.main,".output/strangler/legal-authority.mjs");
  assert.equal(config.workers_dev,false);
  assert.equal(config.preview_urls,false);
  assert.deepEqual(config.routes,[]);
  assert.equal(config.vars?.COVE_RIGHTS_OWNER_ENABLED,"0");
  assert.equal(config.vars?.COVE_RIGHTS_OWNER_PRIMARY_ID,PROD_D1);
  assert.equal(Object.keys(config.vars).sort().join(","),
    "COVE_RIGHTS_OWNER_ENABLED,COVE_RIGHTS_OWNER_PRIMARY_ID");
  assert.deepEqual(config.d1_databases,[{
    binding:"PRIMARY_DB",database_name:"cove-production",database_id:PROD_D1,
  }]);
  assert.deepEqual(config.durable_objects?.bindings,[{
    name:"LEGAL_AUTHORITY",class_name:"CoveLegalAuthority",
  }]);
  assert.deepEqual(config.migrations,[{
    tag:"legal-authority-production-locked-v1",new_sqlite_classes:["CoveLegalAuthority"],
  }]);
  assert.ok(!source.includes(PROD_D1),"Production database must not be allowed through QA lease");
  for(const id of QA_D1)
    assert.ok(source.includes(id),"Existing isolated-QA lease guard must remain");
  assert.match(source,/if\s*\(!qaOwnerLeaseLive\(env\)\)/,
    "The Durable Object must refuse operation without its QA lease");
  assert.match(source,/if\s*\(!qaOwnerLeaseLive\(env\)\s*\|\|/,
    "The private Worker entrypoint must refuse operation without its QA lease");
  return true;
}
if(process.argv[1] && import.meta.url===new URL("file://"+process.argv[1]).href){
  verifyLockedOwnerConfig(
    JSON.parse(readFileSync(CONFIG,"utf8")),
    readFileSync("src/storefront-strangler/legal-authority.worker.ts","utf8")
  );
  console.log("PASS: production legal-owner namespace is private, QA-ineligible and DISABLED.");
  console.log("NOT CERTIFIED: no live writer ownership or positive publishing is enabled.");
}

if(process.argv.includes("--live")){
  const token=process.env.CLOUDFLARE_API_TOKEN;
  const account=process.env.CLOUDFLARE_ACCOUNT_ID;
  assert.ok(token && account,"Live verification requires authenticated Cloudflare");
  const response=await fetch(
    "https://api.cloudflare.com/client/v4/accounts/"+
    encodeURIComponent(account)+"/workers/scripts/cove-legal-authority-production/settings",
    {headers:{authorization:"Bearer "+token}}
  );
  assert.equal(response.status,200,"Production private owner must be deployed");
  const payload=await response.json();
  assert.equal(payload.success,true);
  const bindings=payload.result?.bindings||[];
  const binding=(name)=>bindings.find(b=>b.name===name);
  assert.equal(binding("PRIMARY_DB")?.type,"d1");
  assert.equal(binding("PRIMARY_DB")?.id,PROD_D1);
  assert.equal(binding("LEGAL_AUTHORITY")?.type,"durable_object_namespace");
  assert.equal(binding("COVE_RIGHTS_OWNER_ENABLED")?.type,"plain_text");
  assert.equal(binding("COVE_RIGHTS_OWNER_ENABLED")?.text,"0");
  assert.equal(binding("COVE_RIGHTS_OWNER_PRIMARY_ID")?.text,PROD_D1);
  assert.ok(!bindings.some(b=>b.type==="service"),"No external service binding in locked owner");
  console.log("PASS: Cloudflare has the isolated production D1 and DO bindings; rights owner is DISABLED.");
}
