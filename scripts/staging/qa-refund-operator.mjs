// Only for the disposable Cove *isolated* customer QA D1.
// A temporary finance operator exercises Cove's real RBAC-protected refund API.
// No new refund backdoor is added to the production application.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

const account = "d26430caa63ec55f6612e32f36aca5e9";
const database = "5be15110-44a6-4090-b0a1-36599d809b28";
const role = "role_cove_synthetic_qa_refunds";
const actor = "cove-isolated-qa-harness";
const token = process.env.CLOUDFLARE_API_TOKEN;
assert.equal(process.env.CLOUDFLARE_ACCOUNT_ID, account);
assert.ok(token, "Cloudflare QA token required; never infer production credentials");

export async function qaD1(sql, params = []) {
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${account}/d1/database/${database}/query`,
    {
      method: "POST",
      headers: {
        authorization: "Bearer " + token,
        "content-type": "application/json",
      },
      body: JSON.stringify({ sql, params }),
      signal: AbortSignal.timeout(15000),
    },
  );
  const body = await response.json();
  assert.ok(response.ok && body.success, "Isolated QA D1 query failed");
  return body.result?.[0]?.results || [];
}

export async function provisionQaRefundOperator(userId) {
  assert.match(userId, /^sb:[a-f0-9-]{36}$/, "Only a verified Supabase QA subject may be provisioned");
  const profile = await qaD1(
    "SELECT created_by_user_id FROM staff_principals WHERE user_id=?",
    [userId],
  );
  assert.ok(
    !profile.length || profile[0].created_by_user_id === actor,
    "Existing non-QA staff principal must never be modified",
  );
  await qaD1(
    "INSERT OR IGNORE INTO staff_roles(id,name,description) VALUES(?,?,'Isolated signed-refund end-to-end QA only')",
    [role, "cove_synthetic_qa_refunds"],
  );
  await qaD1(
    "INSERT OR IGNORE INTO staff_role_permissions(role_id,permission) VALUES(?,'commerce.manage')",
    [role],
  );
  const at = new Date().toISOString();
  await qaD1(
    `INSERT INTO staff_principals(user_id,email,display_name,sso_provider,sso_subject,status,mfa_required,created_by_user_id,created_at,updated_at)
     VALUES(?,'','Cove QA Refund Operator','','','active',0,?,?,?)
     ON CONFLICT(user_id) DO UPDATE SET status='active',updated_at=excluded.updated_at
     WHERE staff_principals.created_by_user_id=?`,
    [userId, actor, at, at, actor],
  );
  await qaD1(
    "INSERT OR IGNORE INTO staff_principal_roles(user_id,role_id,granted_by_user_id,granted_at) VALUES(?,?,?,?)",
    [userId, role, actor, at],
  );
  await qaD1(
    "INSERT INTO staff_audit_events(id,target_user_id,actor_user_id,event_type,before_json,after_json,created_at) VALUES(?,?,?,'roles_changed','{}',?,?)",
    [
      "staffaudit_" + randomUUID(),
      userId,
      actor,
      JSON.stringify({ role: "cove_synthetic_qa_refunds", scope: "isolated_qa" }),
      at,
    ],
  );
  const check = await qaD1(
    `SELECT p.status,p.mfa_required,r.permission FROM staff_principals p
     JOIN staff_principal_roles pr ON pr.user_id=p.user_id
     JOIN staff_role_permissions r ON r.role_id=pr.role_id
     WHERE p.user_id=? AND pr.role_id=?`,
    [userId, role],
  );
  assert.ok(check.some((x) => x.status === "active" && x.permission === "commerce.manage"));
  console.log("QA_REFUND_ROLE_GRANTED", "isolated_d1_only");
}

export async function revokeQaRefundOperator(userId) {
  if (!userId) return;
  assert.match(userId, /^sb:[a-f0-9-]{36}$/);
  await qaD1(
    "DELETE FROM staff_principal_roles WHERE user_id=? AND role_id=?",
    [userId, role],
  );
  await qaD1(
    "UPDATE staff_principals SET status='disabled',updated_at=? WHERE user_id=? AND created_by_user_id=?",
    [new Date().toISOString(), userId, actor],
  );
  console.log("QA_REFUND_ROLE_REVOKED", "isolated_d1_only");
}
