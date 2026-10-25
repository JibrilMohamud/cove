import assert from "node:assert/strict";
import {
  artifact, isolated, owner, primary, query, worker,
} from "./literary-isolated-operator-lib.mjs";

assert.deepEqual(await owner(), {
  literary_budget_domain: "isolated",
  literary_processing_owner: "draining",
});
const day = new Date().toISOString().slice(0, 10);
const [budget, prepared, pending, frontier, leases] = await Promise.all([
  query(isolated, "SELECT status FROM literary_budget_cutover WHERE day='" + day + "'"),
  query(isolated, "SELECT COUNT(*) n FROM literary_prepare_jobs WHERE status='done'"),
  query(
    isolated,
    "SELECT COUNT(*) n FROM literary_inference_jobs WHERE status='done'" +
      " AND publication_state='pending'",
  ),
  query(isolated, "SELECT status FROM literary_legacy_reconcile_frontier WHERE id=1"),
  query(
    primary,
    "SELECT EXISTS(SELECT 1 FROM literary_profile_state WHERE id=1" +
      " AND lease_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')) sweep," +
      " EXISTS(SELECT 1 FROM literary_profile_jobs WHERE status='running'" +
      " AND lease_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')) jobs",
  ),
]);
assert.deepEqual(budget, [{ status: "active" }]);
assert.ok(prepared[0]?.n >= 2);
assert.ok(pending[0]?.n >= 1);
assert.ok(["armed", "complete"].includes(frontier[0]?.status));
assert.deepEqual(leases, [{ sweep: 0, jobs: 0 }]);
const start = await query(
  primary,
  "UPDATE cove_runtime_config SET value='isolated'," +
    "updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')" +
    " WHERE key='literary_processing_owner' AND value='draining' RETURNING value",
);
assert.deepEqual(start, [{ value: "isolated" }]);
assert.deepEqual(await owner(), {
  literary_budget_domain: "isolated",
  literary_processing_owner: "isolated",
});
artifact("owner-isolated-promotion.json", {
  schema: "cove.literary.real-publication-promotion.v1",
  when: new Date().toISOString(),
  owner: "isolated",
  budgetDomain: "isolated",
  previousFrontier: frontier[0]?.status,
  pendingInference: pending[0].n,
  customerPublication: "Awaiting verified callback",
});
console.log("LITERARY_ISOLATED_OWNER_PROMOTED_PASS awaiting guarded publication");
