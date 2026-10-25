import assert from "node:assert/strict";
import {
  api,
  content,
  evidenceFile,
  leases,
  owner,
  pause,
  primary,
  query,
  verifyWorkerTopology,
} from "./literary-drain-operator-lib.mjs";

const before = await owner();
assert.deepEqual(before, { literary: "legacy", budget: "primary" });
await verifyWorkerTopology();
const [frontier, identity, unprepared, qa] = await Promise.all([
  query(content, "SELECT status,after_job_id FROM literary_legacy_reconcile_frontier WHERE id=1"),
  query(content, "SELECT domain,schema_version FROM literary_budget_domain_identity WHERE id=1"),
  query(content, "SELECT COUNT(*) n FROM literary_prepare_jobs"),
  query(
    "fce5742c-29ca-4bc3-85da-e174dd9bf42e",
    "SELECT result FROM literary_qa_private_pub_receipts WHERE id=1",
  ),
]);
assert.deepEqual(frontier, [{ status: "disarmed", after_job_id: "" }]);
assert.equal(identity[0]?.domain, "cove-isolated-literary-budget");
assert.equal(identity[0]?.schema_version, 1);
assert.equal(unprepared[0]?.n, 0);
assert.equal(qa[0]?.result, "passed", "Deployed private publisher proof required");
const nowSql = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";
const ownerTransition = await query(
  primary,
  "INSERT INTO cove_runtime_config(key,value,updated_at)" +
    " VALUES('literary_processing_owner','draining'," +
    nowSql +
    ") ON CONFLICT(key) DO UPDATE SET value='draining',updated_at=excluded.updated_at" +
    " WHERE value='legacy' RETURNING value",
);
assert.deepEqual(ownerTransition, [{ value: "draining" }]);
// Fencing the primary budget NOW prevents late legacy AI reservations; the
// isolated cutover remains 'prepared', so neither processor can double-debit.
const budgetTransition = await query(
  primary,
  "INSERT INTO cove_runtime_config(key,value,updated_at)" +
    " VALUES('literary_budget_domain','isolated'," +
    nowSql +
    ") ON CONFLICT(key) DO UPDATE SET value='isolated',updated_at=excluded.updated_at" +
    " WHERE value='primary' RETURNING value",
);
assert.deepEqual(budgetTransition, [{ value: "isolated" }]);
let drained = false;
let samples = 0;
for (let i = 0; i < 88; i++) {
  const active = await leases();
  samples++;
  if (!active.sweep && !active.running) {
    drained = true;
    break;
  }
  await pause(5000);
}
assert.ok(drained, "Legacy leases failed to drain after owner and budget fences");
assert.deepEqual(await owner(), { literary: "draining", budget: "isolated" });
const day = new Date().toISOString().slice(0, 10);
const daySql = "'" + day + "'";
const [spent, prepared] = await Promise.all([
  query(primary, "SELECT reserved_units,calls FROM literary_profile_budget WHERE day=" + daySql),
  query(content, "SELECT status FROM literary_budget_cutover WHERE day=" + daySql),
]);
const units = Number(spent[0]?.reserved_units || 0);
const calls = Number(spent[0]?.calls || 0);
assert.ok(Number.isSafeInteger(units) && units >= 0 && units <= 2_000_000);
assert.ok(Number.isSafeInteger(calls) && calls >= 0);
assert.equal(prepared[0]?.status, "prepared");
// Only the independent budget data plane changes here. No permission to
// reserve isolated units until the later, separately gated owner takeover.
const seedSql = [
  "INSERT INTO literary_profile_budget(day,reserved_units,calls)",
  " VALUES(" + daySql + "," + units + "," + calls + ")",
  " ON CONFLICT(day) DO UPDATE SET",
  " reserved_units=MAX(reserved_units,excluded.reserved_units),",
  " calls=MAX(calls,excluded.calls)",
].join("");
await query(content, seedSql);
const transferSql = [
  "UPDATE literary_budget_cutover SET",
  " original_reserved_units=MAX(original_reserved_units," + units + "),",
  " original_calls=MAX(original_calls," + calls + "),",
  " prepared_at=" + nowSql,
  " WHERE day=" + daySql + " AND status='prepared'",
].join("");
await query(content, transferSql);
const [carried, transfer] = await Promise.all([
  query(content, "SELECT reserved_units,calls FROM literary_profile_budget WHERE day=" + daySql),
  query(
    content,
    "SELECT status,original_reserved_units,original_calls FROM literary_budget_cutover WHERE day=" +
      daySql,
  ),
]);
assert.ok(carried[0].reserved_units >= units && carried[0].calls >= calls);
assert.equal(transfer[0]?.status, "prepared");
assert.ok(transfer[0].original_reserved_units >= units);
assert.ok(transfer[0].original_calls >= calls);
assert.deepEqual(await leases(), { sweep: 0, running: 0 });
const armed = await query(
  content,
  "UPDATE literary_legacy_reconcile_frontier SET status='armed'," +
    "updated_at=" + nowSql +
    " WHERE id=1 AND status='disarmed' AND after_job_id=''" +
    " RETURNING status",
);
assert.deepEqual(armed, [{ status: "armed" }]);
const result = {
  schema: "cove.literary.draining.activation.v1",
  when: new Date().toISOString(),
  owner: await owner(),
  legacyLeasesDrained: true,
  sampledLeaseChecks: samples,
  budgetDay: day,
  budgetCarried: { units, calls },
  isolatedSpendPermission: false,
  reconciliation: armed[0].status,
  privatePublisherStageCertified: true,
};
evidenceFile("draining-activation.json", result);
console.log("LITERARY_DRAIN_ARMED_PASS", JSON.stringify(result));
