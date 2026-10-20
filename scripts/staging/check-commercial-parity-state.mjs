import assert from "node:assert/strict";
import fs from "node:fs";

const account = "d26430caa63ec55f6612e32f36aca5e9";
const target = "ce0e67b7-692d-44c6-94dc-7f324e7c5421";
const source = "4bd657ac-8789-403e-a28c-93aba8d0a989";
const token = process.env.CLOUDFLARE_API_TOKEN;
assert.ok(token?.length > 24, "Staging schema verifier requires Cloudflare credentials");

async function query(db, sql) {
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${account}/d1/database/${db}/query`,
    {
      method: "POST",
      headers: { Authorization: `*** "Content-Type": "application/json" },
      body: JSON.stringify({ sql }),
      signal: AbortSignal.timeout(30000),
    },
  );
  const data = await res.json();
  if (!res.ok || !data.success) throw Error("D1 schema-state query unavailable");
  return data.result?.[0]?.results || [];
}
const definitions = async (id) => {
  const rows = [];
  for (let offset = 0; offset < 5000; offset += 100) {
    const page = await query(
      id,
      "SELECT type,name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name!='_cf_KV'" +
        " ORDER BY type,name LIMIT 100 OFFSET " +
        offset,
    );
    rows.push(...page);
    if (page.length < 100) break;
  }
  return new Set(rows.map((x) => String(x.type) + ":" + String(x.name)));
};
const stageNames = await definitions(target);
const sourceNames = await definitions(source);
assert.ok(sourceNames.size > 1100, "Source production schema unexpectedly sparse");
let mode;
if (stageNames.size === 0) mode = "empty";
else {
  assert.deepEqual(
    [...stageNames].sort(),
    [...sourceNames].sort(),
    "Staging schema drift: never silently overwrite a populated DB",
  );
  const rows = await query(
    target,
    "SELECT (SELECT count(*) FROM products) products," +
      " (SELECT count(*) FROM works) works," +
      " (SELECT count(*) FROM auth_accounts) accounts," +
      " (SELECT count(*) FROM commerce_orders) orders," +
      " (SELECT count(*) FROM rights_grants) grants," +
      " (SELECT count(*) FROM soundtrack_recordings) audio," +
      " (SELECT count(*) FROM products WHERE id NOT LIKE 'p_stage_%') foreign_products," +
      " (SELECT count(*) FROM works WHERE id NOT LIKE 'w_stage_%') foreign_works," +
      " (SELECT count(*) FROM rights_grants WHERE id NOT LIKE 'rg_stage_%') foreign_grants",
  );
  const state = rows[0] || {};
  assert.equal(state.accounts, 0, "Stage must not contain real user accounts");
  assert.equal(state.orders, 0, "Stage must not contain real orders");
  assert.equal(state.audio, 0, "Stage must not contain unapproved recordings");
  assert.equal(state.foreign_products, 0, "Stage has non-synthetic products");
  assert.equal(state.foreign_works, 0, "Stage has non-synthetic works");
  assert.equal(state.foreign_grants, 0, "Stage has non-synthetic rights grants");
  assert.equal(state.products, 1000);
  assert.equal(state.works, 1000);
  assert.equal(state.grants, 1000);
  mode = "ready";
}
if (process.env.GITHUB_OUTPUT)
  fs.appendFileSync(process.env.GITHUB_OUTPUT, "parity_mode=" + mode + "\n");
console.log(
  JSON.stringify({
    mode,
    schemaObjects: stageNames.size,
    sourceSchemaObjects: sourceNames.size,
    customerAccounts: 0,
    paymentOrders: 0,
    dataSource: "synthetic-only",
  }),
);
