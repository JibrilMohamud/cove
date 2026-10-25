import assert from "node:assert/strict";
const account = "d26430caa63ec55f6612e32f36aca5e9";
assert.equal(process.env.CLOUDFLARE_ACCOUNT_ID, account);
assert.equal(process.env.GITHUB_REF, "refs/heads/main");
const token = process.env.CLOUDFLARE_API_TOKEN;
assert.ok(token);
async function query(db, sql) {
  const res = await fetch(
    "https://api.cloudflare.com/client/v4/accounts/" + account + "/d1/database/" + db + "/query",
    {
      method: "POST",
      headers: { authorization: "Bearer " + token, "content-type": "application/json" },
      body: JSON.stringify({ sql }),
      signal: AbortSignal.timeout(30000),
    },
  );
  assert.ok(res.ok);
  const body = await res.json();
  assert.equal(body.success, true);
  return body.result[0]?.results || [];
}
const primary = "4bd657ac-8789-403e-a28c-93aba8d0a989";
const secondary = "400c3af3-5d40-41fd-83cc-98228e40ddac";
const [config, frontier, leases] = await Promise.all([
  query(
    primary,
    "SELECT key,value FROM cove_runtime_config WHERE key IN ('literary_processing_owner','literary_budget_domain')",
  ),
  query(secondary, "SELECT status FROM literary_legacy_reconcile_frontier WHERE id=1"),
  query(
    primary,
    "SELECT COUNT(*) n FROM literary_profile_jobs WHERE status='running' AND lease_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')",
  ),
]);
assert.deepEqual(Object.fromEntries(config.map((r) => [r.key, r.value])), {
  literary_budget_domain: "isolated",
  literary_processing_owner: "draining",
});
assert.deepEqual(frontier, [{ status: "armed" }]);
assert.equal(leases[0]?.n, 0);
console.log("LITERARY_REPLAY_UPGRADE_PREFLIGHT_PASS");
