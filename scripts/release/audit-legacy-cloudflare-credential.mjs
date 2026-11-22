/* eslint-disable prettier/prettier -- Credential revocation safety inventory. Do not read or print secrets. */
import assert from "node:assert/strict";
import {readFileSync,readdirSync} from "node:fs";
import {join} from "node:path";

export function inventoryLegacyCloudflareCredential({root=process.cwd()}={}) {
  const dir=join(root,".github","workflows");
  const files=readdirSync(dir).filter(name=>/\.ya?ml$/.test(name)).sort();
  assert.ok(files.length>=1,"No GitHub Actions workflow inventory: refuse token revocation");
  const direct=/secrets\.CLOUDFLARE_API_TOKEN\b/g;
  const remaining=[];
  for(const filename of files) {
    const raw=readFileSync(join(dir,filename),"utf8");
    const lines=raw.split(/\r?\n/);
    const hits=[];
    for(let i=0;i<lines.length;i++) {
      const matched=lines[i].match(direct);
      if(matched)hits.push({line:i+1,uses:matched.length});
    }
    if(hits.length)remaining.push({workflow:filename,lines:hits.map(h=>h.line),uses:hits.reduce((n,h)=>n+h.uses,0)});
  }
  return {
    schema:"cove.cloudflare-broad-credential-retirement.v1",
    workflowsInspected:files.length,
    affectedWorkflows:remaining.length,
    legacyCredentialReferences:remaining.reduce((n,f)=>n+f.uses,0),
    remaining,
    sourceReferencesCleared:remaining.length===0,
    // Source scans cannot attest Actions secret values, external automations,
    // API token role scopes, or Cloudflare activity/audit retention.
    physicalRevocationCertified:false,
  };
}
export function requireNoLegacyCloudflareWorkflowReferences(result) {
  assert.equal(result?.schema,"cove.cloudflare-broad-credential-retirement.v1");
  assert.equal(result?.sourceReferencesCleared,true,
    "Broad Cloudflare deployment credential still referenced by GitHub Actions; revocation forbidden");
  assert.equal(result?.legacyCredentialReferences,0);
  return true;
}
if(process.argv[1] && import.meta.url===new URL("file:"+process.argv[1]).href) {
  const gate=process.argv.includes("--release-gate");
  if(!gate&&!process.argv.includes("--audit"))throw Error("Specify --audit or --release-gate");
  const result=inventoryLegacyCloudflareCredential();
  process.stdout.write(JSON.stringify({...result,decision:result.sourceReferencesCleared?
    "SOURCE-ONLY-CLEAR; PHYSICAL-PROOF-REQUIRED":"NO-GO"})+"\n");
  if(gate)requireNoLegacyCloudflareWorkflowReferences(result);
}
