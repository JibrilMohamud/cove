import assert from "node:assert/strict";
import {readdirSync,readFileSync} from "node:fs";

/**
 * Historical known-unsafe sources, not a grant of permission to keep using
 * the broad token. Changes may REMOVE names, never add new consumers.
 * This list must shrink to zero before credential revocation.
 */
const knownUnsafe=new Set([
  "biosync-canary",
  "continuous-publication-qa",
  "cove-commerce-private-qa-deploy",
  "cove-sounds-private-rollout",
  "covereads-secure-ssr-gateway",
  "deployed-canonical-d1-principal-audit",
  "deployed-commerce-browser-acceptance",
  "fast-storefront-real-catalog-acceptance",
  "isolated-commons-audio-technical-qa",
  "isolated-commons-review-cases",
  "isolated-data-plane",
  "isolated-open-license-discovery",
  "literary-drain-worker-deploy",
  "literary-guarded-owner-drain",
  "literary-isolated-replay-handoff-deploy",
  "literary-isolated-utc-budget",
  "literary-live-cutover-preflight",
  "literary-private-binding-stage-canary",
  "literary-prod-handoff-dormant-deploy",
  "literary-prod-publisher-dormant-deploy",
  "literary-progressive-canonical-publication",
  "literary-remote-staging-e2e",
  "production-cutover-topology-audit",
  "production-legal-owner-locked",
  "publication-source-isolation-qa",
  "storefront-strangler-safe-integration",
  "strangler-data-plane-preflight",
  "strangler-hosted-capacity-evaluation"
]);
const files=readdirSync(".github/workflows").filter(name=>/\.ya?ml$/.test(name));
const matches=files.filter(name=>{
  const raw=readFileSync(".github/workflows/"+name,"utf8");
  return raw.includes("secrets.CLOUDFLARE_API_TOKEN");
}).map(name=>name.replace(/\.ya?ml$/,"")).sort();
assert.ok(matches.every(name=>knownUnsafe.has(name)),
  "Unreviewed broad Cloudflare deployment secret use was introduced: "+
  matches.filter(name=>!knownUnsafe.has(name)).join(", "));
assert.ok(matches.length<=knownUnsafe.size,
  "Broad Cloudflare token references increased since baseline");
const removed=[...knownUnsafe].filter(name=>!matches.includes(name)).sort();
assert.ok(removed.includes("hosted-music-supply-disabled-qa"),
  "The isolated music QA must never regain the broad token");
console.log("BROAD_CF_TOKEN_REMAINING="+matches.length);
console.log("BROAD_CF_TOKEN_REMOVED="+removed.length);
console.log("PASS: no new broad Cloudflare secret consumers; historical unsafe usage is not authorized");
