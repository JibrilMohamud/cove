import assert from "node:assert/strict";
import {
  earlierInference, inferName, isolated, owner, primary, publisherName,
  query, secretNames, variables, worker,
} from "./literary-isolated-operator-lib.mjs";

assert.deepEqual(await owner(), {
  literary_budget_domain: "isolated",
  literary_processing_owner: "draining",
});
const [pub, next, former, handoff, budget] = await Promise.all([
  worker(publisherName),
  worker(inferName),
  worker(earlierInference),
  worker("cove-literary-handoff-draining-20261025"),
  query(
    isolated,
    "SELECT status FROM literary_budget_cutover WHERE day='" +
      new Date().toISOString().slice(0, 10) + "'",
  ),
]);
assert.deepEqual(budget, [{ status: "active" }]);
assert.deepEqual(former.schedule, []);
assert.deepEqual(pub.schedule, []);
assert.deepEqual(next.schedule.map((x) => x.cron), ["* * * * *"]);
assert.deepEqual(handoff.schedule.map((x) => x.cron), ["* * * * *"]);
const pubVars = variables(pub.bindings);
const infVars = variables(next.bindings);
assert.equal(pubVars.FORE_LITERARY_INFERENCE_PUBLISH_ENABLED, "1");
for (const name of [
  "FORE_CONTENT_PROCESSOR_ENABLED",
  "FORE_CONTENT_PREPARE_ENABLED",
  "FORE_CONTENT_INFERENCE_ENABLED",
  "FORE_LITERARY_AUTOPUBLISH_ENABLED",
]) assert.equal(infVars[name], "1");
assert.equal(infVars.FORE_CONTENT_BUDGET_MODE, "isolated");
assert.equal(infVars.FORE_CONTENT_D1_ADMISSION_MAX_MS, "100");
const pubNames = secretNames(pub.bindings);
const infNames = secretNames(next.bindings);
for (const key of [
  "FORE_LITERARY_INFERENCE_PUBLISH_TOKEN_SHA256",
  "FORE_LITERARY_INFERENCE_BACKEND_TOKEN_SHA256",
]) assert.ok(pubNames.has(key));
for (const key of [
  "FORE_LITERARY_INFERENCE_PUBLISH_TOKEN",
  "FORE_LITERARY_INFERENCE_BACKEND_TOKEN",
]) assert.ok(infNames.has(key));
assert.ok(
  next.bindings.some(
    (x) => x.type === "service" && x.name === "LITERARY_PUBLISHER" &&
      x.service === publisherName,
  ),
);
assert.deepEqual(
  next.bindings.filter((x) => x.type === "d1").map((x) => x.database_id).sort(),
  [primary, isolated].sort(),
);
console.log("LITERARY_PRIVATE_PUBLICATION_TOPOLOGY_PASS credentials preserved, no ingress");
