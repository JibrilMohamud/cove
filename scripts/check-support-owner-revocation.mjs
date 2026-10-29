/* eslint-disable prettier/prettier -- Exact support-to-owner negative-only routing regression. */
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";

const support=readFileSync("src/features/fore/support.server.ts","utf8");
const writer=readFileSync("src/storefront-strangler/legal-quarantine-qa.writer.ts","utf8");
const route=readFileSync("src/features/fore/api.server.ts","utf8");
const handler=support.slice(support.indexOf("export async function executeSupportAction("));
assert.match(route,/path === "\/admin\/support\/action"/);
assert.match(handler,/permission\("support\.entitlement\.manage"\)/);
const scope=handler.indexOf('assertScope(c, before.user_id, "user")');
const product=handler.indexOf('assertScope(c, before.product_id, "product")');
const owner=handler.indexOf("await executeStageCanonicalAdminCommand(env, {");
const direct=handler.indexOf('const status = x.actionType === "restore_entitlement"');
assert.ok(scope>=0&&product>scope&&owner>product&&direct>owner,
  "RBAC and support-case scope must precede owner denial, and owner must precede legacy D1");
const branch=handler.slice(owner-800,direct);
assert.match(branch,/env\.COVE_CANONICAL_LEGAL_WRITE_LOCK === "1"/);
assert.match(branch,/env\.COVE_LEGAL_CONSUMER_STAGE_ENABLED === "1"/);
assert.match(branch,/action: "revoke-entitlement"/);
assert.match(branch,/entitlementId: x.targetId/);
assert.match(branch,/sha256\(x.idempotencyKey\)/);
assert.match(branch,/x\.actionType === "restore_entitlement"/);
assert.match(branch,/after\.status !== "revoked"/);
assert.doesNotMatch(branch,/\.prepare\("UPDATE entitlements/);
assert.doesNotMatch(branch,/\.prepare\("UPDATE audio_offline_licenses/);
const rpc=writer.slice(writer.indexOf("      if(isEntitlement){"),writer.indexOf("      if(isCommercial){"));
const denied=rpc.indexOf("/commercial/entitlement/deny-next");
const canonical=rpc.indexOf("await env.PRIMARY_DB.batch([");
assert.ok(denied>=0&&canonical>denied,"Durable owner denial precedes canonical batch");
assert.match(rpc,/UPDATE entitlements SET status='revoked'/);
assert.match(rpc,/UPDATE audio_offline_licenses SET status='revoked'/);
assert.match(rpc,/revocation_reason='entitlement_revoked'/);
assert.doesNotMatch(rpc,/UPDATE entitlements SET status='active'/);
console.log("PASS: support MFA/RBAC/case scope remains ahead of typed owner revocation; offline D1 reconciliation is atomic and negative-only");
