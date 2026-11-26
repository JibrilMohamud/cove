import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  originalQaRoyaltyStatements,
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
const license =
  "Cove original generated QA media: US retail EPUB and audio, isolated Stripe TEST only.";
const licenseDigest = createHash("sha256").update(license).digest("hex");
const audioManifest = JSON.stringify({
  sourceSnapshot: {
    commercialAudio: {
      profile: {
        performanceRightsBasis: "Original generated tone, no third-party recording",
        territoryScope: { mode: "worldwide", exclude: [] },
        offlineEligible: false,
        subscriptionEligible: false,
      },
      chapters: [
        {
          id: "intro",
          title: "Original Generated Test Signal",
          duration_ms: 3000,
          object_key: "original-fixtures/cove-synthetic-tone.wav",
          mime_type: "audio/wav",
          size_bytes: 48044,
          sha256: "synthetic-stage-tone",
        },
      ],
      narrators: [
        { id: "qa-tone", displayName: "Cove Original Synth Tone", narrationType: "synthetic" },
      ],
      agreements: [
        {
          id: "qa-owner-v2-tone-agreement",
          narrator_id: "qa-tone",
          status: "active",
          permittedUses: ["retail", "preview"],
          territories: ["WORLD"],
        },
      ],
    },
  },
}).replaceAll("'", "''");

const sql =
  [
    `INSERT OR IGNORE INTO rights_parties(id,display_name,party_type,created_at,updated_at) VALUES('qa-owner-v2-party','Cove original QA','publisher','${now}','${now}')`,
    `INSERT OR IGNORE INTO rights_contracts(id,reference_code,name,rightsholder_party_id,status,source,notes,created_at,updated_at) VALUES('qa-owner-v2-contract','QA-OWNER-V2','Original QA synthetic media','qa-owner-v2-party','active','sandbox-original-license','${license}','${now}','${now}')`,
    `INSERT OR IGNORE INTO rights_contract_versions(id,contract_id,version_number,status,effective_from,retailer_commission_bps,document_sha256,created_at) VALUES('qa-owner-v2-contract-v1','qa-owner-v2-contract',1,'draft','${now}',10000,'${licenseDigest}','${now}')`,
    `INSERT OR IGNORE INTO rights_contract_version_territories(contract_version_id,territory_code,decision) SELECT id,'US','allow' FROM rights_contract_versions WHERE id='qa-owner-v2-contract-v1' AND status='draft'`,
    `INSERT OR IGNORE INTO rights_contract_version_formats(contract_version_id,format,decision,drm_requirement,offline_permitted) SELECT id,'ebook','allow','none',1 FROM rights_contract_versions WHERE id='qa-owner-v2-contract-v1' AND status='draft'`,
    `INSERT OR IGNORE INTO rights_contract_version_formats(contract_version_id,format,decision,drm_requirement,offline_permitted) SELECT id,'audiobook','allow','none',0 FROM rights_contract_versions WHERE id='qa-owner-v2-contract-v1' AND status='draft'`,
    `INSERT OR IGNORE INTO rights_contract_version_channels(contract_version_id,sales_channel,permitted) SELECT id,'retail',1 FROM rights_contract_versions WHERE id='qa-owner-v2-contract-v1' AND status='draft'`,
    `UPDATE rights_contract_versions SET status='active',approved_by_user_id='qa-synthetic-publisher',approved_at='${now}' WHERE id='qa-owner-v2-contract-v1' AND status='draft'`,
    `INSERT OR IGNORE INTO works(id,title,description,created_at,updated_at) VALUES('qa-owner-v2-ebook-work','Cove Original Synthetic QA Edition','An original synthetic QA work with no third-party copyrighted content','${now}','${now}')`,
    `INSERT OR IGNORE INTO editions(id,work_id,title,description,language,release_status,created_at,updated_at) VALUES('qa-owner-v2-ebook-edition','qa-owner-v2-ebook-work','Cove Synthetic QA Edition','Original QA EPUB chapter','en','available','${now}','${now}')`,
    `INSERT OR IGNORE INTO products(id,edition_id,sku,format,source_name,source_external_id,created_at,updated_at) VALUES('prd_qa_owner_v2_ebook','qa-owner-v2-ebook-edition','QA-OWNER-V2-EPUB','ebook','publisher','qa-owner-v2-ebook','${now}','${now}')`,
    `INSERT OR IGNORE INTO rights_grants(id,edition_id,territory_code,format,license_type,decision,status,source,notes,created_at,contract_id,contract_version_id,rightsholder_party_id) VALUES('qa-owner-v2-ebook-us-retail','qa-owner-v2-ebook-edition','US','ebook','license','allow','active','sandbox-original-license','Original test material, non-production isolated QA only','${now}','qa-owner-v2-contract','qa-owner-v2-contract-v1','qa-owner-v2-party')`,
    `INSERT OR IGNORE INTO offers(id,product_id,offer_type,currency,amount_minor,active,created_at,updated_at) VALUES('qa-owner-v2-ebook-offer','prd_qa_owner_v2_ebook','purchase','USD',100,1,'${now}','${now}')`,
    `INSERT OR IGNORE INTO digital_assets(id,edition_id,kind,current_version_id,created_at,updated_at) VALUES('qa-owner-v2-ebook-asset','qa-owner-v2-ebook-edition','epub','qa-owner-v2-ebook-v1','${now}','${now}')`,
    `INSERT OR IGNORE INTO asset_versions(id,asset_id,version_number,object_key,mime_type,epub_version,created_at) VALUES('qa-owner-v2-ebook-v1','qa-owner-v2-ebook-asset',1,'original-fixtures/cove-synthetic-qa.epub','application/epub+zip','3.0','${now}')`,
    `INSERT OR IGNORE INTO works(id,title,created_at,updated_at) VALUES('qa-owner-v2-audio-work','Cove Synthetic Audio QA','${now}','${now}')`,
    `INSERT OR IGNORE INTO editions(id,work_id,title,created_at,updated_at) VALUES('qa-owner-v2-audio-edition','qa-owner-v2-audio-work','Cove Synthetic Audio QA','${now}','${now}')`,
    `INSERT OR IGNORE INTO products(id,edition_id,sku,format,source_name,source_external_id,created_at,updated_at) VALUES('prd_qa_owner_v2_audio','qa-owner-v2-audio-edition','QA-OWNER-V2-AUDIO','audiobook','publisher','qa-owner-v2-audio','${now}','${now}')`,
    `INSERT OR IGNORE INTO rights_grants(id,edition_id,territory_code,format,license_type,decision,status,source,notes,created_at,contract_id,contract_version_id,rightsholder_party_id) VALUES('qa-owner-v2-audio-us-retail','qa-owner-v2-audio-edition','US','audiobook','license','allow','active','sandbox-original-license','Original generated QA tone','${now}','qa-owner-v2-contract','qa-owner-v2-contract-v1','qa-owner-v2-party')`,
    `INSERT OR IGNORE INTO offers(id,product_id,offer_type,currency,amount_minor,active,created_at,updated_at) VALUES('qa-owner-v2-audio-offer','prd_qa_owner_v2_audio','purchase','USD',100,1,'${now}','${now}')`,
    `INSERT OR IGNORE INTO publishing_accounts(id,account_type,legal_name,display_name,country_code,status,created_at,updated_at) VALUES('qa-owner-v2-publisher','person','Original QA Test','Cove Original QA','US','active','${now}','${now}')`,
    `INSERT OR IGNORE INTO publishing_titles(id,account_id,title,language,status,catalog_work_id,created_at,updated_at) VALUES('qa-owner-v2-audio-title','qa-owner-v2-publisher','Cove Original Audio QA','en','published','qa-owner-v2-audio-work','${now}','${now}')`,
    `INSERT OR IGNORE INTO publishing_edition_drafts(id,title_id,format,edition_label,language,status,catalog_edition_id,catalog_product_id,created_at,updated_at) VALUES('qa-owner-v2-audio-draft','qa-owner-v2-audio-title','audiobook','Test Original Audio','en','published','qa-owner-v2-audio-edition','prd_qa_owner_v2_audio','${now}','${now}')`,
    `INSERT OR IGNORE INTO commercial_audio_profiles(edition_id,publishing_account_id,active_policy_id,audio_publisher,performance_rights_basis,identifier_type,identifier_value,updated_at,created_at) VALUES('qa-owner-v2-audio-draft','qa-owner-v2-publisher','audiopol_fore_commercial_audio_v1','Cove QA Only','Owned: original synthetic recording','other','qa-owner-v2-tone','${now}','${now}')`,
    `INSERT OR IGNORE INTO publishing_submission_snapshots(id,edition_id,account_id,revision,snapshot_json,snapshot_sha256,status,submitted_by_user_id,submitted_at) VALUES('qa-owner-v2-audio-submission','qa-owner-v2-audio-draft','qa-owner-v2-publisher',1,'{}','qa-synthetic-snapshot','published','qa-synthetic-publisher','${now}')`,
    `INSERT OR IGNORE INTO publishing_publications(id,submission_id,publishing_account_id,work_id,edition_id,product_id,offer_id,materialization_key,published_at) VALUES('qa-owner-v2-audio-publication','qa-owner-v2-audio-submission','qa-owner-v2-publisher','qa-owner-v2-audio-work','qa-owner-v2-audio-edition','prd_qa_owner_v2_audio','qa-owner-v2-audio-offer','qa-owner-v2-audio-v1','${now}')`,
    `INSERT OR IGNORE INTO publishing_release_lifecycles(id,publishing_edition_id,state,created_at,updated_at) VALUES('qa-owner-v2-audio-lifecycle','qa-owner-v2-audio-draft','live','${now}','${now}')`,
    `INSERT OR IGNORE INTO publishing_publication_versions(id,lifecycle_id,publication_id,submission_id,version_number,snapshot_sha256,manifest_json,release_state,activated_at,created_by_user_id,created_at) VALUES('qa-owner-v2-audio-version','qa-owner-v2-audio-lifecycle','qa-owner-v2-audio-publication','qa-owner-v2-audio-submission',1,'qa-synthetic-snapshot','${audioManifest}','live','${now}','qa-synthetic-publisher','${now}')`,
    `UPDATE publishing_release_lifecycles SET current_publication_version_id='qa-owner-v2-audio-version' WHERE id='qa-owner-v2-audio-lifecycle'`,
    ...originalQaRoyaltyStatements(now),
  ].join(";") + ";";
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
