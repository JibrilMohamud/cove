import assert from "node:assert/strict";
import {
  api, earlierInference, inferName, owner, publisherName,
  secretNames, variables, worker,
} from "./literary-isolated-operator-lib.mjs";

assert.equal((await owner()).literary_processing_owner, "draining");
const pub = await worker(publisherName);
assert.deepEqual(pub.schedule, []);
assert.equal(variables(pub.bindings).FORE_LITERARY_INFERENCE_PUBLISH_ENABLED, "1");
for (const key of [
  "FORE_LITERARY_INFERENCE_PUBLISH_TOKEN_SHA256",
  "FORE_LITERARY_INFERENCE_BACKEND_TOKEN_SHA256",
]) assert.ok(secretNames(pub.bindings).has(key), "Publisher secret lost during deployment");

const former = await worker(earlierInference);
assert.deepEqual(former.schedule.map((x) => x.cron), ["* * * * *"]);
await api("PUT", "/workers/scripts/" + earlierInference + "/schedules", []);
const verified = await worker(earlierInference);
assert.deepEqual(verified.schedule, [], "Previous inference cron was not removed");
const next = await worker(inferName);
assert.deepEqual(next.schedule, [], "New inference started before prior was fenced");
console.log("LITERARY_PRIOR_INFER_FENCED_PASS publication still denied in draining");
