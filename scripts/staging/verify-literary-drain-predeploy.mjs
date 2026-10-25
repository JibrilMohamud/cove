import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const account = "d26430caa63ec55f6612e32f36aca5e9";
const primary = "4bd657ac-8789-403e-a28c-93aba8d0a989";
const secondary = "400c3af3-5d40-41fd-83cc-98228e40ddac";
const privateBucket = "cove-literary-originals-isolated-20261024";
const sourceBucket = "cove-production-media";
const token = process.env.CLOUDFLARE_API_TOKEN;
assert.equal(process.env.CLOUDFLARE_ACCOUNT_ID, account);
assert.ok(token, "Protected Cloudflare credentials required");
assert.equal(process.env.GITHUB_REF, "refs/heads/main");
const source = readFileSync("src/lib/literary-preparation-domain.server.ts", "utf8");
assert.ok(source.includes("env.SOURCE_BUCKET || env.BUCKET!"));
const roleFiles = [
  ["wrangler.content-literary-handoff.prod-draining.jsonc", "literary-handoff"],
  ["wrangler.content-literary-prepare.prod-draining.jsonc", "literary-prepare"],
];
for (const [file, role] of roleFiles) {
  const cfg = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(cfg.workers_dev, false);
  assert.equal(cfg.preview_urls, false);
  assert.ok(!cfg.routes && !cfg.route && !cfg.queues);
  assert.deepEqual(cfg.triggers.crons, ["* * * * *"]);
  assert.equal(cfg.vars.FORE_CONTENT_PROCESSOR_ROLE, role);
  assert.equal(cfg.vars.FORE_CONTENT_PROCESSOR_ENABLED, "1");
  assert.equal(cfg.vars.FORE_CONTENT_PREPARE_ENABLED, "1");
  assert.equal(cfg.vars.FORE_CONTENT_D1_ADMISSION_MAX_MS, "100");
  assert.deepEqual(
    cfg.d1_databases.map((x) => x.database_id),
    [primary, secondary],
  );
  assert.deepEqual(
    cfg.r2_buckets.map((x) => x.bucket_name),
    role === "literary-handoff" ? [privateBucket] : [privateBucket, sourceBucket],
  );
  if (role === "literary-handoff") {
    assert.equal(cfg.vars.FORE_CONTENT_HANDOFF_ENABLED, "1");
    assert.equal(cfg.vars.FORE_LITERARY_DRAIN_RECONCILE_ENABLED, "1");
  }
}
const base = "https://api.cloudflare.com/client/v4/accounts/" + account;
async function get(path, method = "GET", body) {
  const response = await fetch(base + path, {
    method,
    headers: {
      authorization: "Bearer " + token,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(30000),
  });
  assert.ok(response.ok, "Active Worker preflight API rejected " + response.status);
  const data = await response.json();
  assert.equal(data.success, true);
  return data.result;
}
const query = async (db, sql) => {
  assert.match(sql.trim(), /^SELECT\b/i);
  const r = await get("/d1/database/" + db + "/query", "POST", { sql });
  assert.ok(Array.isArray(r) && r.every((x) => x.success));
  return r[0].results || [];
};
const [owner, frontier, identity, jobs, sourceObjects] = await Promise.all([
  query(primary, "SELECT key,value FROM cove_runtime_config WHERE key IN ('literary_processing_owner','literary_budget_domain')"),
  query(secondary, "SELECT status,after_job_id FROM literary_legacy_reconcile_frontier WHERE id=1"),
  query(secondary, "SELECT domain,schema_version FROM literary_budget_domain_identity WHERE id=1"),
  query(secondary, "SELECT COUNT(*) n FROM literary_prepare_jobs"),
  get("/r2/buckets/" + sourceBucket + "/objects?prefix=epubs%2F15093.epub&per_page=4"),
]);
assert.deepEqual(owner, [], "Only initial legacy/default owner may deploy draining Workers");
assert.deepEqual(frontier, [{ status: "disarmed", after_job_id: "" }]);
assert.equal(identity[0]?.domain, "cove-isolated-literary-budget");
assert.equal(identity[0]?.schema_version, 1);
assert.equal(jobs[0]?.n, 0, "Unexpected isolated preparation jobs before deployment");
const sourceMetadata = await query(
  primary,
  "SELECT content_hash FROM gutenberg_source_cache WHERE id='15093'",
);
const original = sourceObjects.find((x) => x.key === "epubs/15093.epub");
assert.ok(original && original.size > 100 && original.size < 16 * 1024 * 1024);
assert.equal(original.http_metadata?.contentType, "application/epub+zip");
assert.equal(original.custom_metadata?.sha256, sourceMetadata[0]?.content_hash);
console.log(
  "LITERARY_DRAIN_PREDEPLOY_PASS canonical owner legacy, disarmed frontier, verified source R2, no public ingress",
);
