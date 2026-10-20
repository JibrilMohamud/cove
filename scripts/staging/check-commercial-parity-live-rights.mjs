import assert from "node:assert/strict";
import fs from "node:fs";

const account = "d26430caa63ec55f6612e32f36aca5e9";
const database = "ce0e67b7-692d-44c6-94dc-7f324e7c5421";
const origin = "https://cove-commercial-parity-ssr-staging-20261020.cove-jibrilmohamud.workers.dev";
const admin = process.env.CLOUDFLARE_API_TOKEN;
const gate = process.env.COVE_SSR_STAGING_GATE_KEY;
assert.ok(admin?.length > 24);
assert.match(gate || "", /^[a-f0-9]{64}$/);
const endpoint = `https://api.cloudflare.com/client/v4/accounts/${account}/d1/database/${database}`;
async function control(suffix, body) {
  const response = await fetch(endpoint + suffix, {
    method: body ? "POST" : "GET",
    headers: { Authorization: "Bearer " + admin, "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
    redirect: "error",
    signal: AbortSignal.timeout(30000),
  });
  const result = await response.json();
  assert.ok(response.ok && result.success, "Isolated D1 control request must succeed");
  return result.result;
}
async function query(sql, params = []) {
  return (await control("/query", { sql, params }))[0].results;
}
async function read(path) {
  const response = await fetch(origin + path, {
    headers: { Authorization: "Bearer " + gate, "Cache-Control": "no-store" },
    redirect: "error",
    signal: AbortSignal.timeout(15000),
  });
  assert.equal(response.status, 200, "Live rights probe must return actual authorized data");
  assert.match(response.headers.get("cache-control") || "", /no-store/);
  const value = await response.json();
  if (path.includes("/bootstrap")) assert.equal(value.context.rightsCountry, "US");
  const books = value.catalog?.results || value.results;
  assert.ok(Array.isArray(books) && books.length > 0);
  assert.ok(books.every((book) => /^p_stage_[0-9]{6}$/.test(book.productId)));
  return books;
}
const metadata = await control("");
assert.equal(metadata.name, "cove-commercial-parity-stage-20261020");
const state = (await query(
  "SELECT (SELECT count(*) FROM auth_accounts) accounts," +
  "(SELECT count(*) FROM commerce_orders) orders," +
  "(SELECT count(*) FROM products WHERE id NOT LIKE 'p_stage_%') foreign_products," +
  "(SELECT count(*) FROM rights_grants WHERE id NOT LIKE 'rg_stage_%') foreign_grants",
))[0];
assert.deepEqual(state, { accounts: 0, orders: 0, foreign_products: 0, foreign_grants: 0 });
const bootstrap = "/api/fore/storefront/bootstrap";
const catalog = "/api/fore/catalog?search=&sort=popular&page=1&currency=USD";
const selected = (await read(bootstrap))[0].productId;
const grantId = "rg_stage_" + selected.slice("p_stage_".length);
const grant = (await query(
  "SELECT rg.id,rg.decision,rg.status FROM rights_grants rg JOIN products p " +
  "ON p.edition_id=rg.edition_id WHERE rg.id=? AND p.id=? AND rg.source='operator-test-fixture'",
  [grantId, selected],
))[0];
assert.deepEqual(grant, { id: grantId, decision: "allow", status: "active" });
const report = {
  scope: "Two actual stage API routes; dedicated synthetic D1 only; no customer or production data",
  concurrentReads: 32,
  denied: false,
  restored: false,
  commercialCertified: false,
};
try {
  const changed = await query(
    "UPDATE rights_grants SET decision='deny' WHERE id=? AND decision='allow' " +
    "AND status='active' AND source='operator-test-fixture' RETURNING id",
    [grantId],
  );
  assert.equal(changed.length, 1);
  // Every read starts after the committed deny. Already-warm public candidate
  // caches must never override live primary territorial-rights enforcement.
  const pages = await Promise.all(Array.from({ length: 32 }, (_, index) =>
    read(index % 2 ? catalog : bootstrap),
  ));
  assert.ok(pages.every((books) => books.every((book) => book.productId !== selected)));
  report.denied = true;
} finally {
  // Restore only this known synthetic row; keep its append-only audit history.
  await query(
    "UPDATE rights_grants SET decision='allow' WHERE id=? AND decision='deny' " +
    "AND source='operator-test-fixture'",
    [grantId],
  );
  const finalGrant = (await query("SELECT decision FROM rights_grants WHERE id=?", [grantId]))[0];
  assert.equal(finalGrant.decision, "allow");
  assert.ok((await read(bootstrap)).some((book) => book.productId === selected));
  report.restored = true;
  fs.mkdirSync("artifacts", { recursive: true });
  fs.writeFileSync("artifacts/commercial-parity-live-rights.json", JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
}
