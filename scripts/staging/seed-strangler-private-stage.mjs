import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const DB_ID = "e4cbb0ef-6288-4fa1-9dbb-fb42fe01d4f3";
const BUCKET = "cove-strangler-private-presentation-stage";
const MAX_AGE_MS = 20 * 60_000;
const dir = ".output/strangler/private-seeding";
const account = process.env.CLOUDFLARE_ACCOUNT_ID || "";
const token = process.env.CLOUDFLARE_API_TOKEN || "";
assert.match(account, /^[a-f0-9]{32}$/);
assert.ok(token.length >= 20);
const producer = JSON.parse(
  fs.readFileSync("wrangler.storefront-candidate-producer.stage.jsonc", "utf8"),
);
const storefront = JSON.parse(
  fs.readFileSync("wrangler.storefront-strangler.stage.jsonc", "utf8"),
);
assert.equal(producer.d1_databases?.[0]?.database_id, DB_ID);
assert.equal(storefront.d1_databases?.[0]?.database_id, DB_ID);
assert.equal(producer.r2_buckets?.[0]?.bucket_name, BUCKET);
assert.equal(producer.workers_dev, false);
assert.equal(producer.preview_urls, false);
assert.ok(!producer.routes && !producer.triggers);
fs.mkdirSync(dir, { recursive: true });

const endpoint = "https://api.cloudflare.com/client/v4/accounts/" +
  account + "/d1/database/" + DB_ID + "/query";
async function readOnly(sql, params = []) {
  assert.match(sql.trim(), /^SELECT\b/i);
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      authorization: "Bearer " + token,
      "content-type": "application/json",
    },
    body: JSON.stringify({ sql, params }),
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) throw Error("Synthetic D1 read refused: " + response.status);
  const data = await response.json();
  const first = data.result?.[0];
  if (!data.success || !first?.success || !Array.isArray(first.results))
    throw Error("Synthetic D1 query failed");
  return first.results;
}
const markets = await readOnly(
  "SELECT country_code FROM storefront_markets WHERE market_status='active' ORDER BY country_code LIMIT 33",
);
assert.ok(markets.length > 0 && markets.length <= 32);
const countries = markets.map((row) => String(row.country_code));
assert.ok(countries.includes("US"), "Staging must contain an active US market");
for (const country of countries) {
  if (!/^[A-Z]{2}$/.test(country)) throw Error("Invalid isolated market");
  const selected = await readOnly(
    [
      "SELECT COALESCE(",
      "(SELECT default_currency FROM storefront_markets WHERE country_code=? AND market_status='active'),",
      "(SELECT default_currency FROM storefront_markets WHERE country_code='US' AND market_status='active')) currency",
    ].join(" "),
    [country],
  );
  const currency = String(selected[0]?.currency || "");
  if (!/^[A-Z]{3}$/.test(currency)) throw Error("Invalid synthetic currency");
  const candidates = await readOnly(
    [
      "SELECT d.product_id FROM catalog_search_documents d INDEXED BY idx_search_popular_stable",
      "JOIN products p ON p.id=d.product_id JOIN editions e ON e.id=p.edition_id",
      "WHERE d.currency=? AND d.availability='available' AND d.suppressed=0",
      "AND p.storefront_status='active' AND p.source_name<>'upload'",
      "AND e.release_status IN ('available','preorder')",
      "AND EXISTS (SELECT 1 FROM retail_product_availability_rows rpa",
      "WHERE rpa.product_id=p.id AND rpa.territory_code=?)",
      "ORDER BY d.fore_bestseller_score DESC,d.external_book_id ASC,d.product_id ASC LIMIT 128",
    ].join(" "),
    [currency, country],
  );
  const productIds = candidates.map((row) => String(row.product_id));
  if (
    productIds.length > 128 ||
    new Set(productIds).size !== productIds.length ||
    productIds.some((id) => !/^[A-Za-z0-9][A-Za-z0-9_-]{1,159}$/.test(id))
  ) throw Error("Invalid private candidate IDs");
  if (country === "US" && !productIds.length)
    throw Error("No available US books in synthetic stage");
  const now = Date.now();
  const data = JSON.stringify({
    schema: "cove.home.candidates.v1",
    country,
    currency,
    createdAt: now,
    expiresAt: now + MAX_AGE_MS,
    productIds,
  });
  if (Buffer.byteLength(data) > 16384) throw Error("Private candidate snapshot too large");
  const file = path.join(dir, country + ".json");
  fs.writeFileSync(file, data, { mode: 0o600 });
  const key = BUCKET + "/private/presentation/v1/home/" + country + ".json";
  try {
    execFileSync(
      "npm",
      [
        "exec", "--yes", "--package=wrangler@4.151.0", "--", "wrangler",
        "r2", "object", "put", key, "--remote", "--file", file,
        "--content-type", "application/json",
      ],
      { encoding: "utf8", stdio: "pipe", timeout: 60000 },
    );
  } catch {
    throw Error("Private staging R2 write unavailable for " + country);
  }
  console.log(
    "COVE_STAGE_PRIVATE_SNAPSHOT " +
      JSON.stringify({ country, candidates: productIds.length, rights: "uncached-primary" }),
  );
}
const downloaded = path.join(dir, "verify-us.json");
try {
  execFileSync(
    "npm",
    [
      "exec", "--yes", "--package=wrangler@4.151.0", "--", "wrangler",
      "r2", "object", "get",
      BUCKET + "/private/presentation/v1/home/US.json",
      "--remote", "--file", downloaded,
    ],
    { encoding: "utf8", stdio: "pipe", timeout: 60000 },
  );
} catch {
  throw Error("Private R2 seeded object verification failed");
}
const verified = JSON.parse(fs.readFileSync(downloaded, "utf8"));
if (
  verified.schema !== "cove.home.candidates.v1" ||
  verified.country !== "US" ||
  !Array.isArray(verified.productIds) ||
  !verified.productIds.length ||
  verified.expiresAt <= Date.now()
) throw Error("Private seed failed structural verification");
console.log("COVE_PRIVATE_STAGE_SEED_PASS: verified remote R2 object, no grant cached");
