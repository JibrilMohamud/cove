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
    /async scheduled\(\s*controller:/,
    "The backend must retain its scheduled handler",
  );
  assert.match(
    backendWorker,
    /scheduleBackendOwnedWork\(controller, env, ctx\)/,
    "The retained native schedule entrypoint must invoke the extracted business helper",
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
    biosyncWorkflow.includes(
      "BIOSYNC_AUTO_SHORT=1 python3 -m scripts.audio_pipeline.biosync_canary",
    ) &&
      biosyncWorkflow.includes(
        "BIOSYNC_AUTO_SHORT=0 BIOSYNC_PROVE_OWNER_REPLAY=1 python3 -m scripts.audio_pipeline.biosync_canary",
      ) &&
      biosyncWorkflow.includes("grep -Fx cove_biosync_production_owner_replay_verified") &&
      biosyncWorkflow.includes("set -euo pipefail"),
    "Preserve autonomous discovery and real owner replay",
  );
  assert.ok(
    biosyncWorkflow.includes("environment: cove-production-release-audit") &&
      biosyncWorkflow.includes('COVE_BIOSYNC_PROD_OWNER_MODE: "1"') &&
      [
        "COVE_BIOSYNC_PROD_D1_READ_TOKEN",
        "COVE_BIOSYNC_PROD_R2_TOKEN",
        "COVE_BIOSYNC_PROD_CLIENT_SECRET",
      ].every((name) => biosyncWorkflow.includes(name + ": ${{ secrets." + name + " }}")) &&
      !biosyncWorkflow.includes("CLOUDFLARE_API_TOKEN"),
    "Hourly producer must use the three scoped credentials and no legacy token",
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
      biosyncCanary.includes("owner_transport.commit(EDITION, TRACK, JOB, map_sha)") &&
      !biosyncCanary.includes("CLOUDFLARE_API_TOKEN") &&
      !/\b(?:INSERT INTO|UPDATE|DELETE FROM)\s+audio_(?:jobs|timing)\b/i.test(biosyncCanary),
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
    {
      backendWorker: actual.backendWorker.replace(
        "scheduleBackendOwnedWork(controller, env, ctx)",
        "undefined",
      ),
    },
    { backendConfig: actual.backendConfig.replace('"41 4 * * *"', '"0 4 * * *"') },
    { backendConfig: actual.backendConfig.replace('binding = "DB"', 'binding = "QA_DB"') },
    {
      backendWorker: actual.backendWorker.replace(
        "runScheduled(controller.cron, env)",
        "undefined",
      ),
    },
    {
      backendWorker: actual.backendWorker.replace(
        "runCommercialQueues(controller.cron, env)",
        "undefined",
      ),
    },
    { biosyncWorkflow: actual.biosyncWorkflow.replace("  schedule:", "  # schedule:") },
    {
      biosyncWorkflow: actual.biosyncWorkflow.replace(
        "name: biosync-production-canary",
        "name: biosync-owner-qa-protected",
      ),
    },
    {
      biosyncWorkflow: actual.biosyncWorkflow.replace(
        "python3 -m scripts.audio_pipeline.biosync_canary",
        "python3 -m scripts.audio_pipeline.biosync_owner_qa",
      ),
    },
    {
      biosyncWorkflow: actual.biosyncWorkflow.replace("BIOSYNC_AUTO_SHORT=1", "BIOSYNC_QA_ONLY=1"),
    },
    {
      biosyncWorkflow: actual.biosyncWorkflow.replace(
        "COVE_BIOSYNC_PROD_D1_READ_TOKEN:",
        "COVE_FAKE_TOKEN:",
      ),
    },
    {
      biosyncCanary: actual.biosyncCanary.replace(
        'DATABASE = "4bd657ac-8789-403e-a28c-93aba8d0a989"',
        'DATABASE = "4e17ba6f-444f-4245-801a-a7d4969045b0"',
      ),
    },
    {
      biosyncCanary: actual.biosyncCanary.replace(
        "owner_transport.commit(EDITION, TRACK, JOB, map_sha)",
        "QA-only",
      ),
    },
    { biosyncWorkflow: actual.biosyncWorkflow + "\n# CLOUDFLARE_API_TOKEN" },
    { biosyncCanary: actual.biosyncCanary + "\n# UPDATE audio_jobs SET status='done'" },
  ];
  for (const [index, patch] of negative.entries()) {
    assert.throws(
      () => verifyScheduledProductionContinuity({ ...actual, ...patch }),
      undefined,
      "Missing negative continuity detection at case " + index,
    );
  }
  console.log("PASS: thirteen scheduler, credential and binding regression attempts are rejected");
}
console.log(
  "PASS: source retains " +
    accepted.backendCronCount +
    " backend schedules and hourly production BioSync (not a deployment certification)",
);
