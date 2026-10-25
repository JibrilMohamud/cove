import assert from "node:assert/strict";
import {
  api,
  artifact,
  earlierInference,
  inferName,
  isolated,
  owner,
  primary,
  publisherName,
  query,
  secretNames,
  variables,
  worker,
} from "./literary-isolated-operator-lib.mjs";

assert.deepEqual(await owner(), {
  literary_budget_domain: "isolated",
  literary_processing_owner: "draining",
});
const day = new Date().toISOString().slice(0, 10);
const [lease, frontier, migration, budget, receipts, prepared, inferred, stage] = await Promise.all(
  [
    query(
      primary,
      "SELECT EXISTS(SELECT 1 FROM literary_profile_state WHERE id=1" +
        " AND lease_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')) sweep," +
        " EXISTS(SELECT 1 FROM literary_profile_jobs WHERE status='running'" +
        " AND lease_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')) jobs",
    ),
    query(
      isolated,
      "SELECT status,after_job_id FROM literary_legacy_reconcile_frontier WHERE id=1",
    ),
    query(isolated, "SELECT domain,schema_version FROM literary_budget_domain_identity WHERE id=1"),
    query(isolated, "SELECT status FROM literary_budget_cutover WHERE day='" + day + "'"),
    query(isolated, "SELECT COUNT(*) n FROM literary_legacy_reconcile_receipts"),
    query(isolated, "SELECT COUNT(*) n FROM literary_prepare_jobs WHERE status='done'"),
    query(
      isolated,
      "SELECT COUNT(*) n FROM literary_inference_jobs WHERE status='done'" +
        " AND publication_state='pending'",
    ),
    query(
      "fce5742c-29ca-4bc3-85da-e174dd9bf42e",
      "SELECT result FROM literary_qa_private_pub_receipts WHERE id=1",
    ),
  ],
);
assert.deepEqual(lease, [{ sweep: 0, jobs: 0 }]);
assert.ok(["armed", "complete"].includes(frontier[0]?.status));
assert.deepEqual(migration, [{ domain: "cove-isolated-literary-budget", schema_version: 1 }]);
assert.deepEqual(budget, [{ status: "active" }]);
assert.ok(receipts[0]?.n >= 16);
assert.ok(prepared[0]?.n >= 2);
assert.ok(inferred[0]?.n >= 1, "No real pending inference canary available");
assert.equal(stage[0]?.result, "passed", "Real Service Binding QA not certified");
const [publisher, inference, oldInference, handoff] = await Promise.all([
  worker(publisherName),
  worker(inferName),
  worker(earlierInference),
  worker("cove-literary-handoff-draining-20261025"),
]);
assert.deepEqual(publisher.schedule, []);
assert.deepEqual(inference.schedule, []);
assert.deepEqual(
  oldInference.schedule.map((x) => x.cron),
  ["* * * * *"],
);
assert.deepEqual(
  handoff.schedule.map((x) => x.cron),
  ["* * * * *"],
);
assert.equal(variables(publisher.bindings).FORE_LITERARY_INFERENCE_PUBLISH_ENABLED, "0");
assert.equal(variables(inference.bindings).FORE_CONTENT_PROCESSOR_ENABLED, "0");
const pubNames = secretNames(publisher.bindings);
const infNames = secretNames(inference.bindings);
for (const key of [
  "FORE_LITERARY_INFERENCE_PUBLISH_TOKEN_SHA256",
  "FORE_LITERARY_INFERENCE_BACKEND_TOKEN_SHA256",
])
  assert.ok(pubNames.has(key), "Missing publisher credential name");
for (const key of [
  "FORE_LITERARY_INFERENCE_PUBLISH_TOKEN",
  "FORE_LITERARY_INFERENCE_BACKEND_TOKEN",
])
  assert.ok(infNames.has(key), "Missing caller credential name");
assert.ok(
  inference.bindings.some(
    (x) => x.type === "service" && x.name === "LITERARY_PUBLISHER" && x.service === publisherName,
  ),
);
const evidence = {
  schema: "cove.literary.progressive-publication-preflight.v1",
  asOf: new Date().toISOString(),
  owner: "draining",
  dailyBudgetActive: true,
  pendingRealInference: inferred[0].n,
  preparedEvidence: prepared[0].n,
  reconciled: receipts[0].n,
  publisherSecretsBound: true,
  callerSecretsBound: true,
  existingHandoffScheduled: true,
};
artifact("isolated-publication-preflight.json", evidence);
console.log("LITERARY_ISOLATED_PUBLICATION_PREFLIGHT_PASS", JSON.stringify(evidence));
