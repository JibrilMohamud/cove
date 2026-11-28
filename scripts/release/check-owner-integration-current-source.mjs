/* eslint-disable prettier/prettier -- Exact reviewed integration source-pinning; never a production release approval. */
import assert from "node:assert/strict";
import {reverseProductionQuarantineDelta,reverseProductionQuarantineCommerceDelta} from "./production-quarantine-source-delta.mjs";
import {reverseOwnerCompletionDelta} from "./owner-completion-source-delta.mjs";
import {createHash} from "node:crypto";
import {readFileSync} from "node:fs";
import {reverseNativePrimaryMarketDelta} from "./native-primary-market-source-delta.mjs";
import {assertDetachedCommerceIdentitySource,reverseDetachedCommerceOwnerDelta} from "./detached-commerce-owner-source-delta.mjs";
import {currentWriterSites,reconcileWriterSites} from "../reconcile-canonical-writers.mjs";

// Historical retirement attestations certify the files that existed when
// each retirement occurred. A later, legitimately migrated file MUST NOT be
// falsely represented as byte-identical to its October ancestor. Pin all
// twelve migrated or concurrently changed current files separately instead.
// The publishing current pin now includes the CodeQL-required one-pass EPUB
// entity decoder (6c9454a5); immutable historical retirement receipts are unchanged.
// These are CI-observed bytes of the 2026-11-22 integration candidate, not
// evidence of deployed physical ownership, external rights or LIVE commerce.
const PINNED_CURRENT_SOURCES=Object.freeze({
  "src/features/fore/api.server.ts":"9082ea9d354c964ee4955c11fb26472b637092806d30f7b2ec9cbaba15749a85",
  "src/features/fore/catalog-model.server.ts":"c4d03da0a2428d5290c000d5d39f6129f2491254335c975e3acb0a340c0f172b",
  "src/features/fore/commerce.server.ts":"68843d3739fcb765c9f40873601b0e685fcc590db73bd55cd0b606a716d7b830",
  "src/features/fore/delivery.server.ts":"f902d2d468ced783c1f1123017e25fb30a8d9f648612f5c54d2ea22f3eb22531",
  "src/features/fore/localization.server.ts":"02852814c24e749359ed751717a8387ab6dc75ba4ecba78d6058ecbbfba919e1",
  "src/features/fore/promotions.server.ts":"05c37488918235a18839605db9873bc9f645b465e238ffcf9680bbd4b0618047",
  "src/features/fore/publishing.server.ts":"0518338b3a9512c82075dc89fcba927f80d04b54ec7e57ba8a3b3726d069b2a8",
  "src/features/fore/publishing-trust.server.ts":"7b712809bd58a2d0456ad38da3b0ecb75621688dedd070a2f8687ebef6765590",
  "src/features/fore/regional-epub-asset-repair.server.ts":"27322f92d09b409c0913cdc96e523f0b610999a685a325fd3a0642fdb98c0443",
  "src/features/fore/rights.server.ts":"a7839d53ae20ffa3351bd6fbef797bd3d06dfb30c7d390168c195be8680e5fa2",
  "src/features/fore/search.server.ts":"6058f067527184f817f2759c0385129a344c67ea995d4fe46a58e53ea561f356",
  "src/features/fore/traditional-publishing.server.ts":"364406b8ed38f06563a6e307aa0512e64b41c926ee7236bf34e216e8f0166191",
  "src/storefront-strangler/legal-authority.worker.ts":"07c2c9cc392cfb933326c766dcaf14dc6e3db63b3eceb86d601ffbf49e0e6b2b",
});
const review=JSON.parse(readFileSync("docs/architecture/canonical-writer-review.json","utf8"));
assert.equal(review.schema,"cove.canonical-writer-review.v1");
assert.equal(review.releaseApproval,false);
const current=currentWriterSites();
const reconciled=reconcileWriterSites(current,review);
assert.deepEqual(reconciled.unknown,[],"Unreviewed current SQL cannot pass");
assert.deepEqual(reconciled.stale,[],"Stale current SQL cannot pass");
assert.equal(current.length,46,"The reviewed 46-site post-October boundary changed");
const counts=Object.fromEntries(["isolated-test-fixture","non-authorizing-write","private-owner-qa-executor","owner-command-required"]
  .map(d=>[d,review.sites.filter(s=>s.disposition===d).length]));
assert.deepEqual(counts,{"isolated-test-fixture":1,"non-authorizing-write":22,"private-owner-qa-executor":23,"owner-command-required":0});
assert.ok(review.sites.every(s=>s.productionOwnerGuarded===false),
  "Current source audit cannot certify deployed ownership");
// PR #916: validate the exact new imported identity helper, and restore
// the prior legal owner bytes before applying the unchanged historical chain.
assertDetachedCommerceIdentitySource(readFileSync("src/storefront-strangler/owner-user-id.ts","utf8"));
const reverseCurrentOwner=bytes=>reverseNativePrimaryMarketDelta(reverseDetachedCommerceOwnerDelta(reverseOwnerCompletionDelta("src/storefront-strangler/legal-authority.worker.ts",reverseProductionQuarantineDelta(bytes))));
for(const [path,pin] of Object.entries(PINNED_CURRENT_SOURCES)){
  const bytes=readFileSync(path,"utf8");
  let reviewed=path==="src/storefront-strangler/legal-authority.worker.ts"?reverseCurrentOwner(bytes):path==="src/features/fore/search.server.ts"?reverseOwnerCompletionDelta(path,bytes):path==="src/features/fore/commerce.server.ts"?reverseProductionQuarantineCommerceDelta(bytes):bytes;
  // Reverse only the exact EPUB clock fix to preserve the historical source pin.
  if(path==="src/features/fore/delivery.server.ts"){
    const fixed="expires = new Date(Date.parse(issued) + Number(policy.token_ttl_seconds || 300) * 1000).toISOString(),",original="expires = new Date(Date.now() + Number(policy.token_ttl_seconds || 300) * 1000).toISOString(),";
    assert.equal(reviewed.split(fixed).length,2,"Expected exact EPUB grant clock correction");
    reviewed=reviewed.replace(fixed,original);
  }
  const actual=createHash("sha256").update(reviewed).digest("hex");
  assert.equal(actual,pin,"New current source change requires independent legal/caller review: "+path);
}
// Independent byte-exact re-review of the post-October BioSync QA owner
// isolation. The 1MB account/catalog/commerce implementation was previously
// pinned byte-for-byte. Reversing only FOUR reviewed deny-first additions
// must reproduce that exact previous file SHA; no unrelated SQL, caller,
// commerce or publication code may change while refreshing this pin.
const ownerPath="src/storefront-strangler/legal-authority.worker.ts";
let priorOwner=reverseCurrentOwner(readFileSync(ownerPath,"utf8"));
// The 2026-11-24 schedule change adds only this import, flag and private
// dispatch. Removing these exact ranges must recover the previous full
// owner bytes. The new RPC's QA lease/domain/replay tests run separately;
// no existing grant, withdrawal, payment or publication handler is edited.
for (const addition of ["import { QA_SCHEDULE_ROUTE, serveQaOwnerScheduledTick } from \"./qa-owner-scheduled-execution\";\n", "  COVE_QA_SCHEDULE_OWNER_ENABLED?: string;\n", "    if(route===QA_SCHEDULE_ROUTE){\n      return serveQaOwnerScheduledTick(request,env,\n        this.ctx.storage as Parameters<typeof serveQaOwnerScheduledTick>[2],this);\n    }\n"]) {
  assert.equal(priorOwner.split(addition).length,2,"Scheduled QA owner dispatch delta drifted");
  priorOwner=priorOwner.replace(addition,"");
}
assert.equal(createHash("sha256").update(priorOwner).digest("hex"),
  "8b61337f1e821f59e7bf2f2eef01e6018a337c6947bfbb2a669a3239e0b7abd1","Scheduled dispatch must preserve every previous owner handler byte-for-byte");


/*
 * Explicit 2026-11-23 caller-and-owner source re-review of a SINGLE legal
 * eligibility predicate for a dual-format paid publication. The customer
 * original audio handler already accepts independent frozen licensed audio
 * attached to a purchased ebook SKU. The owner still verifies, immediately
 * before issuing any offline license: current paid entitlement, current
 * withdrawal/market, ebook/audiobook format, permitted publisher source,
 * exact frozen publication and edition, audio chapter digest, independently
 * live offline+retail narrator agreements, registered device, buyer/order
 * risk, max device count and atomic replacement of stale licenses.
 *
 * Reverting the TWO exact reviewed text ranges MUST recreate the prior
 * exact source hash. This is engineering source-integrity evidence only,
 * never proof of rightsholder authority, production credential exclusivity,
 * Stripe LIVE settlement, or a release approval.
 */
for(const [introduced,original] of [
  [
    `        // A paid EPUB SKU can also carry an independently published licensed
        // audiobook. Product format is not an audio rights grant: the exact
        // current immutable audio publication, narration agreements, device,
        // entitlement, market and current owner denial fences below are ALL
        // still required before issuing any offline audio receipt.
`,
    ""
  ],
  ["p.format IN ('ebook','audiobook')","p.format='audiobook'"]
]){
  assert.equal(priorOwner.split(introduced).length,2,
    "Dual-format owner change must remain one separately reviewed exact delta");
  priorOwner=priorOwner.replace(introduced,original);
}
assert.equal(createHash("sha256").update(priorOwner,"utf8").digest("hex"),
  "d8872ecce04958036b03036995c934dfe9d4de615a612a6714fc11b3573f8c9e",
  "Dual-format owner source must revert byte-for-byte to the prior approved owner pin");

// Independently inspect the exact five-entry owner integration delta before
// accepting the new current pin: the only allowed changes compared with the
// previously reviewed 1MB owner are the QA SELECT transport, private route
// forwarding and digest-only, denial-checked session touch. Reversing ONLY
// these exact byte ranges must recover the prior pinned owner file. The old
// October source attestations remain historical and releaseApproval=false.
// This is source integrity, never authority to enable production grants.
const qaReadAndSessionOnlyDelta=Object.freeze([
  { introduced:"import { QA_OWNER_PRIMARY_READ_ROUTE, serveQaOwnerPrimaryRead } from \"./qa-owner-primary-read-transport.mjs\";\n", original:"" },
  { introduced:"    // Existing synthetic-only, short-lived QA lease. Disabled production\n    // and dedicated BioSync QA cannot serve arbitrary owner primary reads.\n    if(route===QA_OWNER_PRIMARY_READ_ROUTE){\n      if(env.COVE_RIGHTS_OWNER_PRIMARY_ID===BIOSYNC_QA_PRIMARY)\n        return new Response(null,{status:404,headers:noStore});\n      return serveQaOwnerPrimaryRead(request,env.PRIMARY_DB,\n        env.COVE_RIGHTS_OWNER_SECRET!,qaOwnerLeaseLive(env));\n    }\n", original:"" },
  { introduced:"          z.object({action:z.literal(\"erasure-tick\"),limit:z.number().int().min(1).max(25)}).strict(),\n          // Digest only. Reject the original cookie, mutable session IDs and\n          // caller-selected timestamps before any owner-side storage.\n          z.object({action:z.literal(\"touch-session\"),userId:z.string().regex(/^[a-zA-Z0-9:_-]{3,160}$/),\n            sessionHash:z.string().regex(/^[a-f0-9]{64}$/),\n            userAgentSummary:z.string().max(240),\n            ipCountry:z.string().regex(/^[A-Z]{0,2}$/)}).strict()", original:"          z.object({action:z.literal(\"erasure-tick\"),limit:z.number().int().min(1).max(25)}).strict()" },
  { introduced:"            if(input.action===\"touch-session\"){\n              // This metadata-only operation has a natural idempotency key:\n              // (verified account, SHA-256 cookie/session fingerprint). A\n              // retry cannot create a second session or revive a revoked one.\n              const at=new Date().toISOString();\n              const sessionId=\"sess_\"+crypto.randomUUID();\n              await db.prepare(\n                \"INSERT INTO account_sessions(id,user_id,provider_session_id_hash,user_agent_summary,ip_country,created_at,last_seen_at) VALUES(?,?,?,?,?,?,?) \"+\n                \"ON CONFLICT(user_id,provider_session_id_hash) DO UPDATE SET \"+\n                \"last_seen_at=CASE WHEN excluded.last_seen_at>account_sessions.last_seen_at THEN excluded.last_seen_at ELSE account_sessions.last_seen_at END,\"+\n                \"user_agent_summary=excluded.user_agent_summary,ip_country=excluded.ip_country \"+\n                \"WHERE account_sessions.revoked_at IS NULL\")\n                .bind(sessionId,input.userId,input.sessionHash,input.userAgentSummary,input.ipCountry,at,at)\n                .run();\n              const current=await db.prepare(\n                \"SELECT id,revoked_at FROM account_sessions WHERE user_id=? AND provider_session_id_hash=?\")\n                .bind(input.userId,input.sessionHash).first<{id:string;revoked_at:string|null}>();\n              // A concurrent legal owner denial must never be mistaken for\n              // permission merely because a D1 metadata write committed.\n              const deniedAfter=sql.exec(\n                \"SELECT 1 ok FROM cove_account_access_denials WHERE user_id=?\",input.userId\n              ).toArray().length;\n              if(!current||current.revoked_at||deniedAfter)\n                return new Response(null,{status:403,headers:noStore});\n              result={sessionId:current.id};\n            }else{\n              // Cookies and caller-selected identity headers never cross this\n              // protocol. The authenticated API supplies its verified app ID.\n              const auditRequest=new Request(\"https://legal-authority.internal/account/device\");\n              result=input.action===\"register-device\"?\n                await privateAccount.registerDevice(db,input.userId,auditRequest,input.device):\n                await privateAccount.revokeDevice(db,input.userId,input.deviceId,auditRequest);\n            }", original:"            // Cookies and caller-selected identity headers never cross this\n            // protocol. The authenticated API supplies its verified app ID.\n            const auditRequest=new Request(\"https://legal-authority.internal/account/device\");\n            result=input.action===\"register-device\"?\n              await privateAccount.registerDevice(db,input.userId,auditRequest,input.device):\n              await privateAccount.revokeDevice(db,input.userId,input.deviceId,auditRequest);" },
  { introduced:"    if(new URL(request.url).pathname===QA_OWNER_PRIMARY_READ_ROUTE){\n      if(!qaOwnerLeaseLive(env)||!env.LEGAL_AUTHORITY?.getByName||\n         env.COVE_RIGHTS_OWNER_PRIMARY_ID===BIOSYNC_QA_PRIMARY)\n        return new Response(null,{status:503,headers:{\"cache-control\":\"no-store\"}});\n      if(request.headers.get(\"authorization\")!==\"Bearer \"+env.COVE_RIGHTS_OWNER_SECRET)\n        return new Response(null,{status:401,headers:{\"cache-control\":\"no-store\"}});\n      return env.LEGAL_AUTHORITY.getByName(\"cove-staged-legal-global-v1\").fetch(request);\n    }\n", original:"" }
]);
for(const {introduced,original} of qaReadAndSessionOnlyDelta){
  assert.equal(priorOwner.split(introduced).length,2,
    "Owner integration drifted from the specifically reviewed QA read/session changes");
  priorOwner=priorOwner.replace(introduced,original);
}
assert.equal(createHash("sha256").update(priorOwner,"utf8").digest("hex"),
  "64146e35c7fdacdeace9d13e98595e1eba64a893b233f0b23e20e80e88cac65b",
  "Integrated legal owner must revert byte-exactly to the prior reviewed owner source");

const guardedBioSyncAdditions=[
  `  // Dedicated synthetic BioSync QA account primary; never production.
  "4e17ba6f-444f-4245-801a-a7d4969045b0",
`,
  `// Dedicated BioSync QA cannot execute commerce, catalog or rights commands.
const BIOSYNC_QA_PRIMARY="4e17ba6f-444f-4245-801a-a7d4969045b0";
`,
  `    if(env.COVE_RIGHTS_OWNER_PRIMARY_ID===BIOSYNC_QA_PRIMARY &&
       route!=="/biosync/publish-checked")
      return new Response(null,{status:404,headers:noStore});
`,
  `    // The synthetic BioSync owner must never become a general-purpose legal,
    // commerce, catalog, entitlement or account writer by abusing its QA lease.
    if(env.COVE_RIGHTS_OWNER_PRIMARY_ID===BIOSYNC_QA_PRIMARY &&
       new URL(request.url).pathname!=="/biosync/publish-checked")
      return new Response(null,{status:404,headers:{"cache-control":"no-store"}});
`,
];
for(const addition of guardedBioSyncAdditions) {
  assert.equal(priorOwner.split(addition).length,2,
    "Expected exactly one narrowly reviewed BioSync QA owner guard");
  priorOwner=priorOwner.replace(addition,"");
}
assert.equal(createHash("sha256").update(priorOwner,"utf8").digest("hex"),
  "c95a96993301de008ab4b9530b52a9408e871497402c1a27efdf4c4c6cddf6a5",
  "BioSync owner changes must be ONLY reviewed QA enroll/deny additions");
assert.equal(current.filter(s=>s.file==="src/features/fore/api.server.ts").length,0,
  "Shared API regained a direct protected SQL site");
console.log("PASS: 12 historical integrated source pins, exact detached commerce owner/identity delta, and prior reversible owner edits; 46 literal SQL sites reconciled (0 owner-required); historical attestation claims remain historical, not recertified.");
console.log("NO-GO: source closure is not active D1 binding/token exclusivity or current rightsholder authority.");

// 2026-11-24: the explicitly primary-only QA facade cannot initialize state.
// All native/writable environments retain their original initialization and
// diagnostic semantics. Remove ONLY this guard to restore every prior API byte.
const guardedStateInit = "  if (\n    (db as typeof db & { covePrimaryOnlyReadTransport?: boolean }).covePrimaryOnlyReadTransport !==\n    true\n  )\n    await ensureCatalogState(env);";
const currentApi=readFileSync("src/features/fore/api.server.ts","utf8");
assert.equal(currentApi.split(guardedStateInit).length,2);
assert.equal(createHash("sha256").update(currentApi.replace(guardedStateInit,"  await ensureCatalogState(env);")).digest("hex"),
  "ba30108f629d7e8c6c488ac34f831ce1f36814f96c4c4f9c0763418db78ed262",
  "Only the primary-only QA catalog-state guard is reviewed");
