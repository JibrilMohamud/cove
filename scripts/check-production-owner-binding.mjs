/* eslint-disable prettier/prettier -- Provisioning the production binding never enables owner-only authorization. */
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {pathToFileURL} from "node:url";
export const PRODUCTION_D1="4bd657ac-8789-403e-a28c-93aba8d0a989";
export const PRODUCTION_OWNER_NAMESPACE="83d7eadf3957436389a7b072120a9829";
export const PRODUCTION_OWNER_SCRIPT="cove-legal-authority-production";
export function verifyProductionOwnerBinding(owner,backend=null) {
  const bindings=owner?.bindings||[];
  const byName=(name)=>bindings.find(b=>b.name===name);
  assert.equal(byName("PRIMARY_DB")?.type,"d1");
  assert.equal(byName("PRIMARY_DB")?.id,PRODUCTION_D1);
  assert.equal(byName("LEGAL_AUTHORITY")?.type,"durable_object_namespace");
  assert.equal(byName("LEGAL_AUTHORITY")?.namespace_id,PRODUCTION_OWNER_NAMESPACE);
  assert.equal(byName("COVE_RIGHTS_OWNER_ENABLED")?.text,"0");
  assert.equal(byName("COVE_RIGHTS_OWNER_PRIMARY_ID")?.text,PRODUCTION_D1);
  // Verify the private credential is provisioned without ever reading its value.
  // Matching secret binding names alone does NOT certify an authenticated handshake.
  assert.equal(byName("COVE_RIGHTS_OWNER_SECRET")?.type,"secret_text");
  if(backend) {
    const db=backend.bindings?.find(b=>b.name==="DB");
    const binding=backend.bindings?.find(b=>b.name==="LEGAL_AUTHORITY");
    const secret=backend.bindings?.find(b=>b.name==="COVE_RIGHTS_OWNER_SECRET");
    assert.equal(secret?.type,"secret_text");
    assert.equal(db?.type,"d1");assert.equal(db?.id,PRODUCTION_D1);
    assert.equal(binding?.type,"durable_object_namespace");
    assert.equal(binding?.namespace_id,PRODUCTION_OWNER_NAMESPACE);
    assert.equal(binding?.class_name,"CoveLegalAuthority");
    // Cloudflare may omit script_name when resolving the namespace, but a
    // supplied script name must identify the production owner exactly.
    if(binding.script_name!==undefined)assert.equal(binding.script_name,PRODUCTION_OWNER_SCRIPT);
  }
  return true;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) {
  const config=readFileSync("wrangler.backend.production.toml","utf8");
  assert.match(config,/\[\[durable_objects\.bindings\]\]\s*name = "LEGAL_AUTHORITY"\s*class_name = "CoveLegalAuthority"\s*script_name = "cove-legal-authority-production"/);
  const before=process.argv.includes("--before-deploy"),after=process.argv.includes("--after-deploy");
  if(before||after) {
    const token=process.env.CLOUDFLARE_API_TOKEN,account=process.env.CLOUDFLARE_ACCOUNT_ID;
    assert.ok(token&&/^[a-f0-9]{32}$/.test(account||""),"Authenticated Cloudflare account is required");
    const get=async name=>{
      const response=await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/workers/scripts/${name}/settings`,{
        headers:{authorization:"Bearer "+token},signal:AbortSignal.timeout(15000)});
      assert.equal(response.status,200,"Owner binding metadata must be available");
      const payload=await response.json();assert.equal(payload.success,true);return payload.result;
    };
    verifyProductionOwnerBinding(await get(PRODUCTION_OWNER_SCRIPT),after?await get("cove-persistence-backend"):null);
  }
  console.log("PASS: production owner binding, disabled state and both secret binding TYPES verified; credential equality, runtime handshake and cutover are NOT certified");
}
