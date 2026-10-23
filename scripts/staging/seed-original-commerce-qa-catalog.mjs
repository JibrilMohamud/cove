import assert from "node:assert/strict";

// Seed only the separate, non-routable customer QA database. All content is
// synthetic and original; nobody can purchase it in customer production.
const account = "d26430caa63ec55f6612e32f36aca5e9";
const db = "5be15110-44a6-4090-b0a1-36599d809b28";
const bucket = "cove-commerce-original-media-qa-20261022";
const token = process.env.CLOUDFLARE_API_TOKEN;
assert.equal(process.env.CLOUDFLARE_ACCOUNT_ID, account);
assert.ok(token);
async function api(method, path, body) {
  const response = await fetch("https://api.cloudflare.com/client/v4" + path, {
    method,
    headers: {
      authorization: "Bearer " + token,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(20000),
  });
  const result = await response.json();
  assert.ok(response.ok && result.success, "Private QA request failed (" + response.status + ")");
  return result.result;
}
const meta = await api("GET", "/accounts/" + account + "/d1/database/" + db);
assert.equal(meta.name, "cove-commerce-customer-qa-20261022");
const objects = await api(
  "GET",
  "/accounts/" + account + "/r2/buckets/" + bucket + "/objects?per_page=50",
);
assert.ok(
  objects.some((item) => item.key === "original-fixtures/cove-synthetic-qa.epub"),
  "Remote original synthetic EPUB has not been verified",
);
assert.ok(
  objects.some((item) => item.key === "original-fixtures/cove-synthetic-tone.wav"),
  "Remote original synthetic WAV has not been verified",
);
const now = new Date().toISOString();
const sql = [
  `INSERT OR IGNORE INTO works(id,title,description,created_at,updated_at) VALUES('qa-original-ebook-work','Cove Original Synthetic QA Edition','An original synthetic QA work with no third-party copyrighted content','${now}','${now}')`,
  `INSERT OR IGNORE INTO editions(id,work_id,title,description,language,release_status,created_at,updated_at) VALUES('qa-original-ebook-edition','qa-original-ebook-work','Cove Synthetic QA Edition','Original QA EPUB chapter','en','available','${now}','${now}')`,
  `INSERT OR IGNORE INTO products(id,edition_id,sku,format,source_name,source_external_id,created_at,updated_at) VALUES('qa-original-ebook-product','qa-original-ebook-edition','QA-ORIGINAL-EPUB','ebook','publisher','qa-original-ebook','${now}','${now}')`,
  `INSERT OR IGNORE INTO rights_grants(id,edition_id,territory_code,format,license_type,decision,status,source,notes,created_at) VALUES('qa-original-ebook-us-retail','qa-original-ebook-edition','US','ebook','license','allow','active','sandbox-original-license','Original test material, non-production isolated QA only','${now}')`,
  `INSERT OR IGNORE INTO offers(id,product_id,offer_type,currency,amount_minor,active,created_at,updated_at) VALUES('qa-original-ebook-offer','qa-original-ebook-product','purchase','USD',100,1,'${now}','${now}')`,
  `INSERT OR IGNORE INTO digital_assets(id,edition_id,kind,current_version_id,created_at,updated_at) VALUES('qa-original-ebook-asset','qa-original-ebook-edition','epub','qa-original-ebook-v1','${now}','${now}')`,
  `INSERT OR IGNORE INTO asset_versions(id,asset_id,version_number,object_key,mime_type,epub_version,created_at) VALUES('qa-original-ebook-v1','qa-original-ebook-asset',1,'original-fixtures/cove-synthetic-qa.epub','application/epub+zip','3.0','${now}')`,
].join(";") + ";";
await api("POST", "/accounts/" + account + "/d1/database/" + db + "/query", { sql });
const rows = await api("POST", "/accounts/" + account + "/d1/database/" + db + "/query", {
  sql: "SELECT p.id,o.amount_minor,rg.territory_code,av.object_key FROM products p JOIN offers o ON o.product_id=p.id JOIN rights_grants rg ON rg.edition_id=p.edition_id JOIN digital_assets da ON da.edition_id=p.edition_id JOIN asset_versions av ON av.asset_id=da.id WHERE p.id='qa-original-ebook-product'",
});
assert.equal(rows[0].results?.length, 1, "Synthetic purchased-book source is not joined");
assert.equal(rows[0].results[0].amount_minor, 100);
console.log("PASS: original US-only, $1 TEST EPUB catalog item seeded into isolated QA D1.");
