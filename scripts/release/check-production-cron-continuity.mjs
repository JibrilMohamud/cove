import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const expectedBackendCrons = [
  "* * * * *",
  "*/5 * * * *",
  "*/10 * * * *",
  "7-57/10 * * * *",
  "23 * * * *",
  "17 3 * * *",
  "41 4 * * *",
];

/** Source-only continuity guard, not a production deployment or rights proof.
 * A verified owner cutover may update this guard with independently reviewed
 * replacement schedules, deployed versions, legitimate writes and rollback. */
export function verifyScheduledProductionContinuity({
  backendConfig,
  backendWorker,
  biosyncWorkflow,
  biosyncCanary,
}) {
  const schedules = /^crons = (\[[^\n]+\])$/m.exec(backendConfig);
  assert.ok(schedules, "Production backend must declare its exact cron schedule");
  // Until a protected owner-only read route is proven, the backend requires
  // its existing primary DB binding for legitimate customer/catalog reads.
  assert.ok(
    backendConfig.includes('binding = "DB"') &&
      backendConfig.includes('database_name = "cove-production"') &&
      backendConfig.includes('database_id = "4bd657ac-8789-403e-a28c-93aba8d0a989"'),
    "Direct backend reads cannot be disconnected before a proven replacement",
  );
  const observed = JSON.parse(schedules[1]);
  assert.deepEqual(
    observed,
    expectedBackendCrons,
    "Production backend crons were removed, reordered or silently altered",
  );
  assert.match(
    backendWorker,
    /async scheduled\(controller:/,
    "The backend must retain its scheduled handler",
  );
  assert.match(backendWorker, /runScheduled\(controller\.cron, env\)/);
  assert.match(backendWorker, /runCommercialQueues\(controller\.cron, env\)/);
  assert.ok(
    biosyncWorkflow.startsWith("name: biosync-production-canary\n"),
    "The live BioSync producer must not be replaced by the QA-only job",
  );
  assert.ok(
    biosyncWorkflow.includes("  schedule:\n    - cron: '42 * * * *'"),
    "The existing hourly BioSync production trigger must remain active",
  );
  assert.ok(
    biosyncWorkflow.includes("BIOSYNC_AUTO_SHORT: ${{ github.event_name == 'schedule' && '1' || '0' }}"),
    "The hourly canary must retain autonomous queued-short-track discovery",
  );
  assert.ok(
    biosyncWorkflow.includes("python3 -m scripts.audio_pipeline.biosync_canary"),
    "The live schedule must continue invoking the production canary",
  );
  // Deliberately retain the existing execution principal until a tested
  // owner-transport replacement can safely remove it. This is not permission
  // to keep the broad credential after completed cutover.
  assert.ok(
    biosyncWorkflow.includes("CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}"),
    "The legacy producer credential cannot disappear before owner replacement",
  );
  assert.ok(
    biosyncCanary.includes('ACCOUNT = "d26430caa63ec55f6612e32f36aca5e9"') &&
      biosyncCanary.includes('DATABASE = "4bd657ac-8789-403e-a28c-93aba8d0a989"') &&
      biosyncCanary.includes('BUCKET = "cove-production-media"'),
    "A QA-only or wrong-account BioSync client cannot substitute for live publishing",
  );
  assert.ok(
    biosyncCanary.includes("def choose_queued_short_track()") &&
      biosyncCanary.includes("def main()") &&
      biosyncCanary.includes("UPDATE audio_jobs SET status='done'"),
    "The production canary must still perform its real scheduled duties",
  );
  return { backendCronCount: observed.length, hourlyBioSync: true };
}

function loadSources() {
  return {
    backendConfig: readFileSync("wrangler.backend.production.toml", "utf8"),
    backendWorker: readFileSync("src/persistence-backend.worker.ts", "utf8"),
    biosyncWorkflow: readFileSync(".github/workflows/biosync-canary.yml", "utf8"),
    biosyncCanary: readFileSync("scripts/audio_pipeline/biosync_canary.py", "utf8"),
  };
}

const actual = loadSources();
const accepted = verifyScheduledProductionContinuity(actual);
if (process.argv.includes("--self-test")) {
  const negative = [
    { backendConfig: actual.backendConfig.replace('"41 4 * * *"', '"0 4 * * *"') },
    { backendConfig: actual.backendConfig.replace('binding = "DB"', 'binding = "QA_DB"') },
    { backendWorker: actual.backendWorker.replace("runScheduled(controller.cron, env)", "undefined") },
    { backendWorker: actual.backendWorker.replace("runCommercialQueues(controller.cron, env)", "undefined") },
    { biosyncWorkflow: actual.biosyncWorkflow.replace("  schedule:", "  # schedule:") },
    { biosyncWorkflow: actual.biosyncWorkflow.replace("name: biosync-production-canary", "name: biosync-owner-qa-protected") },
    { biosyncWorkflow: actual.biosyncWorkflow.replace("python3 -m scripts.audio_pipeline.biosync_canary", "python3 -m scripts.audio_pipeline.biosync_owner_qa") },
    { biosyncWorkflow: actual.biosyncWorkflow.replace("BIOSYNC_AUTO_SHORT:", "BIOSYNC_QA_ONLY:") },
    { biosyncWorkflow: actual.biosyncWorkflow.replace("CLOUDFLARE_API_TOKEN:", "COVE_FAKE_TOKEN:") },
    { biosyncCanary: actual.biosyncCanary.replace('DATABASE = "4bd657ac-8789-403e-a28c-93aba8d0a989"', 'DATABASE = "4e17ba6f-444f-4245-801a-a7d4969045b0"') },
    { biosyncCanary: actual.biosyncCanary.replace("UPDATE audio_jobs SET status='done'", "QA-only") },
  ];
  for (const [index, patch] of negative.entries()) {
    assert.throws(
      () => verifyScheduledProductionContinuity({ ...actual, ...patch }),
      undefined,
      "Missing negative continuity detection at case " + index,
    );
  }
  console.log("PASS: eleven scheduler, credential and binding removal attempts are rejected");
}
console.log(
  "PASS: source retains " +
    accepted.backendCronCount +
    " backend schedules and hourly production BioSync (not a deployment certification)",
);
