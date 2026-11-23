import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
const get=p=>readFileSync(p,"utf8");
const backend=get("src/persistence-backend.worker.ts");
const owner=get("src/storefront-strangler/legal-authority.worker.ts");
const config=get("wrangler.backend.production.toml");
const legal=get("wrangler.legal-authority.production-locked.jsonc");
const bio=get(".github/workflows/biosync-canary.yml");
const cron=get("scripts/release/check-production-cron-continuity.mjs");
const qaRead=get("src/storefront-strangler/qa-owner-primary-read-entrypoint.ts");
const publication=get("src/storefront-strangler/publication-owner-routing.server.ts");

const counts=(s,x)=>s.split(x).length-1;
// This is source-only continuity; NOT hosted production or legal proof.
for(const [name,marker] of [
  ["exclusive", "scopeExclusiveCanonicalD1(scopePublicationOwnerEnv(env))"],
  ["isolated-reader", "scopeQaOwnerUnboundPrimaryRead(env)"],
])assert.equal(counts(backend,marker),2,name+": both HTTP and cron must scope");
assert.match(backend,/runCommercialQueues\(controller\.cron, env\)/);
const fetchEntry=backend.slice(backend.indexOf("  async fetch(request: Request, env: BackendEnv"));
assert.ok(fetchEntry.indexOf("scopeQaOwnerUnboundPrimaryRead(env)")>0 &&
  fetchEntry.indexOf("scopeQaOwnerUnboundPrimaryRead(env)")<fetchEntry.indexOf("await authorized(request, env)"),
  "The no-D1 QA backend must resolve its owner read port before auth DB fallback");
assert.match(backend,/runScheduled\(controller\.cron, env\)/);
assert.match(backend,/processAccountDeletionQueue\(env, 5\)/);
assert.match(backend,/assertCronSettled/);
assert.match(owner,/serveQaOwnerPrimaryRead\(request,env\.PRIMARY_DB,/);
assert.match(owner,/if\s*\(!qaOwnerLeaseLive\(env\)\)/);
assert.match(owner,/env\.COVE_RIGHTS_OWNER_PRIMARY_ID===BIOSYNC_QA_PRIMARY/);
assert.match(owner,/route===QA_OWNER_PRIMARY_READ_ROUTE/);
assert.match(publication,/dispatchCanonicalOwnerCommand/);
assert.match(publication,/publication_owner_cutover_not_certified/);
assert.match(qaRead,/env\.FORE_ENVIRONMENT\s*===\s*"production"/);
assert.match(qaRead,/env\.DB\s*!==\s*undefined/);
assert.match(config,/binding = "DB"/);
assert.match(config,/database_id = "4bd657ac-8789-403e-a28c-93aba8d0a989"/);
assert.match(legal,/"COVE_RIGHTS_OWNER_ENABLED": "0"/);
assert.match(legal,/"COVE_RIGHTS_OWNER_PRIMARY_ID": "4bd657ac-8789-403e-a28c-93aba8d0a989"/);
assert.match(bio,/cron: '42 \* \* \* \*'/);
assert.match(bio,/python3 -m scripts\.audio_pipeline\.biosync_canary/);
assert.match(cron,/expectedBackendCrons/);
assert.match(cron,/CLOUDFLARE_API_TOKEN/);
assert.doesNotMatch(config,/COVE_QA_OWNER_UNBOUND_READ_ENABLED\s*=\s*"1"/);
console.log("PASS: integrated source preserves owner handlers, 7-cron+BioSync continuity, no-DB isolated QA transport and disabled production owner. NOT physical writer cutover.");
