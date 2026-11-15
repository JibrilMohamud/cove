/**
 * Temporary synthetic D1 latency fixture. This is a BENCHMARK, not legal
 * authority: every positive has a deliberately fake "BENCH-NOT-A-GRANT"
 * offer ID and a constant 64-hex placeholder digest. No customer route,
 * live owner, retail settlement, or entitlement may consume these tables.
 *
 * Only the pinned 50k synthetic D1 may be modified. Always drop all five
 * benchmark-only tables on CI exit, even after an upstream failure.
 */
import assert from "node:assert/strict";

const ACCOUNT = "d26430caa63ec55f6612e32f36aca5e9";
const DB = "e4cbb0ef-6288-4fa1-9dbb-fb42fe01d4f3";
const TABLES = [
  "cove_stage_perf_retail_authority",
  "cove_stage_perf_source_revision",
  "cove_stage_perf_territory_revision",
  "cove_stage_perf_market_revision",
  "cove_stage_perf_owner_state",
];
// 25 deterministic point reads scattered across the entire 50k-record
// benchmark B-tree. IDs are all synthetic; no catalog ranking is inferred.
const ids = Array.from(
  { length: 25 },
  (_, i) => "perf-synth-" + String(1 + i * 1999).padStart(6, "0"),
);
const TOTAL_SYNTHETIC_PRODUCTS = 50000;
if (
  process.env.COVE_SYNTHETIC_POINT_BENCH !== "1" ||
  process.env.CLOUDFLARE_ACCOUNT_ID !== ACCOUNT ||
  process.env.COVE_SYNTHETIC_D1_ID !== DB ||
  !process.env.CLOUDFLARE_API_TOKEN
)
  throw new Error("Synthetic D1 point fixture is forbidden without exact staging authorization");

async function d1(sql, params = []) {
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
  if (!response.ok) throw new Error("Synthetic D1 fixture operation HTTP " + response.status);
  const parsed = await response.json();
  if (!parsed.success || !Array.isArray(parsed.result))
    throw new Error("Synthetic D1 fixture SQL failed; forbid remote Worker deployment");
  return parsed.result[0];
}

const ddl = [
  `CREATE TABLE IF NOT EXISTS cove_stage_perf_owner_state (
    id INTEGER PRIMARY KEY CHECK(id=1),enabled INTEGER NOT NULL,epoch INTEGER NOT NULL,
    us_fallback_revision INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS cove_stage_perf_source_revision (
    product_id TEXT PRIMARY KEY,revision INTEGER NOT NULL
  ) WITHOUT ROWID`,
  `CREATE TABLE IF NOT EXISTS cove_stage_perf_territory_revision (
    territory_code TEXT PRIMARY KEY,revision INTEGER NOT NULL
  ) WITHOUT ROWID`,
  `CREATE TABLE IF NOT EXISTS cove_stage_perf_market_revision (
    territory_code TEXT PRIMARY KEY,revision INTEGER NOT NULL
  ) WITHOUT ROWID`,
  `CREATE TABLE IF NOT EXISTS cove_stage_perf_retail_authority (
    product_id TEXT NOT NULL,territory_code TEXT NOT NULL,currency TEXT NOT NULL,
    amount_minor INTEGER NOT NULL,current_offer_id TEXT NOT NULL,
    owner_epoch INTEGER NOT NULL,source_revision INTEGER NOT NULL,
    territory_revision INTEGER NOT NULL,market_revision INTEGER NOT NULL,
    us_fallback_revision INTEGER NOT NULL,evidence_digest TEXT NOT NULL,
    valid_until TEXT NOT NULL,
    PRIMARY KEY(product_id,territory_code,currency)
  ) WITHOUT ROWID`,
];

async function verify() {
  const full = await d1("SELECT count(*) total FROM cove_stage_perf_retail_authority");
  assert.equal(
    full.results?.[0]?.total,
    TOTAL_SYNTHETIC_PRODUCTS,
    "Benchmark must measure an actual 50k indexed authorization-shaped table",
  );
  const result = await d1(
    `SELECT product_id,valid_until FROM cove_stage_perf_retail_authority
     WHERE product_id IN (SELECT value FROM json_each(?))
       AND territory_code='US' AND currency='USD' ORDER BY product_id`,
    [JSON.stringify(ids)],
  );
  const rows = result.results || [];
  assert.equal(rows.length, 25, "Benchmark must read 25 dispersed synthetic witnesses");
  assert.deepEqual(
    rows.map((row) => row.product_id),
    ids,
  );
  assert.ok(rows.every((row) => Date.parse(row.valid_until + "Z") > Date.now()));
  return {
    current: rows.length,
    tableCardinality: full.results[0].total,
    sqlMs: result.meta?.duration,
  };
}

async function install() {
  for (const sql of ddl) await d1(sql);
  // Clear any stale stage-only run. Exact table names cannot touch Cove's
  // production legal or catalog schemas, and the Worker never reads these
  // benchmark tables outside explicit private-driver mode.
  for (const table of TABLES) await d1("DELETE FROM " + table);
  const count = await d1("SELECT COUNT(*) n FROM products WHERE id LIKE 'perf-synth-%'");
  assert.equal(
    count.results?.[0]?.n,
    TOTAL_SYNTHETIC_PRODUCTS,
    "Stage products must match exactly the pinned 50k synthetic corpus",
  );
  const scattered = await d1(
    `SELECT COUNT(*) n FROM products WHERE id IN
     (SELECT value FROM json_each(?))`,
    [JSON.stringify(ids)],
  );
  assert.equal(scattered.results?.[0]?.n, 25, "All dispersed synthetic witness IDs must exist");
  await d1("INSERT INTO cove_stage_perf_owner_state VALUES(1,1,1,1)");
  await d1("INSERT INTO cove_stage_perf_territory_revision VALUES('US',1)");
  await d1("INSERT INTO cove_stage_perf_market_revision VALUES('US',1)");
  await d1(
    `INSERT INTO cove_stage_perf_source_revision(product_id,revision)
     SELECT id,1 FROM products WHERE id LIKE 'perf-synth-%'`,
    [],
  );
  const seeded = await d1(
    `INSERT INTO cove_stage_perf_retail_authority
    SELECT id,'US','USD',599,'BENCH-NOT-A-GRANT',1,1,1,1,1,
           'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
           datetime('now','+30 seconds')
    FROM products WHERE id LIKE 'perf-synth-%'`,
    [],
  );
  assert.equal(
    seeded.meta?.changes,
    TOTAL_SYNTHETIC_PRODUCTS,
    "Benchmark fixture must seed all 50k fake positive-shaped entries",
  );
  const result = await verify();
  console.log(
    JSON.stringify({
      event: "cove_stage_bench_fixture_installed",
      ...result,
      releaseCertified: false,
    }),
  );
}

async function cleanup() {
  // Run even after partial installation or failed remote deployment.
  for (const table of TABLES) await d1("DROP TABLE IF EXISTS " + table);
  const r = await d1(
    "SELECT count(*) AS remaining FROM sqlite_master WHERE type='table' AND name LIKE 'cove_stage_perf_%'",
  );
  assert.equal(r.results?.[0]?.remaining, 0, "Synthetic benchmark tables must be gone");
  console.log(JSON.stringify({ event: "cove_stage_bench_fixture_removed", clean: true }));
}

const requested = process.argv.slice(2);
if (requested.length !== 1 || !["--install", "--destroy", "--verify"].includes(requested[0]))
  throw new Error("Only explicit synthetic --install / --verify / --destroy commands permitted");

if (requested[0] === "--install") await install();
else if (requested[0] === "--destroy") await cleanup();
else {
  const result = await verify();
  console.log(JSON.stringify({ event: "cove_stage_bench_fixture_verified", ...result }));
}
