/**
 * One-row page-witness performance SHAPE, not authorization.
 *
 * Synthetic D1 ONLY; 50k fake page records stress the primary-key index,
 * while the driver retrieves a single dummy 25-candidate page witness.
 * This contains NO real book rights, settlement, offer or entitlement.
 * All synthetic records are ephemeral and MUST be removed after CI.
 */
import assert from "node:assert/strict";

const ACCOUNT = "d26430caa63ec55f6612e32f36aca5e9";
const DB = "e4cbb0ef-6288-4fa1-9dbb-fb42fe01d4f3";
const TABLE = "cove_stage_perf_page_authority";
const COUNT = 50000;
const TARGET = "page-synth-000001";
const DIGEST = "c".repeat(64);
const OFFER_DIGEST = "d".repeat(64);

if (
  process.env.COVE_SYNTHETIC_PAGE_BENCH !== "1" ||
  process.env.CLOUDFLARE_ACCOUNT_ID !== ACCOUNT ||
  process.env.COVE_SYNTHETIC_D1_ID !== DB ||
  !process.env.CLOUDFLARE_API_TOKEN
)
  throw new Error("Only the exact isolated D1 and explicit synthetic-page CI may run this fixture");

async function query(sql, params = []) {
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/d1/database/${DB}/query`,
    {
      method: "POST",
      headers: {
        authorization: "Bearer " + process.env.CLOUDFLARE_API_TOKEN,
        "content-type": "application/json",
      },
      body: JSON.stringify({ sql, params }),
      signal: AbortSignal.timeout(30000),
    },
  );
  if (!response.ok) throw Error("Synthetic page fixture D1 HTTP " + response.status);
  const result = await response.json();
  if (!result.success || !Array.isArray(result.result))
    throw Error("Synthetic page fixture SQL failed; no private Worker deployment");
  return result.result[0];
}

async function verify() {
  const count = await query(`SELECT COUNT(*) n FROM ${TABLE}`);
  assert.equal(count.results?.[0]?.n, COUNT, "Full 50k synthetic page B-tree required");
  const response = await query(
    `SELECT page_id,candidate_count,owner_epoch,rank_digest,current_offer_digest,
       valid_until FROM ${TABLE} WHERE page_id=? AND valid_until>datetime('now')`,
    [TARGET],
  );
  const row = response.results?.[0];
  assert.equal(response.results?.length, 1);
  assert.equal(row.page_id, TARGET);
  assert.equal(row.candidate_count, 25);
  assert.equal(row.owner_epoch, 1);
  assert.equal(row.rank_digest, DIGEST);
  assert.equal(row.current_offer_digest, OFFER_DIGEST);
  return { pageRows: COUNT, selectedRows: 1, sqlMs: response.meta?.duration };
}

async function install() {
  await query(`CREATE TABLE IF NOT EXISTS ${TABLE} (
    page_id TEXT PRIMARY KEY,
    candidate_count INTEGER NOT NULL,
    owner_epoch INTEGER NOT NULL,
    rank_digest TEXT NOT NULL,
    current_offer_digest TEXT NOT NULL,
    valid_until TEXT NOT NULL
  ) WITHOUT ROWID`);
  // If prior interrupted run left only this synthetic table, fully reset it.
  await query(`DELETE FROM ${TABLE}`);
  const products = await query("SELECT COUNT(*) n FROM products WHERE id LIKE 'perf-synth-%'");
  assert.equal(products.results?.[0]?.n, COUNT, "Exact synthetic product corpus required");
  const seeded = await query(
    `INSERT INTO ${TABLE}
       SELECT 'page-synth-'||substr(id,12),25,1,?,?,datetime('now','+30 seconds')
       FROM products WHERE id LIKE 'perf-synth-%'`,
    [DIGEST, OFFER_DIGEST],
  );
  assert.equal(seeded.meta?.changes, COUNT, "Seed precisely 50k fake page entries");
  console.log(
    JSON.stringify({
      event: "cove_stage_page_witness_bench_installed",
      ...(await verify()),
      fakeLegalAuthority: true,
      releaseCertified: false,
    }),
  );
}

async function destroy() {
  // Can never affect real staging owner tables, products or production D1.
  await query(`DROP TABLE IF EXISTS ${TABLE}`);
  const result = await query(
    "SELECT COUNT(*) n FROM sqlite_master WHERE type='table' AND name='cove_stage_perf_page_authority'",
  );
  assert.equal(result.results?.[0]?.n, 0);
  console.log(JSON.stringify({ event: "cove_stage_page_witness_bench_removed", clean: true }));
}

const args = process.argv.slice(2);
if (args.length !== 1 || !["--install", "--verify", "--destroy"].includes(args[0]))
  throw Error("Explicit isolated --install, --verify, or --destroy only");
if (args[0] === "--install") await install();
else if (args[0] === "--verify") {
  console.log(
    JSON.stringify({ event: "cove_stage_page_witness_bench_verified", ...(await verify()) }),
  );
} else await destroy();
