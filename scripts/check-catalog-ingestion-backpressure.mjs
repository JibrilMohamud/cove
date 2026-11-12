import assert from "node:assert/strict";
import fs from "node:fs";
import { transform } from "esbuild";

const helperSource = fs.readFileSync("src/lib/catalog-ingestion-backpressure.ts", "utf8");
const workerSource = fs.readFileSync("src/persistence-backend.worker.ts", "utf8");
const { code } = await transform(helperSource, { loader: "ts", format: "esm" });
const { admitCatalogBatch, catalogAdmissionBudget } = await import(
  "data:text/javascript;base64," + Buffer.from(code).toString("base64")
);

assert.equal(catalogAdmissionBudget(undefined), 300);
assert.equal(catalogAdmissionBudget("0"), 300);
assert.equal(catalogAdmissionBudget("20"), 100);
assert.equal(catalogAdmissionBudget("50000"), 1000);
assert.equal(catalogAdmissionBudget("400"), 400);

let current = 0;
const clock = () => current;
const queries = [];
function db(result, elapsed, error) {
  return {
    prepare(sql) {
      assert.equal(sql, "SELECT 1 AS ok", "Admission must be a read-only primary D1 probe");
      queries.push(sql);
      return {
        async first() {
          current += elapsed;
          if (error) throw Error("D1 unavailable");
          return result;
        },
      };
    },
  };
}
const healthy = await admitCatalogBatch(db({ ok: 1 }, 40), 300, clock);
assert.deepEqual(healthy, { allowed: true, reason: "healthy", probeMs: 40 });
const busy = await admitCatalogBatch(db({ ok: 1 }, 420), 300, clock);
assert.deepEqual(busy, { allowed: false, reason: "primary_busy", probeMs: 420 });
const unavailable = await admitCatalogBatch(db(null, 2), 300, clock);
assert.deepEqual(unavailable, { allowed: false, reason: "primary_unavailable", probeMs: 2 });
const thrown = await admitCatalogBatch(db(null, 1, true), 300, clock);
assert.deepEqual(thrown, { allowed: false, reason: "primary_unavailable", probeMs: 1 });
assert.equal(queries.length, 4);

const batchStart = workerSource.indexOf("async function catalogBatch(");
const batchEnd = workerSource.indexOf("\nasync function maintenance(", batchStart);
assert.ok(batchStart >= 0 && batchEnd > batchStart);
const batch = workerSource.slice(batchStart, batchEnd);
// Explicitly preserve rights-bearing catalog and regional import execution.
// Admission is allowed only AFTER those stages and EPUB maintenance.
const gateAt = batch.indexOf("const admission = await admitCatalogBatch(");
assert.ok(gateAt > batch.indexOf("runCatalogIngestion(env"));
assert.ok(gateAt > batch.indexOf("runRegionalCatalogIngestion(env"));
assert.ok(gateAt > batch.indexOf("runCatalogAssetMaintenance(env"));
assert.ok(gateAt < batch.indexOf("syncSearchIndex(env"));
assert.match(batch, /searchSync = \{/);
assert.match(batch, /skipped: "primary_busy"/);
assert.match(batch, /\.\.\.\(searchSync \? \{ searchSync \} : \{\}\)/);
assert.doesNotMatch(batch, /checkPrimaryBeforeBulkWork/);
// Bounded primary pressure gates may defer ONLY genuinely retryable work.
const minuteStart = workerSource.indexOf('if (cron === "* * * * *")');
const minuteEnd = workerSource.indexOf('if (cron === "*/5 * * * *")', minuteStart);
assert.ok(minuteStart >= 0 && minuteEnd > minuteStart);
const minute = workerSource.slice(minuteStart, minuteEnd);
assert.ok(minute.indexOf("const admission = await admitCatalogBatch(") >= 0);
assert.ok(minute.indexOf("if (!admission.allowed)") > minute.indexOf("const admission ="));
for (const retryable of [
  "runStoredAssetTick(env)",
  "verifyAudioStorage(env)",
  "runLiteraryProfileTick(env)",
  "seedMusicProfiles(env)",
])
  assert.ok(minute.indexOf(retryable) > minute.indexOf("if (!admission.allowed)"));
assert.ok(minute.includes("optional_minute_maintenance_deferred"));
const canonicalStart = workerSource.indexOf('if (cron === "*/5 * * * *")');
const canonicalEnd = workerSource.indexOf('if (cron === "2-59/5 * * * *")', canonicalStart);
assert.ok(canonicalStart >= 0 && canonicalEnd > canonicalStart);
const canonical = workerSource.slice(canonicalStart, canonicalEnd);
assert.ok(canonical.includes("scheduledCatalog(env)"));
assert.doesNotMatch(canonical, /admitCatalogBatch\(/);
assert.equal(
  (workerSource.match(/await admitCatalogBatch\(/g) || []).length,
  3,
  "Only derived search sync, operator-only EPUB repair and deferrable minute work may probe D1",
);
// The ten-minute published-rights audit remains prompt. Only deferrable
// soundtrack acquisition and audio discovery move away from required five-minute
// rights/catalog ingestion. Customer queues and tournament advancement stay put.
const scheduler = workerSource.slice(workerSource.indexOf("async function runScheduled("));
const publishedStart = scheduler.indexOf('if (cron === "*/10 * * * *")');
const optionalStart = scheduler.indexOf('if (cron === "7-57/10 * * * *")');
const hourlyStart = scheduler.indexOf('if (cron === "23 * * * *")');
assert.ok(publishedStart >= 0 && optionalStart > publishedStart && hourlyStart > optionalStart);
const rightsAudit = scheduler.slice(publishedStart, optionalStart);
const optionalDiscovery = scheduler.slice(optionalStart, hourlyStart);
assert.match(rightsAudit, /recheckOnePublishedSoundtrack\(env\)/);
assert.doesNotMatch(
  rightsAudit,
  /discoverSoundtrackCandidates|importOneReviewedSoundtrack|audio-discover/,
);
assert.match(optionalDiscovery, /discoverSoundtrackCandidates\(env\)/);
assert.match(optionalDiscovery, /importOneReviewedSoundtrack\(env\)/);
assert.match(optionalDiscovery, /audio-discover/);
assert.doesNotMatch(optionalDiscovery, /recheckOnePublishedSoundtrack\(env\)/);
const commercial = workerSource.slice(
  workerSource.indexOf("async function runCommercialQueues("),
  workerSource.indexOf("async function scheduledMaintenance("),
);
assert.match(commercial, /if \(cron === "\*\/10 \* \* \* \*"\)/);
const entrypoint = workerSource.slice(
  workerSource.indexOf("  async scheduled("),
  workerSource.indexOf("  async fetch(", workerSource.indexOf("  async scheduled(")),
);
assert.match(entrypoint, /controller\.cron === "\*\/10 \* \* \* \*"/);
for (const configPath of [
  "wrangler.backend.production.toml",
  ".github/workflows/deploy-persistence-backend.yml",
]) {
  const config = fs.readFileSync(configPath, "utf8");
  assert.match(config, /"\*\/5 \* \* \* \*", "\*\/10 \* \* \* \*", "7-57\/10 \* \* \* \*"/);
}
// Production cron-only and backend code pushes must never silently re-run
// primary D1 migrations. Schema migration remains an explicit dispatch.
const migrationWorkflow = fs.readFileSync(
  ".github/workflows/deploy-persistence-backend.yml",
  "utf8",
);
const migrationGuard = migrationWorkflow.slice(
  migrationWorkflow.indexOf("- name: Apply pending D1 migrations"),
  migrationWorkflow.indexOf("- name: Verify exact disabled production owner"),
);
assert.ok(migrationGuard.startsWith("- name: Apply pending D1 migrations"));
assert.match(migrationGuard, /github\.event_name == 'workflow_dispatch'/);
assert.match(migrationGuard, /inputs\.apply_migrations == true/);
assert.doesNotMatch(migrationGuard, /github\.event_name == 'push'/);
console.log(
  "Derived-search and minute maintenance admission: safe canonical rights ingestion, bounded retryable deferral PASS",
);
