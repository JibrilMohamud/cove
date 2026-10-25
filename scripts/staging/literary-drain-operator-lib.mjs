import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";

export const account = "d26430caa63ec55f6612e32f36aca5e9";
export const primary = "4bd657ac-8789-403e-a28c-93aba8d0a989";
export const content = "400c3af3-5d40-41fd-83cc-98228e40ddac";
export const roles = [
  "cove-literary-handoff-draining-20261025",
  "cove-literary-prepare-draining-20261025",
];
const token = process.env.CLOUDFLARE_API_TOKEN;
assert.ok(token, "Protected Cloudflare credential required");
assert.equal(process.env.CLOUDFLARE_ACCOUNT_ID, account);
assert.equal(process.env.GITHUB_REF, "refs/heads/main");
const base = "https://api.cloudflare.com/client/v4/accounts/" + account;
export const pause = (ms) => new Promise((done) => setTimeout(done, ms));

export async function api(method, path, payload) {
  const response = await fetch(base + path, {
    method,
    headers: {
      authorization: "Bearer " + token,
      ...(payload ? { "content-type": "application/json" } : {}),
    },
    ...(payload ? { body: JSON.stringify(payload) } : {}),
    signal: AbortSignal.timeout(30000),
  });
  assert.ok(response.ok, "Literary operator request rejected " + response.status);
  const body = await response.json();
  assert.equal(body.success, true, "Literary operator denied");
  return body.result;
}
export async function query(id, sql) {
  const result = await api("POST", "/d1/database/" + id + "/query", { sql });
  assert.ok(Array.isArray(result) && result.every((x) => x.success), "D1 query rejected");
  return result[0]?.results || [];
}
export async function owner() {
  const rows = await query(
    primary,
    "SELECT key,value FROM cove_runtime_config WHERE key IN ('literary_processing_owner','literary_budget_domain')",
  );
  const state = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  return {
    literary: state.literary_processing_owner || "legacy",
    budget: state.literary_budget_domain || "primary",
  };
}
export async function verifyWorkerTopology() {
  for (const name of roles) {
    const [settings, schedule, worker] = await Promise.all([
      api("GET", "/workers/scripts/" + name + "/settings"),
      api("GET", "/workers/scripts/" + name + "/schedules"),
      api("GET", "/workers/workers/" + name),
    ]);
    assert.ok(!worker.subdomain?.enabled && !worker.subdomain?.previews_enabled);
    assert.equal(settings.routes?.length || 0, 0);
    assert.deepEqual(schedule.schedules.map((x) => x.cron), ["* * * * *"]);
    const b = settings.bindings || [];
    const vars = Object.fromEntries(
      b.filter((x) => x.type === "plain_text").map((x) => [x.name, x.text]),
    );
    assert.equal(vars.FORE_CONTENT_PROCESSOR_ENABLED, "1");
    assert.equal(vars.FORE_CONTENT_PREPARE_ENABLED, "1");
    assert.equal(vars.FORE_CONTENT_D1_ADMISSION_MAX_MS, "100");
    assert.deepEqual(
      b.filter((x) => x.type === "d1").map((x) => x.database_id).sort(),
      [primary, content].sort(),
    );
    assert.ok(
      b.some(
        (x) =>
          x.type === "r2_bucket" &&
          x.name === "BUCKET" &&
          x.bucket_name === "cove-literary-originals-isolated-20261024",
      ),
    );
    if (name.includes("prepare-draining"))
      assert.ok(
        b.some(
          (x) =>
            x.type === "r2_bucket" &&
            x.name === "SOURCE_BUCKET" &&
            x.bucket_name === "cove-production-media",
        ),
      );
    else {
      assert.equal(vars.FORE_CONTENT_HANDOFF_ENABLED, "1");
      assert.equal(vars.FORE_LITERARY_DRAIN_RECONCILE_ENABLED, "1");
    }
  }
}
export async function leases() {
  const rows = await query(
    primary,
    "SELECT EXISTS(SELECT 1 FROM literary_profile_state WHERE id=1" +
      " AND lease_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')) AS sweep," +
      " EXISTS(SELECT 1 FROM literary_profile_jobs WHERE status='running'" +
      " AND lease_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')) AS running",
  );
  return rows[0] || { sweep: 1, running: 1 };
}
export function evidenceFile(filename, evidence) {
  mkdirSync("artifacts/literary-cutover", { recursive: true });
  writeFileSync(
    "artifacts/literary-cutover/" + filename,
    JSON.stringify(evidence, null, 2) + "\n",
  );
}
