import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const publisher = JSON.parse(
  readFileSync("wrangler.literary-publisher.stage-canary.jsonc", "utf8"),
);
const caller = JSON.parse(
  readFileSync("wrangler.literary-private-binding.stage-canary.jsonc", "utf8"),
);
const source = readFileSync("src/literary-private-binding-stage-canary.worker.ts", "utf8");
const script = readFileSync("scripts/staging/run-literary-service-binding-canary.mjs", "utf8");
const workflow = readFileSync(
  ".github/workflows/literary-private-binding-stage-canary.yml",
  "utf8",
);
const cleanup = readFileSync("scripts/staging/cleanup-literary-private-binding-canary.mjs", "utf8");
for (const config of [publisher, caller]) {
  assert.equal(config.account_id, "f51e8ccbc394e2d6016ff8c2c303d54b");
  assert.equal(config.workers_dev, false);
  assert.equal(config.preview_urls, false);
  assert.ok(!config.routes && !config.route && !config.triggers && !config.queues);
  assert.deepEqual(
    config.d1_databases.map((x) => x.database_id).sort(),
    ["2dd68956-06a6-4b21-b729-596b94744c6b", "d2c5673a-7497-4924-8b06-0be32f32555a"].sort(),
  );
  assert.deepEqual(
    config.r2_buckets.map((x) => x.bucket_name),
    ["cove-literary-synthetic-objects-qa"],
  );
}
assert.deepEqual(caller.services, [{ binding: "LITERARY_PUBLISHER", service: publisher.name }]);
assert.equal(publisher.vars.FORE_LITERARY_INFERENCE_PUBLISH_ENABLED, "1");
assert.equal(caller.vars.FORE_LITERARY_QA_ENABLED, "1");
for (const id of [
  "4bd657ac-8789-403e-a28c-93aba8d0a989",
  "400c3af3-5d40-41fd-83cc-98228e40ddac",
  "cove-production-media",
]) {
  assert.ok(!script.includes(id) && !source.includes(id), "Production authority in QA canary");
}
for (const term of [
  "runPrivateLiteraryBindingCanary",
  "result_sha256",
  "customMetadata: { sha256: artifact.result_sha256 }",
  "literary_qa_private_pub_receipts",
  "canonical.revision !== 1",
])
  assert.ok(source.includes(term), "Missing signed publisher QA check " + term);
assert.ok(script.includes("publication_state"), "Missing secondary publication receipt check");
assert.ok(workflow.includes("github.ref == 'refs/heads/main'"));
assert.ok(workflow.includes("needs: static-private-qa-contract"));
assert.ok(!workflow.includes("secrets.CLOUDFLARE_API_TOKEN"));
assert.ok(workflow.includes("secrets.COVE_CF_QA_WORKERS_DEPLOY_TOKEN"));
assert.ok(workflow.includes("secrets.COVE_CF_QA_D1_MUTATION_TOKEN"));
assert.ok(workflow.includes("certify-literary-remote-synthetic-journey.mjs"));
assert.ok(workflow.includes("persist-credentials: false"));
assert.ok(script.includes('await api("PUT", "/workers/scripts/" + caller + "/schedules", []);'));
assert.ok(script.includes("attempt < 72"), "QA cron propagation grace too short");
assert.ok(workflow.includes("if: always()"), "Failure must clear QA schedule");
assert.ok(cleanup.includes('await send("PUT", [])'), "Missing independent cleanup");
assert.ok(cleanup.includes("verified?.schedules?.length"), "Cleanup must be verified");
console.log(
  "LITERARY_PRIVATE_QA_SERVICE_CONTAINMENT_PASS stage-only, signed, no routes, cron cleanup",
);
