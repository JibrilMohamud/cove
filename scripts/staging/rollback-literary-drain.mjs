import assert from "node:assert/strict";
import {
  api,
  content,
  evidenceFile,
  owner,
  primary,
  query,
  roles,
} from "./literary-drain-operator-lib.mjs";

const state = await owner();
assert.notEqual(state.literary, "isolated", "Do not roll back already published isolated work");
const day = new Date().toISOString().slice(0, 10);
const cutover = await query(
  content,
  "SELECT status FROM literary_budget_cutover WHERE day='" + day + "'",
);
assert.notEqual(cutover[0]?.status, "active", "Cannot restore primary budget after isolated debit");
const details = [];
// Canonical owner must be fenced first, so no new secondary claims can start.
if (state.literary === "draining") {
  const x = await query(
    primary,
    "UPDATE cove_runtime_config SET value='legacy',updated_at=" +
      "strftime('%Y-%m-%dT%H:%M:%fZ','now')" +
      " WHERE key='literary_processing_owner' AND value='draining' RETURNING value",
  );
  assert.deepEqual(x, [{ value: "legacy" }]);
  details.push("canonical_legacy_restored");
}
// The secondary frontier can preserve cursor/receipts for a future replay,
// but no reconciliation is permitted while rollback is in effect.
await query(
  content,
  "UPDATE literary_legacy_reconcile_frontier SET status='disarmed'," +
    "updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')" +
    " WHERE id=1 AND status='armed'",
);
if (state.budget === "isolated") {
  const x = await query(
    primary,
    "UPDATE cove_runtime_config SET value='primary'," +
      "updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')" +
      " WHERE key='literary_budget_domain' AND value='isolated' RETURNING value",
  );
  assert.deepEqual(x, [{ value: "primary" }]);
  details.push("primary_budget_restored_before_any_isolated_spend");
}
for (const name of roles) {
  await api("PUT", "/workers/scripts/" + name + "/schedules", []);
  const stopped = await api("GET", "/workers/scripts/" + name + "/schedules");
  assert.equal(stopped.schedules?.length, 0);
  details.push("cron_removed:" + name);
}
const confirmed = await owner();
assert.deepEqual(confirmed, { literary: "legacy", budget: "primary" });
const e = {
  schema: "cove.literary.draining.rollback.v1",
  at: new Date().toISOString(),
  restored: confirmed,
  budgetCutoverStatus: cutover[0]?.status || "missing",
  operations: details,
};
evidenceFile("draining-rollback.json", e);
console.log("LITERARY_DRAIN_ROLLBACK_PASS", JSON.stringify(e));
