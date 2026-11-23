import assert from "node:assert/strict";
const account = "d26430caa63ec55f6612e32f36aca5e9";
const primary = "4bd657ac-8789-403e-a28c-93aba8d0a989";
const contentId = "400c3af3-5d40-41fd-83cc-98228e40ddac";
assert.equal(process.env.CLOUDFLARE_ACCOUNT_ID, account);
assert.equal(process.env.GITHUB_REF, "refs/heads/main");
const token = process.env.CLOUDFLARE_API_TOKEN;
assert.ok(token, "Protected remote canary credential required");
// All read-only Cloudflare checks share one explicit request-start queue.
 // The old parallel fan-out caused HTTP 429 before any capacity sample ran.
 // 429 is never a pass: only a fresh provider 200 + exact data qualifies.
let queryTail=Promise.resolve();
let earliestNextStart=0;
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function querySerial(database,sql){
  assert.match(sql,/^SELECT\b/);
  const endpoint="https://api.cloudflare.com/client/v4/accounts/"+
    account+"/d1/database/"+database+"/query";
  const attempts=4;
  for(let index=0;index<attempts;index++){
    const pace=Math.max(0,earliestNextStart-Date.now());
    if(pace)await sleep(pace);
    earliestNextStart=Date.now()+1200;
    const response=await fetch(endpoint,{
      method:"POST",
      headers:{authorization:"Bearer "+token,"content-type":"application/json"},
      body:JSON.stringify({sql}),
      signal:AbortSignal.timeout(30000),
      redirect:"error"
    });
    if(response.status===429&&index<attempts-1){
      // Bounded rate-limit recovery is allowed ONLY for a SELECT-only audit.
      // Treat permanent throttling as failure, never skip a required witness.
      try{await response.body?.cancel?.()}catch{}
      const seconds=Number(response.headers.get("retry-after"));
      const providerWait=Number.isFinite(seconds)&&seconds>=0?
        Math.min(30000,Math.ceil(seconds*1000)):0;
      await sleep(Math.max(2500*2**index,providerWait));
      continue;
    }
    assert.ok(response.ok,
      "Read-only literary publication preflight "+
      (database===primary?"primary":"isolated-content")+" HTTP "+response.status);
    const result=await response.json();
    assert.equal(result.success,true);
    assert.ok(Array.isArray(result.result?.[0]?.results));
    return result.result[0].results;
  }
  throw Error("Read-only literary publication preflight exhausted");
}
function query(database,sql){
  const run=queryTail.then(()=>querySerial(database,sql));
  queryTail=run.then(()=>undefined,()=>undefined);
  return run;
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
