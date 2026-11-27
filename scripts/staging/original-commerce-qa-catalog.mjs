// Pure synthetic fixture shared by protected provisioning and full-schema regression.
import { createHash } from "node:crypto";
import { originalQaRoyaltyStatements } from "./original-commerce-qa-royalties.mjs";

export function originalCommerceQaCatalogSql(now) {
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
  return sql;
}
