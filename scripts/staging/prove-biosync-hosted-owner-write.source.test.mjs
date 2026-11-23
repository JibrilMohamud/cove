/* eslint-disable prettier/prettier -- Offline safety guard for a protected, synthetic-only hosted proof. */
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {test} from "node:test";
const read=p=>readFileSync(p,"utf8");
const script=read("scripts/staging/prove-biosync-hosted-owner-write.mjs");
const flow=read(".github/workflows/cove-biosync-owner-cutover-offline.yml");
const qaPrimary="4e17ba6f-444f-4245-801a-a7d4969045b0";
const prodPrimary="4bd657ac-8789-403e-a28c-93aba8d0a989";
const prodAccount="d26430caa63ec55f6612e32f36aca5e9";
test("Hosted owner proof cannot address the production account or primary",()=>{
  assert.doesNotMatch(script,new RegExp(prodPrimary+"|"+prodAccount));
  assert.match(script,/import \{QA_ACCOUNT,QA_DATABASE,QA_BUCKET\}/);
  assert.match(script,/process\.env\.CLOUDFLARE_ACCOUNT_ID!==QA_ACCOUNT/);
  assert.match(script,/COVE_CF_QA_WORKERS_DEPLOY_TOKEN/);
  assert.match(script,/COVE_CF_QA_D1_MUTATION_TOKEN/);
  assert.match(script,/COVE_CF_QA_R2_STORAGE_TOKEN/);
  assert.match(script,/new Set\(tokens\)\.size!==tokens\.length/);
  assert.match(script,/COVE_BIOSYNC_REVIEWED_MAIN_SHA!==process\.env\.GITHUB_SHA/);
  assert.match(script,/GITHUB_REF!=="refs\/heads\/main"/);
  assert.match(script,/\["workflow_dispatch","issue_comment"\]\.includes\(event\)/);
  assert.match(script,/if\(event==="issue_comment"\)/);
  assert.match(script,/checkHostedCommentEnvironment\(process\.env\)/);
  assert.match(script,/qa_ephemeral_worker_residual/);
  // Require a real edge-service propagation proof, never blind deployment
  // success followed by a positive owner write during a not-yet-live route.
  assert.match(script,/async function waitForAuthenticatedGateway\(\)/);
  assert.match(script,/authorization":"Bearer invalid-ready-probe"/);
  assert.match(script,/result\.status===401/);
  assert.match(script,/unauthenticated_gateway_accepted_request/);
  assert.match(script,/authenticated_gateway_not_ready_/);
  assert.ok(script.indexOf("await waitForAuthenticatedGateway();") <
    script.indexOf("const first=await callOwner(command,client);"),
    "A live 401 read-only denial must precede the first positive owner command");
  // A bad-token 401 alone does not prove actual service-binding and owner
  // Durable Object readiness. Only an authenticated GET-denial through the
  // private owner can certify pre-commit ingress stability.
  assert.match(script,/import \{stabilizeBiosyncOwnerBinding\}/);
  assert.match(script,/async function waitForBoundOwnerReadiness\(client\)/);
  assert.match(script,/ownerOrigin\+"\/qa\/owner-bound-ready"/);
  assert.match(script,/body:"\{\}"/);
  assert.match(script,/hostedPhase="owner_binding_readiness"/);
  assert.ok(script.indexOf("await waitForBoundOwnerReadiness(client);") >
    script.indexOf("await waitForAuthenticatedGateway();"));
  assert.ok(script.indexOf("await waitForBoundOwnerReadiness(client);") <
    script.indexOf("const first=await callOwner(command,client);"));
  assert.doesNotMatch(script,/retry.*(?:callOwner\(command|checkedOwnerReceipt)/i);

  assert.match(script,/qa_r2_residual_map/);
  assert.match(script,/qa_d1_residual_synthetic_rows/);
  assert.match(script,/async function independentlyVerifyTeardownOnce\(\)/);
  assert.match(script,/async function confirmTeardownAfterPropagation\(\)/);
  assert.match(script,/consecutive===2/);
  assert.match(script,/qa_final_teardown_not_independently_verified/);
  assert.match(script,/cleanup_classes=/);
  assert.match(script,/releaseCertified:false/);
  assert.match(script,/async function deployIsolatedQaWorker\(config,secrets\)/);
  assert.match(script,/worker_version_10007/);
  assert.match(script,/attempt<=3/);
  assert.match(script,/error\?\.coveSafeCategory!=="worker_version_10007"/);
  assert.match(script,/primaryFailure=error/);
  assert.match(script,/if\(primaryFailure\)console\.error/);
  assert.match(script,/provisioning_class=/);
  // No retry is allowed on an uncertain owner command, provider write, R2,
  // payment or D1 mutation: the repeat wrapper is deployment-only.
  assert.match(script,/wrangler\(\["deploy","--config",config,"--secrets-file",secrets\]\)/);
  assert.doesNotMatch(script,/retry.*(?:callOwner|await sql|seed\()/i);
});
test("Private owner command QA is manually protected, never triggered on push",()=>{
  const job=flow.split("  hosted-qa-owner-atomic-write:")[1];
  assert.ok(job,"Protected hosted owner job must be present");
  assert.match(job,/github\.event_name == 'workflow_dispatch'/);
  assert.match(job,/inputs\.reviewed_main_sha == github\.sha/);
  assert.match(job,/inputs\.confirm_hosted_owner_write == true/);
  assert.match(job,/inputs\.confirm_isolated_biosync_qa == true/);
  assert.match(job,/environment: cove-production-release-audit/);
  assert.match(job,/CLOUDFLARE_ACCOUNT_ID: f51e8ccbc394e2d6016ff8c2c303d54b/);
  assert.match(job,/scripts\/staging\/prove-biosync-hosted-owner-write\.mjs/);
  assert.doesNotMatch(job,/secrets\.CLOUDFLARE_API_TOKEN/);
  const original=flow.split("  hosted-qa-data-plane-readonly:")[1]?.split("  hosted-qa-owner-atomic-write:")[0];
  assert.ok(original&&original.includes("github.event_name == 'workflow_dispatch'"));
});
test("Dedicated worker configs still disallow production authority and customer routing",()=>{
  const owner=JSON.parse(read("wrangler.biosync-owner.qa.example.jsonc"));
  const gateway=JSON.parse(read("wrangler.biosync-gateway.qa.example.jsonc"));
  assert.equal(owner.workers_dev,false);
  assert.equal(gateway.workers_dev,false);
  assert.deepEqual(owner.routes,[]);
  assert.deepEqual(gateway.routes,[]);
  assert.equal(owner.d1_databases?.[0]?.database_id,qaPrimary);
  assert.equal(gateway.d1_databases,undefined);
  assert.equal(gateway.r2_buckets,undefined);
  assert.equal(owner.vars.COVE_RIGHTS_OWNER_ENABLED,"0");
  assert.equal(gateway.vars.COVE_BIOSYNC_QA_GATEWAY_ENABLED,"0");
});
