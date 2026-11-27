import assert from "node:assert/strict";
import { originalCommerceQaCatalogSql } from "./original-commerce-qa-catalog.mjs";
import {
  originalQaRoyaltyCoverageSql,
  assertOriginalQaRoyaltyCoverage,
} from "./original-commerce-qa-royalties.mjs";

// Seed only the separate, non-routable customer QA database. All content is
// synthetic and original; nobody can purchase it in customer production.
const account = "f51e8ccbc394e2d6016ff8c2c303d54b";
const db = "f9354381-bd9f-496b-bd05-d6f62a32ec0c";
const bucket = "cove-commerce-detached-media-qa";
const d1Token = process.env.COVE_CF_QA_D1_MUTATION_TOKEN;
const r2Token = process.env.COVE_CF_QA_R2_STORAGE_TOKEN;
assert.equal(process.env.CLOUDFLARE_ACCOUNT_ID, account);
assert.ok(d1Token && r2Token && d1Token !== r2Token);
async function api(method, path, body) {
  const response = await fetch("https://api.cloudflare.com/client/v4" + path, {
    method,
    headers: {
      authorization: "Bearer " + (path.includes("/r2/buckets/") ? r2Token : d1Token),
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
assert.equal(meta.name, "cove-commerce-customer-detached-qa");
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
const sql = originalCommerceQaCatalogSql(now);
await api("POST", "/accounts/" + account + "/d1/database/" + db + "/query", { sql });
// A newly detached database has no prior search projection. Populate only
// the two original QA fixtures, from their actual active offer and edition.
// The catalog's FTS triggers maintain its search index. No fabricated rights.
const indexSql = `INSERT OR IGNORE INTO catalog_search_documents(
  product_id,external_book_id,title,description,languages_text,format,currency,
  price_minor,availability,suppressed,first_ingested_at,updated_at)
  SELECT p.id,p.source_external_id,e.title,COALESCE(e.description,''),
    e.language,p.format,o.currency,o.amount_minor,'available',0,p.created_at,p.updated_at
  FROM products p JOIN editions e ON e.id=p.edition_id
  JOIN offers o ON o.product_id=p.id AND o.active=1 AND o.currency='USD'
    AND o.sales_channel='retail'
  WHERE p.id IN ('prd_qa_owner_v2_ebook','prd_qa_owner_v2_audio')
    AND p.storefront_status='active' AND e.release_status IN ('available','preorder')
    AND EXISTS (SELECT 1 FROM retail_product_availability_rows r
      WHERE r.product_id=p.id AND r.territory_code='US')`;
await api("POST", "/accounts/" + account + "/d1/database/" + db + "/query", { sql: indexSql });
const indexed = await api("POST", "/accounts/" + account + "/d1/database/" + db + "/query", {
  sql: `SELECT d.product_id,d.currency,d.price_minor FROM catalog_search_documents d
    JOIN products p ON p.id=d.product_id
    WHERE d.product_id IN ('prd_qa_owner_v2_ebook','prd_qa_owner_v2_audio')
      AND d.availability='available' AND d.suppressed=0 AND d.currency='USD'
      AND d.price_minor=100 AND p.storefront_status='active'
      AND EXISTS (SELECT 1 FROM retail_product_availability_rows r
        WHERE r.product_id=p.id AND r.territory_code='US') ORDER BY d.product_id`,
});
assert.deepEqual(
  indexed[0].results.map((row) => row.product_id),
  ["prd_qa_owner_v2_audio", "prd_qa_owner_v2_ebook"],
  "Both original QA products must have real US-authorized search projections",
);
const rows = await api("POST", "/accounts/" + account + "/d1/database/" + db + "/query", {
  sql: "SELECT p.id,o.amount_minor,rg.territory_code,av.object_key FROM products p JOIN offers o ON o.product_id=p.id JOIN rights_grants rg ON rg.edition_id=p.edition_id JOIN digital_assets da ON da.edition_id=p.edition_id JOIN asset_versions av ON av.asset_id=da.id WHERE p.id='prd_qa_owner_v2_ebook'",
});
assert.equal(rows[0].results?.length, 1, "Synthetic purchased-book source is not joined");
assert.equal(rows[0].results[0].amount_minor, 100);
const audio = await api("POST", "/accounts/" + account + "/d1/database/" + db + "/query", {
  sql: "SELECT p.id,p.format,o.amount_minor,ped.status,pv.release_state FROM products p JOIN offers o ON o.product_id=p.id JOIN publishing_edition_drafts ped ON ped.catalog_product_id=p.id JOIN publishing_release_lifecycles l ON l.publishing_edition_id=ped.id JOIN publishing_publication_versions pv ON pv.id=l.current_publication_version_id WHERE p.id='prd_qa_owner_v2_audio'",
});
assert.equal(audio[0].results?.length, 1, "Original published-audio fixture missing");
assert.equal(audio[0].results[0].release_state, "live");
assert.equal(audio[0].results[0].amount_minor, 100);
const royalty = await api("POST", "/accounts/" + account + "/d1/database/" + db + "/query", {
  sql: originalQaRoyaltyCoverageSql(new Date().toISOString()),
});
assertOriginalQaRoyaltyCoverage(royalty[0].results);
console.log(
  "PASS: original US-only, $1 test EPUB and published WAV fixtures with exact royalty terms seeded in isolated QA D1.",
);
