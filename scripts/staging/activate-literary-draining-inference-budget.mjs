import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";

const account = "d26430caa63ec55f6612e32f36aca5e9";
const primary = "4bd657ac-8789-403e-a28c-93aba8d0a989";
const isolated = "400c3af3-5d40-41fd-83cc-98228e40ddac";
const qa = "fce5742c-29ca-4bc3-85da-e174dd9bf42e";
const name = "cove-literary-infer-draining-20261025";
assert.equal(process.env.CLOUDFLARE_ACCOUNT_ID, account);
assert.equal(process.env.GITHUB_REF, "refs/heads/main");
const token = process.env.CLOUDFLARE_API_TOKEN;
assert.ok(token, "Protected production token required");
const base = "https://api.cloudflare.com/client/v4/accounts/" + account;
async function api(method, path, payload) {
  const response = await fetch(base + path, {
    method,
    headers: {
      authorization: "Bearer " + token,
      ...(payload ? { "content-type": "application/json" } : {}),
    },
    ...(payload ? { body: JSON.stringify(payload) } : {}),
    signal: AbortSignal.timeout(30_000),
  });
  assert.ok(response.ok, "Cloudflare literary inference stage rejected " + response.status);
  const json = await response.json();
  assert.equal(json.success, true);
  return json.result;
}
async function query(db, sql) {
  const rows = await api("POST", "/d1/database/" + db + "/query", { sql });
  assert.ok(Array.isArray(rows) && rows.every((row) => row.success));
  return rows[0]?.results || [];
}
async function assertOwner() {
  const rows = await query(
    primary,
    "SELECT key,value FROM cove_runtime_config WHERE key IN " +
      "('literary_processing_owner','literary_budget_domain')",
  );
  assert.deepEqual(Object.fromEntries(rows.map((row) => [row.key, row.value])), {
    literary_budget_domain: "isolated",
    literary_processing_owner: "draining",
  });
}
await assertOwner();
const now = new Date();
const day = now.toISOString().slice(0, 10);
const [legacyLeases, ledger, staged, frontier, prepared, receipt] = await Promise.all([
  query(
    primary,
    "SELECT EXISTS(SELECT 1 FROM literary_profile_state WHERE id=1 AND " +
      "lease_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')) sweep," +
      " EXISTS(SELECT 1 FROM literary_profile_jobs WHERE status='running' AND " +
      "lease_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')) jobs",
  ),
  query(
    primary,
    "SELECT reserved_units,calls FROM literary_profile_budget WHERE day='" + day + "'",
  ),
  query(
    isolated,
    "SELECT c.status,c.original_reserved_units,c.original_calls," +
      "b.reserved_units,b.calls FROM literary_budget_cutover c JOIN literary_profile_budget b" +
      " ON b.day=c.day WHERE c.day='" +
      day +
      "'",
  ),
  query(isolated, "SELECT status FROM literary_legacy_reconcile_frontier WHERE id=1"),
  query(isolated, "SELECT COUNT(*) n FROM literary_prepare_jobs WHERE status='done'"),
  query(qa, "SELECT result FROM literary_qa_private_pub_receipts WHERE id=1"),
]);
assert.deepEqual(legacyLeases, [{ sweep: 0, jobs: 0 }]);
assert.ok(["armed", "complete"].includes(frontier[0]?.status));
assert.ok(prepared[0]?.n >= 2, "Live production EPUB preparation proof missing");
assert.equal(receipt[0]?.result, "passed");
const primaryUnits = Number(ledger[0]?.reserved_units || 0);
const primaryCalls = Number(ledger[0]?.calls || 0);
assert.ok(Number.isSafeInteger(primaryUnits) && primaryUnits >= 0);
assert.ok(Number.isSafeInteger(primaryCalls) && primaryCalls >= 0);
assert.ok(staged[0]?.status === "prepared" || staged[0]?.status === "active");
assert.ok(staged[0].original_reserved_units >= primaryUnits);
assert.ok(staged[0].original_calls >= primaryCalls);
assert.ok(staged[0].reserved_units >= primaryUnits);
assert.ok(staged[0].calls >= primaryCalls);
const today = new Date().toISOString().slice(0, 10);
assert.equal(today, day, "Budget day rolled over during authorization");
if (staged[0].status === "prepared") {
  const updated = await query(
    isolated,
    "UPDATE literary_budget_cutover SET status='active'," +
      "activated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE day='" +
      day +
      "' AND status='prepared' AND original_reserved_units>=" +
      primaryUnits +
      " AND original_calls>=" +
      primaryCalls +
      " AND EXISTS(SELECT 1 FROM literary_budget_domain_identity WHERE id=1" +
      " AND domain='cove-isolated-literary-budget' AND schema_version=1)" +
      " RETURNING day,status",
  );
  assert.deepEqual(updated, [{ day, status: "active" }]);
}
await assertOwner();
const cutover = await query(
  isolated,
  "SELECT day,status FROM literary_budget_cutover WHERE day='" + day + "'",
);
assert.deepEqual(cutover, [{ day, status: "active" }]);
const evidence = {
  schema: "cove.literary.real-ai.draining-budget.v1",
  day,
  activatedUtc: new Date().toISOString(),
  productionPrimaryBudgetFrozen: true,
  transferredUnitsAtLeast: primaryUnits,
  transferredCallsAtLeast: primaryCalls,
  noPrimaryPublication: true,
  active: true,
};
mkdirSync("artifacts/literary-cutover", { recursive: true });
writeFileSync(
  "artifacts/literary-cutover/draining-infer-budget.json",
  JSON.stringify(evidence, null, 2) + "\n",
);
console.log("LITERARY_REAL_AI_BUDGET_ACTIVE_PASS", JSON.stringify(evidence));
