import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";

const account = "d26430caa63ec55f6612e32f36aca5e9";
const primary = "4bd657ac-8789-403e-a28c-93aba8d0a989";
const isolated = "400c3af3-5d40-41fd-83cc-98228e40ddac";
assert.equal(process.env.CLOUDFLARE_ACCOUNT_ID, account);
assert.equal(process.env.GITHUB_REF, "refs/heads/main");
const token = process.env.CLOUDFLARE_API_TOKEN;
assert.ok(token);
const base = "https://api.cloudflare.com/client/v4/accounts/" + account;
async function query(id, sql) {
  const response = await fetch(base + "/d1/database/" + id + "/query", {
    method: "POST",
    headers: {
      authorization: "Bearer " + token,
      "content-type": "application/json",
    },
    body: JSON.stringify({ sql }),
    signal: AbortSignal.timeout(30000),
  });
  assert.ok(response.ok, "Literary UTC ledger API unavailable");
  const json = await response.json();
  assert.equal(json.success, true);
  assert.ok(Array.isArray(json.result) && json.result.every((r) => r.success));
  return json.result[0]?.results || [];
}
const today = new Date().toISOString().slice(0, 10);
const yesterday = new Date(Date.parse(today + "T00:00:00Z") - 86400000).toISOString().slice(0, 10);
const [owner, identity, previous, existing, original, leases] = await Promise.all([
  query(
    primary,
    "SELECT key,value FROM cove_runtime_config WHERE key IN " +
      "('literary_processing_owner','literary_budget_domain')",
  ),
  query(
    isolated,
    "SELECT domain,schema_version,EXISTS(SELECT 1 FROM sqlite_master" +
      " WHERE type='table' AND name IN ('rights_grants','products','payment_orders')) contaminated" +
      " FROM literary_budget_domain_identity WHERE id=1",
  ),
  query(isolated, "SELECT status FROM literary_budget_cutover WHERE day='" + yesterday + "'"),
  query(isolated, "SELECT status FROM literary_budget_cutover WHERE day='" + today + "'"),
  query(
    primary,
    "SELECT reserved_units,calls FROM literary_profile_budget WHERE day='" + today + "'",
  ),
  query(
    primary,
    "SELECT EXISTS(SELECT 1 FROM literary_profile_jobs WHERE status='running'" +
      " AND lease_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')) AS jobs," +
      " EXISTS(SELECT 1 FROM literary_profile_state WHERE id=1" +
      " AND lease_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')) AS sweep",
  ),
]);
const authority = Object.fromEntries(owner.map((row) => [row.key, row.value]));
assert.ok(["draining", "isolated"].includes(authority.literary_processing_owner));
assert.equal(authority.literary_budget_domain, "isolated");
assert.deepEqual(identity, [
  { domain: "cove-isolated-literary-budget", schema_version: 1, contaminated: 0 },
]);
assert.deepEqual(leases, [{ jobs: 0, sweep: 0 }]);
const units = Number(original[0]?.reserved_units || 0);
const calls = Number(original[0]?.calls || 0);
assert.ok(Number.isSafeInteger(units) && units >= 0 && units <= 100_000_000);
assert.ok(Number.isSafeInteger(calls) && calls >= 0);
// Never bootstrap the first isolated day without its protected staged canary.
// A successful active PREVIOUS day is the certificate for independent rollover.
if (existing[0]?.status === "active") {
  console.log("LITERARY_UTC_ROLLOVER_ALREADY_ACTIVE", today);
} else if (previous[0]?.status !== "active") {
  console.log("LITERARY_UTC_ROLLOVER_NOT_YET_AUTHORIZED", yesterday, today);
} else {
  const receipt = "continuous-fenced-literary-budget-" + today;
  await query(
    isolated,
    "INSERT INTO literary_profile_budget(day,reserved_units,calls) VALUES('" +
      today +
      "'," +
      units +
      "," +
      calls +
      ") ON CONFLICT(day) DO UPDATE SET" +
      " reserved_units=MAX(reserved_units,excluded.reserved_units)," +
      " calls=MAX(calls,excluded.calls)",
  );
  await query(
    isolated,
    "INSERT OR IGNORE INTO literary_budget_cutover" +
      "(day,status,original_reserved_units,original_calls,prepared_at,operator_receipt)" +
      " VALUES('" +
      today +
      "','prepared'," +
      units +
      "," +
      calls +
      ",strftime('%Y-%m-%dT%H:%M:%fZ','now'),'" +
      receipt +
      "')",
  );
  assert.equal(new Date().toISOString().slice(0, 10), today);
  const updated = await query(
    isolated,
    "UPDATE literary_budget_cutover SET status='active'," +
      "activated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')" +
      " WHERE day='" +
      today +
      "' AND status='prepared' AND original_reserved_units>=" +
      units +
      " AND original_calls>=" +
      calls +
      " RETURNING day,status",
  );
  assert.deepEqual(updated, [{ day: today, status: "active" }]);
  const result = {
    schema: "cove.literary.utc-fenced-budget-rollover.v1",
    at: new Date().toISOString(),
    day: today,
    previousDay: yesterday,
    importedOriginalUnits: units,
    importedOriginalCalls: calls,
    owner: authority,
  };
  mkdirSync("artifacts/literary-cutover", { recursive: true });
  writeFileSync(
    "artifacts/literary-cutover/utc-budget-rollover.json",
    JSON.stringify(result, null, 2) + "\n",
  );
  console.log("LITERARY_UTC_ROLLOVER_ACTIVE_PASS", JSON.stringify(result));
}
