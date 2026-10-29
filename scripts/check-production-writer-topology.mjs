/* eslint-disable prettier/prettier -- Static topology is a necessary but never sufficient production release gate. */
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {pathToFileURL} from "node:url";

export function inspectCanonicalProductionTopology(backendToml,ownerJson,otherWorkers=[]){
  assert.equal(typeof backendToml,"string");
  const owner=typeof ownerJson==="string"?JSON.parse(ownerJson):ownerJson;
  assert.ok(owner&&typeof owner==="object"&&!Array.isArray(owner));
  const productionId=owner.d1_databases?.find(x=>x.binding==="PRIMARY_DB")?.database_id;
  assert.match(productionId||"",/^[a-f0-9-]{36}$/);
  const d1blocks=backendToml.match(/\[\[d1_databases\]\][\s\S]*?(?=\n\[|$)/g)||[];
  const canonicalBindings=d1blocks.filter(block=>
    new RegExp('database_id\\s*=\\s*"'+productionId+'"').test(block)).map(block=>
    (block.match(/\bbinding\s*=\s*"([^"]+)"/)||[])[1]||"<unknown>");
  const match=backendToml.match(/^crons\s*=\s*\[([^\]]*)\]/m);
  const configuredCrons=match?[...match[1].matchAll(/"([^"]+)"/g)].map(x=>x[1]):[];
  const additionalCanonicalBindings=[];
  for(const worker of otherWorkers){
    assert.equal(typeof worker.name,"string");
    const config=worker.name==="cove-sounds-publication"
      ?JSON.parse(worker.config)
      :null;
    const d1=config?.d1_databases||[];
    const bindings=worker.name==="cove-storefront-ssr-staging"
      ?(worker.config.match(/\[\[d1_databases\]\][\s\S]*?(?=\n\[|$)/g)||[])
        .filter(block=>block.includes('database_id = "'+productionId+'"'))
        .map(block=>(block.match(/binding\s*=\s*"([^"]+)"/)||[])[1])
      :d1.filter(row=>row.database_id===productionId).map(row=>row.binding);
    for(const binding of bindings)additionalCanonicalBindings.push({
      worker:worker.name,binding,
      configuredCrons:config?.triggers?.crons||[]
    });
  }
  const ownerEnabled=owner.vars?.COVE_RIGHTS_OWNER_ENABLED==="1";
  const bypassRisks=[];
  if(canonicalBindings.length)
    bypassRisks.push("production_persistence_worker_still_has_canonical_D1_binding");
  if(canonicalBindings.length&&configuredCrons.length)
    bypassRisks.push("scheduled_jobs_still_share_direct_canonical_D1_write_capability");
  if(additionalCanonicalBindings.length)
    bypassRisks.push("other_deployed_workers_have_direct_canonical_D1_bindings");
  if(!ownerEnabled)bypassRisks.push("production_legal_authority_disabled");
  return {
    schema:"cove.production-writer-topology.v1",
    productionDatabaseId:productionId,
    persistenceCanonicalBindings:canonicalBindings,
    scheduledJobs:configuredCrons,
    additionalCanonicalBindings,
    legalAuthorityEnabledInCommittedConfig:ownerEnabled,
    bypassRisks,
    productionAuthorizationCertified:false,
    releaseEligible:false,
    deploymentEvidence:"required: live binding and schedule attestation, all API/cron/webhook writer reachability, secret-principal revocation, and actual paid/revocation replay tests",
    disclaimer:"Committed configuration cannot attest to deployed Workers or external D1 API principals. No feature flag or user-authored JSON can certify runtime ownership."
  };
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  const report=inspectCanonicalProductionTopology(
    readFileSync("wrangler.backend.production.toml","utf8"),
    readFileSync("wrangler.legal-authority.production-locked.jsonc","utf8"),
    [
      {name:"cove-sounds-publication",
        config:readFileSync("wrangler.sounds-publication.prod-isolated.jsonc","utf8")},
      {name:"cove-storefront-ssr-staging",
        config:readFileSync("wrangler.frontend.staging.toml","utf8")}
    ]
  );
  console.log(JSON.stringify(report,null,2));
  if(process.argv.includes("--release-gate")){
    console.error("BLOCKED: production authorization requires independently verified deployed writer isolation, not source-only topology.");
    process.exitCode=1;
  }
}
