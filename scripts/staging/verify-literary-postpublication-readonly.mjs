import assert from "node:assert/strict";
const account = "d26430caa63ec55f6612e32f36aca5e9";
const primary = "4bd657ac-8789-403e-a28c-93aba8d0a989";
const contentId = "400c3af3-5d40-41fd-83cc-98228e40ddac";
assert.equal(process.env.CLOUDFLARE_ACCOUNT_ID, account);
assert.equal(process.env.GITHUB_REF, "refs/heads/main");
const token = process.env.CLOUDFLARE_API_TOKEN;
assert.ok(token, "Protected remote canary credential required");
async function query(database, sql) {
  assert.match(sql, /^SELECT\b/);
  const response = await fetch(
    "https://api.cloudflare.com/client/v4/accounts/" +
      account +
      "/d1/database/" +
      database +
      "/query",
    {
      method: "POST",
      headers: {
        authorization: "Bearer " + token,
        "content-type": "application/json",
      },
      body: JSON.stringify({ sql }),
      signal: AbortSignal.timeout(30000),
    },
  );
  assert.ok(response.ok);
  const result = await response.json();
  assert.equal(result.success, true);
  return result.result[0]?.results || [];
}
const [owner, published, frontier, cutover] = await Promise.all([
  query(
    primary,
    "SELECT key,value FROM cove_runtime_config WHERE key IN " +
      "('literary_processing_owner','literary_budget_domain')",
  ),
  query(
    contentId,
    "SELECT product_id,profile_fingerprint,profile_revision" +
      " FROM literary_inference_jobs WHERE status='done'" +
      " AND publication_state='published' LIMIT 4",
  ),
  query(contentId, "SELECT status FROM literary_legacy_reconcile_frontier WHERE id=1"),
  query(
    contentId,
    "SELECT status FROM literary_budget_cutover WHERE day='" +
      new Date().toISOString().slice(0, 10) +
      "'",
  ),
]);
assert.deepEqual(Object.fromEntries(owner.map((x) => [x.key, x.value])), {
  literary_budget_domain: "isolated",
  literary_processing_owner: "isolated",
});
assert.ok(["armed", "complete"].includes(frontier[0]?.status));
assert.deepEqual(cutover, [{ status: "active" }]);
assert.ok(published.length > 0, "No real canonical profile publication receipt");
for (const job of published) {
  assert.match(job.product_id, /^[a-zA-Z0-9_-]{1,120}$/);
  const profile = await query(
    primary,
    "SELECT fingerprint,revision,status,coverage FROM literary_profiles" +
      " WHERE product_id='" +
      job.product_id +
      "'",
  );
  assert.deepEqual(profile, [
    {
      fingerprint: job.profile_fingerprint,
      revision: job.profile_revision + 1,
      status: "analyzed",
      coverage: "isolated_samples",
    },
  ]);
}
console.log(
  "LITERARY_POSTCUTOVER_PUBLICATION_GATE_PASS",
  JSON.stringify({ verified: published.length, owner: "isolated", utc: new Date().toISOString() }),
);
