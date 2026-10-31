/* eslint-disable prettier/prettier -- Negative production topology proof must not be treated as certification. */
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {spawnSync} from "node:child_process";
import {inspectCanonicalProductionTopology as inspect} from "./check-production-writer-topology.mjs";

const backend=readFileSync("wrangler.backend.production.toml","utf8");
const owner=readFileSync("wrangler.legal-authority.production-locked.jsonc","utf8");
const others=[
  {name:"cove-sounds-publication",
    config:readFileSync("wrangler.sounds-publication.prod-isolated.jsonc","utf8")},
  {name:"cove-storefront-ssr-staging",
    config:readFileSync("wrangler.frontend.staging.toml","utf8")}
];
const result=inspect(backend,owner,others);
assert.equal(result.schema,"cove.production-writer-topology.v1");
assert.deepEqual(result.persistenceCanonicalBindings,["DB"]);
assert.equal(result.scheduledJobs.length,6);
assert.deepEqual(result.additionalCanonicalBindings.map(x=>[x.worker,x.binding]),[
  ["cove-storefront-ssr-staging","DB"]
]);
assert.deepEqual(result.additionalCanonicalBindings[0].configuredCrons,[]);
assert.ok(result.bypassRisks.includes("other_deployed_workers_have_direct_canonical_D1_bindings"));
assert.equal(result.legalAuthorityEnabledInCommittedConfig,false);
assert.equal(result.productionAuthorizationCertified,false);
assert.equal(result.releaseEligible,false);
assert.ok(result.bypassRisks.includes("production_persistence_worker_still_has_canonical_D1_binding"));
assert.ok(result.bypassRisks.includes("scheduled_jobs_still_share_direct_canonical_D1_write_capability"));
const future=inspect(backend.replace(/\[\[d1_databases\]\][\s\S]*?(?=\n\[)/,"")
  .replace(/^crons\s*=.*$/m,"crons = []"),
  owner.replace('"COVE_RIGHTS_OWNER_ENABLED": "0"','"COVE_RIGHTS_OWNER_ENABLED": "1"'),others);
assert.equal(future.persistenceCanonicalBindings.length,0);
assert.equal(future.additionalCanonicalBindings.length,1,
  "Fixing persistence binding does not isolate other deployed Workers");
assert.equal(future.scheduledJobs.length,0);
assert.equal(future.legalAuthorityEnabledInCommittedConfig,true);
assert.equal(future.releaseEligible,false,"Even an apparently clean source config must not constitute deployed attestation");
const resultGate=spawnSync(process.execPath,["scripts/check-production-writer-topology.mjs","--release-gate"],{encoding:"utf8"});
assert.notEqual(resultGate.status,0);
assert.match(resultGate.stderr,/BLOCKED/);
console.log("PASS: all 6 production cron triggers and unfenced D1 binding reported; synthetic clean TOML cannot self-certify production; release gate remains closed");
