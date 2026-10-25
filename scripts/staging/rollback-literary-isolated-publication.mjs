import assert from "node:assert/strict";
import {
  api, artifact, earlierInference, inferName, isolated, owner,
  primary, query, worker,
} from "./literary-isolated-operator-lib.mjs";

// Rolling back customer literary *publication* must not revert isolated
// inference budget spending or delete already-verified canonical profiles.
const before = await owner();
assert.equal(before.literary_budget_domain, "isolated");
if (before.literary_processing_owner === "isolated") {
  const row = await query(
    primary,
    "UPDATE cove_runtime_config SET value='draining'," +
      "updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')" +
      " WHERE key='literary_processing_owner' AND value='isolated' RETURNING value",
  );
  assert.deepEqual(row, [{ value: "draining" }]);
}
assert.deepEqual(await owner(), {
  literary_budget_domain: "isolated",
  literary_processing_owner: "draining",
});
await api("PUT", "/workers/scripts/" + inferName + "/schedules", []);
assert.deepEqual((await worker(inferName)).schedule, []);
// Return to the previously certified private isolated-inference-only Worker,
// with no caller publisher credentials and with autopublish disabled.
await api(
  "PUT",
  "/workers/scripts/" + earlierInference + "/schedules",
  [{ cron: "* * * * *" }],
);
assert.deepEqual(
  (await worker(earlierInference)).schedule.map((x) => x.cron),
  ["* * * * *"],
);
const status = await query(
  isolated,
  "SELECT status FROM literary_budget_cutover WHERE day='" +
    new Date().toISOString().slice(0, 10) + "'",
);
assert.deepEqual(status, [{ status: "active" }]);
artifact("isolated-publication-rollback.json", {
  schema: "cove.literary.real-publication-rollback.v1",
  at: new Date().toISOString(),
  owner: "draining",
  budgetDomain: "isolated",
  currentDayCutover: "active",
  noSharedMaintenanceCronModified: true,
  oldPrivateInferenceRestored: true,
  failedPublicationCronStopped: true,
});
console.log("LITERARY_REAL_PUBLICATION_ROLLBACK_PASS");
