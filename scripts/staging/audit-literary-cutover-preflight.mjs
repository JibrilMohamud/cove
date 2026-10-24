import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";

const account = "d26430caa63ec55f6612e32f36aca5e9";
const primary = "4bd657ac-8789-403e-a28c-93aba8d0a989";
const content = "400c3af3-5d40-41fd-83cc-98228e40ddac";
const worker = "cove-literary-handoff-isolated-disabled";
const oldWorker = "cove-persistence-backend";
const bucket = "cove-literary-originals-isolated-20261024";
const token = process.env.CLOUDFLARE_API_TOKEN;
assert.equal(process.env.CLOUDFLARE_ACCOUNT_ID, account);
assert.ok(token, "Protected Cloudflare credential required");
assert.match(process.env.GITHUB_SHA || "", /^[0-9a-f]{40}$/);
const base = "https://api.cloudflare.com/client/v4";
async function api(path, method = "GET", body) {
  const response = await fetch(base + path, {
    method,
    headers: {
      authorization: "Bearer " + token,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(45000),
  });
  assert.ok(response.ok, "Cutover API request rejected (" + response.status + ")");
  if (path.endsWith("/scripts/" + oldWorker))
    return response.text();
  const data = await response.json();
  assert.equal(data.success, true, "Cutover API response failed");
  return data.result;
}
async function query(id, sql) {
  const result = await api(`/accounts/${account}/d1/database/${id}/query`, "POST", { sql });
  assert.ok(Array.isArray(result) && result.every((r) => r.success));
  return result[0]?.results || [];
}
const eligibilitySql = `WITH candidates AS (
 SELECT j.id,j.status,j.fingerprint,p.edition_id,
 CASE WHEN lp.fingerprint=j.fingerprint AND lp.status='provisional'
   AND p.edition_id IS NOT NULL THEN 1 ELSE 0 END metadata_ok,
 CASE WHEN p.format='ebook' AND p.storefront_status='active'
   AND s.id=p.source_external_id AND p.source_name='gutenberg'
   AND s.ingest_status='active' AND s.epub_status='completed'
   AND s.rights_status='public-domain' AND s.commercial_use_status='approved'
   AND length(s.content_hash)=64 THEN 1 ELSE 0 END source_ok,
 CASE WHEN EXISTS (
   SELECT 1 FROM rights_grants g
   WHERE g.edition_id=p.edition_id AND g.format='ebook'
   AND g.sales_channel='retail' AND g.status='active' AND g.decision='allow'
   AND g.source='gutenberg-'||s.source_id||'-public-domain'
   AND g.territory_code IN (SELECT value FROM json_each(
     CASE WHEN json_valid(s.rights_territories_json)
       THEN s.rights_territories_json ELSE '[]' END))
   AND (g.starts_at IS NULL OR datetime(g.starts_at)<=datetime('now'))
   AND (g.ends_at IS NULL OR datetime(g.ends_at)>datetime('now'))
 ) AND NOT EXISTS (
   SELECT 1 FROM rights_grants deny
   WHERE deny.edition_id=p.edition_id AND deny.format='ebook'
   AND deny.sales_channel='retail' AND deny.status='active'
   AND deny.decision='deny'
   AND deny.territory_code IN (SELECT value FROM json_each(
     CASE WHEN json_valid(s.rights_territories_json)
       THEN s.rights_territories_json ELSE '[]' END))
   AND (deny.starts_at IS NULL OR datetime(deny.starts_at)<=datetime('now'))
   AND (deny.ends_at IS NULL OR datetime(deny.ends_at)>datetime('now'))
 ) THEN 1 ELSE 0 END rights_ok
 FROM literary_profile_jobs j
 LEFT JOIN literary_profiles lp ON lp.product_id=j.product_id
 LEFT JOIN products p ON p.id=j.product_id
 LEFT JOIN gutenberg_source_cache s ON s.id=p.source_external_id
 WHERE j.status IN ('queued','failed','running')
)
SELECT status,COUNT(*) total,SUM(metadata_ok) metadata_matches,
 SUM(CASE WHEN metadata_ok=1 AND source_ok=1 THEN 1 ELSE 0 END) source_eligible,
 SUM(CASE WHEN metadata_ok=1 AND source_ok=1 AND rights_ok=1
   THEN 1 ELSE 0 END) rights_eligible
FROM candidates GROUP BY status ORDER BY status`;
const [indexPlans, counts, owner, leases, frontier, isolatedIdentity,
  currentWorker, oldSchedules, disabledSchedules, oldScript, managed, custom] =
  await Promise.all([
    query(primary, "EXPLAIN QUERY PLAN SELECT id FROM literary_profile_jobs INDEXED BY idx_literary_legacy_reconcile WHERE id>'' AND status IN ('queued','failed','running') ORDER BY id LIMIT 1"),
    query(primary, eligibilitySql),
    query(primary, "SELECT value FROM cove_runtime_config WHERE key='literary_processing_owner'"),
    query(primary, "SELECT (SELECT COUNT(*) FROM literary_profile_jobs WHERE status='running') running,(SELECT lease_until FROM literary_profile_state WHERE id=1) sweep_lease"),
    query(content, "SELECT status,after_job_id FROM literary_legacy_reconcile_frontier WHERE id=1"),
    query(content, "SELECT domain,schema_version FROM literary_budget_domain_identity WHERE id=1"),
    api(`/accounts/${account}/workers/scripts/${worker}/settings`),
    api(`/accounts/${account}/workers/scripts/${oldWorker}/schedules`),
    api(`/accounts/${account}/workers/scripts/${worker}/schedules`),
    api(`/accounts/${account}/workers/scripts/${oldWorker}`),
    api(`/accounts/${account}/r2/buckets/${bucket}/domains/managed`),
    api(`/accounts/${account}/r2/buckets/${bucket}/domains/custom`),
  ]);
assert.ok(indexPlans.some((x) => x.detail?.includes("idx_literary_legacy_reconcile")));
assert.deepEqual(isolatedIdentity, [
  { domain: "cove-isolated-literary-budget", schema_version: 1 },
]);
assert.equal(frontier.length, 1);
const bindings = currentWorker?.bindings || [];
const values = Object.fromEntries(
  bindings.filter((x) => x.type === "plain_text").map((x) => [x.name, x.text]),
);
const dbBindings = bindings.filter((x) => x.type === "d1").map((x) => x.database_id);
const r2Bindings = bindings.filter((x) => x.type === "r2_bucket").map((x) => x.bucket_name);
assert.deepEqual(dbBindings.sort(), [primary, content].sort());
assert.deepEqual(r2Bindings, [bucket]);
for (const k of [
  "FORE_CONTENT_PROCESSOR_ENABLED",
  "FORE_CONTENT_PREPARE_ENABLED",
  "FORE_CONTENT_HANDOFF_ENABLED",
  "FORE_LITERARY_DRAIN_RECONCILE_ENABLED",
]) assert.equal(values[k], "0", "Dormant handoff Worker unexpectedly enabled: " + k);
assert.equal(values.FORE_CONTENT_PROCESSOR_ROLE, "literary-handoff");
assert.equal(disabledSchedules.schedules.length, 0);
assert.equal(currentWorker.routes?.length || 0, 0);
assert.equal(managed.enabled, false);
assert.deepEqual(custom.domains || [], []);
assert.ok(oldScript.includes("literary_processing_owner"));
assert.ok(oldScript.includes("FORE_CONTENT_PIPELINE_EXTERNAL"));
const currentlyRunning = Number(leases[0]?.running || 0);
const blockers = [];
if ((owner[0]?.value || "legacy") !== "draining")
  blockers.push("owner_not_draining");
if (frontier[0]?.status !== "armed")
  blockers.push("reconciliation_not_armed");
if (currentlyRunning || leases[0]?.sweep_lease)
  blockers.push("old_lease_not_drained");
if ((oldSchedules.schedules || []).some((s) => s.cron === "* * * * *"))
  blockers.push("legacy_minute_cron_attached_verify_writer_termination");
blockers.push("no_guarded_active_handoff_executor_certified");
const totals = {
  unfinished: counts.reduce((s, x) => s + Number(x.total), 0),
  metadataMatches: counts.reduce((s, x) => s + Number(x.metadata_matches), 0),
  sourceEligible: counts.reduce((s, x) => s + Number(x.source_eligible), 0),
  snapshotRightsEligible: counts.reduce((s, x) => s + Number(x.rights_eligible), 0),
};
assert.ok(totals.snapshotRightsEligible <= totals.sourceEligible);
assert.ok(totals.sourceEligible <= totals.metadataMatches);
assert.ok(totals.metadataMatches <= totals.unfinished);
const evidence = {
  schema: "cove.literary.cutover.preflight.v1",
  releaseSha: process.env.GITHUB_SHA,
  observedAt: new Date().toISOString(),
  primaryReadOnly: true,
  liveWritePerformed: false,
  rightsApprovedByAudit: false,
  legacyCronCount: oldSchedules.schedules?.length || 0,
  deployedLegacyCodeSha256: createHash("sha256").update(oldScript).digest("hex"),
  legacyCodeContainsOwnerFence: true,
  currentOwner: owner[0]?.value || "legacy",
  frontier: frontier[0],
  leases: leases[0],
  separateD1AndPrivateR2: true,
  dormantExecutorVerified: true,
  totals,
  byStatus: counts,
  canArmWithoutFurtherOperatorChecks: false,
  blockers,
};
fs.mkdirSync("artifacts/literary-cutover", { recursive: true });
fs.writeFileSync(
  "artifacts/literary-cutover/live-readonly-preflight.json",
  JSON.stringify(evidence, null, 2) + "\n",
);
console.log("LITERARY_LIVE_CUTOVER_PREFLIGHT", JSON.stringify({
  totals, blockers, liveWritePerformed: false,
  releaseSha: process.env.GITHUB_SHA,
}));
