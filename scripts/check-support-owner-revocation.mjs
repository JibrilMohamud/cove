/* eslint-disable prettier/prettier -- Real private support owner supersedes the old staging revocation path. */
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";

const read=p=>readFileSync(p,"utf8");
const support=read("src/features/fore/support.server.ts");
const owner=read("src/storefront-strangler/legal-authority.worker.ts");
const routing=read("src/storefront-strangler/publication-owner-routing.server.ts");
const gateway=read("src/storefront-strangler/canonical-owner-command-gateway.ts");
const publicRoutes=read("src/features/fore/api.server.ts");
const handler=support.slice(support.indexOf("export async function executeSupportAction("));
const privateStart=owner.indexOf("async function executeSupportActionOwned("),
  privateEnd=owner.indexOf("/* eslint-enable @typescript-eslint/no-explicit-any */",privateStart);
assert.ok(privateStart>=0&&privateEnd>privateStart);
const privateHandler=owner.slice(privateStart,privateEnd);
const ownerStart=owner.indexOf('if(route==="/support/private-action")'),
  ownerEnd=owner.indexOf('if(route==="/publishing/onboarding/review")',ownerStart);
assert.ok(ownerStart>=0&&ownerEnd>ownerStart);
const ownerRoute=owner.slice(ownerStart,ownerEnd);
assert.match(publicRoutes,/path === "\/admin\/support\/action"/);
assert.match(handler,/return dispatchSupportOwnerAction\(env\.DB,staff\.userId,parsed\)/);
assert.doesNotMatch(handler,/\b(?:UPDATE|INSERT INTO|DELETE FROM)\s+(?:entitlements|audio_offline_licenses)\b/i);
assert.match(routing,/if\(!context\)throw new ApiError\(503,"Support operations require a private canonical owner/);
assert.match(gateway,/"support.execute-action":\{path:"\/support\/private-action"/);
assert.match(ownerRoute,/staff_principals WHERE user_id=\? AND status='active'/);
assert.match(ownerRoute,/staff_principal_roles pr JOIN staff_role_permissions p/);
assert.match(ownerRoute,/support\.entitlement\.manage/);
assert.match(ownerRoute,/previous\.staff_user_id!==input\.staffUserId/);
assert.match(ownerRoute,/previous\.case_id!==input\.action\.caseId/);
assert.match(ownerRoute,/previous\.target_id!==input\.action\.targetId/);
const scope=privateHandler.indexOf('assertScope(c,before.user_id,"user")');
const product=privateHandler.indexOf('assertScope(c,before.product_id,"product")');
const denial=privateHandler.indexOf('ownerTransaction(()=>denyPaidEntitlement(ownerSql');
const reconciled=privateHandler.indexOf("UPDATE entitlements SET status='revoked'");
assert.ok(scope>=0&&product>scope&&denial>product&&reconciled>denial,
 "Owner must validate support scope, commit paid-entitlement denial, then reconcile primary D1");
assert.match(privateHandler,/status='revoked'.*entitlement_revoked/);
assert.match(privateHandler,/Fresh independent positive rights proof is required/);
assert.match(privateHandler,/reconciled/);
assert.doesNotMatch(privateHandler,/UPDATE entitlements SET status='active'/);
assert.match(ownerRoute,/transactionSync\(fn\)/);
console.log("PASS: private support actor/RBAC and case-scope rechecked by QA legal owner; paid denial committed before D1 and offline reconciliation, positive restoration refused");
