/* eslint-disable prettier/prettier -- Safe isolated fixture for legacy credential inventory. */
import assert from "node:assert/strict";
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,readFileSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {test} from "node:test";
import {inventoryLegacyCloudflareCredential,requireNoLegacyCloudflareWorkflowReferences} from "./audit-legacy-cloudflare-credential.mjs";
test("live workflow source audit never calls a cleaned repository credential-free",()=>{
  const report=inventoryLegacyCloudflareCredential();
  assert.equal(report.schema,"cove.cloudflare-broad-credential-retirement.v1");
  assert.ok(report.workflowsInspected>=20);
  assert.equal(report.legacyCredentialReferences,report.remaining.reduce((sum,r)=>sum+r.uses,0));
  assert.equal(report.physicalRevocationCertified,false);
  if(report.legacyCredentialReferences>0)
    assert.throws(()=>requireNoLegacyCloudflareWorkflowReferences(report),/revocation forbidden/);
});
test("all legacy references are counted by workflow, not hidden in secret names",()=>{
  const root=mkdtempSync(join(tmpdir(),"cove-token-audit-"));
  const dir=join(root,".github","workflows");mkdirSync(dir,{recursive:true});
  try{
    writeFileSync(join(dir,"a.yml"),"env:\n  CF: \${{ secrets.CLOUDFLARE_API_TOKEN }}\n  B: \${{ secrets.CLOUDFLARE_API_TOKEN }}\n");
    writeFileSync(join(dir,"b.yaml"),"env:\n  CF: \${{ secrets.COVE_CF_STAGE_WORKERS_DEPLOY_TOKEN }}\n");
    let report=inventoryLegacyCloudflareCredential({root});
    assert.equal(report.workflowsInspected,2);
    assert.equal(report.affectedWorkflows,1);
    assert.equal(report.legacyCredentialReferences,2);
    assert.deepEqual(report.remaining[0].lines,[2,3]);
    assert.throws(()=>requireNoLegacyCloudflareWorkflowReferences(report),/revocation forbidden/);
    writeFileSync(join(dir,"a.yml"),"env:\n  CF: \${{ secrets.COVE_CF_STAGE_WORKERS_DEPLOY_TOKEN }}\n");
    report=inventoryLegacyCloudflareCredential({root});
    assert.equal(report.sourceReferencesCleared,true);
    assert.equal(report.physicalRevocationCertified,false);
    assert.equal(requireNoLegacyCloudflareWorkflowReferences(report),true);
  }finally{rmSync(root,{recursive:true,force:true});}
});

test("archived data plane retains offline correctness only, no secret or remote job",()=>{
  const source=readFileSync(".github/workflows/isolated-data-plane.yml","utf8");
  assert.match(source,/^  correctness:\s*$/m);
  assert.match(source,/npm run test:isolated-data-plane/);
  assert.match(source,/npm run test:rights && npm run test:commerce/);
  assert.doesNotMatch(source,/^  (?:hosted-capacity|publication-feed-live|restore-private-core):/m);
  assert.doesNotMatch(source,/secrets\s*[:.]|environment:|wrangler deploy|run: node scripts\/performance\/isolated-data-plane-acceptance\.mjs/);
});
