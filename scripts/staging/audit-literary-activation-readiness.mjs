import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";

const account = "d26430caa63ec55f6612e32f36aca5e9";
const primary = "4bd657ac-8789-403e-a28c-93aba8d0a989";
const isolated = "400c3af3-5d40-41fd-83cc-98228e40ddac";
const bucket = "cove-literary-originals-isolated-20261024";
const token = process.env.CLOUDFLARE_API_TOKEN;
assert.equal(process.env.CLOUDFLARE_ACCOUNT_ID, account);
assert.ok(token, "Protected Cloudflare credentials required");
const base = "https://api.cloudflare.com/client/v4/accounts/" + account;
async function api(method, path, body) {
  const res = await fetch(base + path, {
    method,
    headers: {
      authorization: "Bearer " + token,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(30000),
  });
  assert.ok(res.ok, "Read-only Cloudflare request rejected " + res.status);
  const data = await res.json();
  assert.equal(data.success, true);
  return data.result;
}
async function query(database, sql) {
  // Do not allow script edits to make this live audit mutating.
  assert.match(sql.trim(), /^(SELECT|PRAGMA|EXPLAIN|WITH)\b/i);
  assert.doesNotMatch(sql, /\b(?:INSERT|UPDATE|DELETE|ALTER|DROP|CREATE|REPLACE|ATTACH)\b/i);
  const result = await api("POST", "/d1/database/" + database + "/query", { sql });
  assert.ok(Array.isArray(result) && result.every((part) => part.success));
  return result[0]?.results || [];
}
const now = new Date();
const day = now.toISOString().slice(0, 10);
const [
  owner,
  legacyBudget,
  legacyLeases,
  unfinished,
  frontier,
  identity,
  isolatedBudget,
  isolatedCutover,
  newColumns,
  newIndexes,
  jobs,
] = await Promise.all([
  query(
    primary,
    "SELECT key,value FROM cove_runtime_config WHERE key IN ('literary_processing_owner','literary_budget_domain')",
  ),
  query(
    primary,
    "SELECT day,reserved_units,calls FROM literary_profile_budget WHERE day='" + day + "'",
  ),
  query(primary, "SELECT lease_until,last_run_at FROM literary_profile_state WHERE id=1"),
  query(
    primary,
    "SELECT status,COUNT(*) AS n FROM literary_profile_jobs WHERE status IN ('queued','failed','running') GROUP BY status",
  ),
  query(isolated, "SELECT status,after_job_id FROM literary_legacy_reconcile_frontier WHERE id=1"),
  query(isolated, "SELECT domain,schema_version FROM literary_budget_domain_identity WHERE id=1"),
  query(
    isolated,
    "SELECT day,reserved_units,calls FROM literary_profile_budget WHERE day='" + day + "'",
  ),
  query(
    isolated,
    "SELECT day,status,original_reserved_units,original_calls FROM literary_budget_cutover WHERE day='" +
      day +
      "'",
  ),
  query(isolated, "PRAGMA table_info(literary_inference_jobs)"),
  query(
    isolated,
    "SELECT name FROM sqlite_master WHERE type='index' AND name IN ('idx_literary_inference_publication_due','idx_literary_inference_publication_expired')",
  ),
  query(isolated, "SELECT status,COUNT(*) AS n FROM literary_inference_jobs GROUP BY status"),
]);
const config = Object.fromEntries(owner.map((x) => [x.key, x.value]));
const blockers = [];
const workerEvidence = [];
const roles = [
  [
    "cove-literary-handoff-isolated-disabled",
    "literary-handoff",
    [
      "FORE_CONTENT_PROCESSOR_ENABLED",
      "FORE_CONTENT_PREPARE_ENABLED",
      "FORE_CONTENT_HANDOFF_ENABLED",
      "FORE_LITERARY_DRAIN_RECONCILE_ENABLED",
    ],
  ],
  [
    "cove-literary-prepare-isolated-disabled",
    "literary-prepare",
    ["FORE_CONTENT_PROCESSOR_ENABLED", "FORE_CONTENT_PREPARE_ENABLED"],
  ],
  [
    "cove-literary-infer-isolated-disabled",
    "literary-infer",
    [
      "FORE_CONTENT_PROCESSOR_ENABLED",
      "FORE_CONTENT_PREPARE_ENABLED",
      "FORE_CONTENT_INFERENCE_ENABLED",
      "FORE_LITERARY_AUTOPUBLISH_ENABLED",
    ],
  ],
  [
    "cove-literary-publisher-isolated-disabled",
    "publisher",
    ["FORE_LITERARY_INFERENCE_PUBLISH_ENABLED"],
  ],
];
for (const [name, role, flags] of roles) {
  const root = "/workers/scripts/" + name;
  const [settings, schedules, worker, deployed] = await Promise.all([
    api("GET", root + "/settings"),
    api("GET", root + "/schedules"),
    api("GET", "/workers/workers/" + name),
    api("GET", root + "/deployments"),
  ]);
  const bindings = settings.bindings || [];
  const values = Object.fromEntries(
    bindings.filter((b) => b.type === "plain_text").map((b) => [b.name, b.text]),
  );
  const dbs = bindings.filter((b) => b.type === "d1").map((b) => b.database_id);
  const r2 = bindings.filter((b) => b.type === "r2_bucket").map((b) => b.bucket_name);
  const disabled = flags.every((f) => values[f] === "0");
  const privateIngress =
    schedules.schedules.length === 0 &&
    (settings.routes || []).length === 0 &&
    worker.subdomain?.enabled === false &&
    worker.subdomain?.previews_enabled === false;
  const separate = dbs.length === 2 && dbs.includes(primary) && dbs.includes(isolated);
  const privateR2 = r2.length === 1 && r2[0] === bucket;
  if (!disabled) blockers.push(role + "_execution_switch_not_disabled");
  if (!privateIngress) blockers.push(role + "_public_ingress_or_schedule");
  if (!separate || !privateR2) blockers.push(role + "_data_plane_binding_mismatch");
  const service =
    role === "literary-infer" &&
    bindings.some(
      (b) =>
        b.type === "service" &&
        b.name === "LITERARY_PUBLISHER" &&
        b.service === "cove-literary-publisher-isolated-disabled",
    );
  if (role === "literary-infer" && !service)
    blockers.push("infer_private_publisher_service_binding_missing");
  workerEvidence.push({
    role,
    disabled,
    privateIngress,
    separate,
    privateR2,
    ...(role === "literary-infer" ? { privatePublisherBound: service } : {}),
    deployedVersion: deployed.deployments?.[0]?.versions?.[0]?.version_id || null,
  });
}
const expectedColumns = [
  "publication_state",
  "publication_available_at",
  "publication_lease_until",
  "publication_lease_token",
  "publication_attempts",
  "publication_last_error",
  "published_at",
];
if (
  expectedColumns.some((x) => !newColumns.some((row) => row.name === x)) ||
  newIndexes.length !== 2
)
  blockers.push("publication_retry_migration_not_verified");
if (identity.length !== 1 || identity[0].domain !== "cove-isolated-literary-budget")
  blockers.push("isolated_budget_identity_invalid");
if (frontier.length !== 1 || frontier[0].status !== "disarmed")
  blockers.push("reconciliation_not_disarmed_for_preflight");
if ((config.literary_processing_owner || "legacy") !== "legacy")
  blockers.push("primary_processing_owner_not_legacy");
if ((config.literary_budget_domain || "primary") !== "primary")
  blockers.push("primary_budget_owner_not_primary");
const original = legacyBudget[0] || { reserved_units: 0, calls: 0 };
const imported = isolatedBudget[0] || null;
const carryoverMatches =
  !!imported &&
  Number(imported.reserved_units) >= Number(original.reserved_units) &&
  Number(imported.calls) >= Number(original.calls);
if (!carryoverMatches) blockers.push("legacy_daily_inference_budget_not_carried_over");
if (!isolatedCutover.length || isolatedCutover[0].status !== "prepared")
  blockers.push("isolated_daily_budget_cutover_not_prepared");
if (!legacyLeases.length || legacyLeases[0].lease_until)
  blockers.push("legacy_sweep_lease_not_drained");
if (unfinished.some((x) => x.status === "running" && Number(x.n) > 0))
  blockers.push("legacy_analyze_jobs_running");
if (jobs.some((x) => Number(x.n) > 0))
  blockers.push("existing_isolated_jobs_require_reconciliation");
const oldCron = await api("GET", "/workers/scripts/cove-persistence-backend/schedules");
if (oldCron.schedules.some((x) => x.cron === "* * * * *"))
  blockers.push("legacy_minute_cron_still_attached");
blockers.push("active_handoff_and_rollback_not_certified");
blockers.push("private_publisher_tokens_and_staging_e2e_not_certified");
const evidence = {
  schema: "cove.literary.activation.readiness.v1",
  observedAt: now.toISOString(),
  releaseSha: process.env.GITHUB_SHA || null,
  readonly: true,
  mutationPerformed: false,
  primaryOwner: config.literary_processing_owner || "legacy",
  budgetOwner: config.literary_budget_domain || "primary",
  legacyBudget: {
    day,
    reservedUnits: Number(original.reserved_units),
    calls: Number(original.calls),
  },
  isolatedBudget: imported,
  budgetCarryoverVerified: carryoverMatches,
  isolatedCutoverStatus: isolatedCutover[0]?.status || "missing",
  frontierStatus: frontier[0]?.status || "missing",
  legacyLeases: legacyLeases[0] || null,
  unfinished,
  isolatedInferenceJobs: jobs,
  workerEvidence,
  canArm: false,
  blockers,
};
mkdirSync("artifacts/literary-cutover", { recursive: true });
writeFileSync(
  "artifacts/literary-cutover/activation-readonly.json",
  JSON.stringify(evidence, null, 2) + "\n",
);
console.log(
  "LITERARY_ACTIVATION_READONLY",
  JSON.stringify({
    budget: evidence.legacyBudget,
    carryover: carryoverMatches,
    blockers,
    readonly: true,
  }),
);
