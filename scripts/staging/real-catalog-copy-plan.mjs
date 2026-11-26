/* eslint-disable prettier/prettier -- Keep the reviewed column projection compact and auditable. */
// Exact isolated target already created by a separately authorized provider operation.
// Never use a full production dump, raw caller-supplied SQL or a production D1 binding.
export const account="d26430caa63ec55f6612e32f36aca5e9";
export const source="4bd657ac-8789-403e-a28c-93aba8d0a989";
export const target="15ce2ea3-17f8-4d99-9015-a78a6a3af05d";
export const targetName="cove-real-catalog-snapshot-20261125";
export const maxBytes=1_250_000;
export const pageSize=2800;
const wideTables=new Set(["works","editions","gutenberg_source_cache","catalog_search_documents","contributors","edition_accessibility_profiles","edition_format_profiles"]);
export function pageLimit(item){return wideTables.has(item.table)?700:pageSize;}
const spec=(table,key,cols,filter="1=1",redact={})=>({
  table,keys:key.split(" "),columns:cols.split(" "),filter,redact
});
const linkedCache="EXISTS (SELECT 1 FROM products p WHERE p.source_name='gutenberg' AND p.source_external_id=gutenberg_source_cache.id)";
export const plan=[
  spec("contributors","id","id name sort_name bio created_at updated_at slug website image_url"),
  spec("subjects","id","id scheme code name normalized_name parent_id created_at updated_at"),
  spec("works","id","id title subtitle description original_publication_date original_language min_age max_age content_warnings created_at updated_at work_type canonical_status public_id"),
  spec("editions","id","id work_id publisher_id imprint_id title subtitle description edition_number language original_language publication_date release_date preorder_date isbn13 publisher_identifier page_estimate word_count reading_time_minutes file_size_bytes epub_version layout drm_status downloadable release_status subscription_eligible library_eligible publisher_description editorial_reviews created_at updated_at edition_type differentiation_status differentiation_summary canonical_public_domain public_id"),
  spec("products","id","id edition_id sku format storefront_status source_name source_external_id created_at updated_at public_id","source_name='gutenberg'"),
  spec("gutenberg_source_cache","id","id title authors_json summary subjects_json bookshelves_json languages_json formats_json download_count copyright source_url source_updated_at first_ingested_at updated_at last_seen_at ingest_status ingest_attempts last_error epub_status epub_attempts epub_next_attempt_at epub_cached_at epub_last_error source_id source_item_id source_project source_license_url rights_status rights_territories_json rights_evidence_url rights_checked_at rights_evidence_id commercial_use_status trademark_cleanup_required canonicalization_version source_metadata_json content_hash",linkedCache,{last_error:"''",epub_last_error:"''",source_metadata_json:"'{}'"}),
  spec("digital_assets","id","id edition_id kind current_version_id drm_status downloadable created_at updated_at"),
  spec("asset_versions","id","id asset_id version_number object_key source_url mime_type size_bytes sha256 epub_version created_at","1=1",{object_key:"CASE WHEN object_key IS NOT NULL AND length(object_key)>0 THEN 'snapshot-only/'||id ELSE NULL END"}),
  spec("rights_parties","id","id display_name party_type publisher_id contributor_id contact_email reference_code status created_at updated_at","1=1",{contact_email:"''",reference_code:"''"}),
  spec("gutenberg_rights_evidence","id","id source_id cache_id source_item_id determination territory_code evidence_url evidence_type evidence_hash parser_version status checked_at created_at"),
  spec("rights_grants","id","id edition_id rightsholder_id territory_code format sales_channel starts_at ends_at license_type drm_requirement subscription_permitted library_permitted created_at rightsholder_party_id decision status promotion_restrictions_json contract_reference source notes updated_at contract_id exclusivity scope_summary source_evidence_id contract_version_id","source LIKE 'gutenberg-%' AND contract_id IS NULL AND contract_version_id IS NULL",{notes:"''",contract_reference:"''"}),
  spec("rights_grant_territories","grant_id territory_code","grant_id territory_code resolved_from snapshotted_at"),
  spec("rights_grant_territory_scopes","id","id grant_id effect target_type territory_code territory_set_id historical_code as_of_date position created_at"),
  spec("rights_grant_scope_snapshots","id","id grant_id scope_json territories_json recorded_at"),
  spec("edition_contributors","edition_id contributor_id role","edition_id contributor_id role position"),
  spec("edition_subjects","edition_id subject_id","edition_id subject_id position source"),
  spec("edition_categories","edition_id category_id","edition_id category_id position"),
  spec("edition_languages","edition_id language_code kind","edition_id language_code kind"),
  spec("keywords","id","id value"),
  spec("edition_keywords","edition_id keyword_id","edition_id keyword_id"),
  spec("series","id","id name description publisher_id created_at updated_at slug series_type hero_image_url status"),
  spec("series_memberships","series_id edition_id","series_id edition_id position label relationship reading_order display_order"),
  spec("edition_taxonomy_nodes","edition_id taxonomy_node_id","edition_id taxonomy_node_id source confidence is_primary created_at"),
  spec("external_identifiers","entity_type entity_id scheme","entity_type entity_id scheme value","entity_type IN ('edition','product','work')"),
  spec("catalog_public_aliases","entity_type alias","entity_type alias entity_id alias_kind canonical created_at","entity_type IN ('edition','product','work')"),
  spec("offers","id","id product_id offer_type currency amount_minor active starts_at ends_at created_at updated_at tax_behavior tax_code sales_channel"),
  spec("accessibility_metadata","edition_id","edition_id screen_reader_compatible alt_text_complete semantic_structure accessibility_summary certifier updated_at"),
  spec("edition_accessibility_profiles","edition_id","edition_id source_asset_version_id visual_adjustments nonvisual_reading primary_language_declared reading_order_verified table_semantics_complete mathml_present mathml_accessible page_navigation accessibility_navigation access_modes_json access_mode_sufficient_json features_json hazards_json conforms_to_json certification_json accessibility_summary validation_policy_version validation_status validation_report_json publisher_declaration_json updated_at"),
  spec("edition_format_profiles","edition_id","edition_id source_asset_version_id epub_version package_version navigation_type rendition_layout page_progression_direction writing_mode rtl vertical_writing complex_css embedded_fonts svg mathml complex_tables footnotes endnotes dictionary_content media_overlays oversized_images accessibility_navigation compatibility_class reader_support features_json warnings_json updated_at"),
  spec("product_rankings","product_id ranking_scope ranking_key window","product_id ranking_scope ranking_key rank score window updated_at"),
  spec("catalog_state","id","id next_url page status last_run_at last_success_at last_error attempts total_catalog_count cycle_started_at next_run_at lease_token lease_until","1=1",{next_url:"NULL",last_error:"''",lease_token:"NULL",lease_until:"NULL"}),
  spec("search_index_state","id","id backend index_uid settings_version last_synced_at last_error documents_indexed sync_lease_token sync_lease_until","backend='d1'",{last_error:"''",sync_lease_token:"NULL",sync_lease_until:"NULL"}),
  spec("catalog_search_documents","product_id","product_id external_book_id title subtitle contributors_text subjects_text bookshelves_text categories_text languages_text keywords_text description download_count release_date first_ingested_at updated_at publisher_text imprint_text series_text isbn13 format currency price_minor subscription_eligible library_eligible average_rating review_count sales_velocity merchandising_boost availability is_deal suppressed publication_date preorder_date product_created_at product_updated_at taxonomy_text fore_bestseller_score fore_trending_score fore_read_score fore_wishlist_score fore_rating_score fore_noteworthy_score")
];
export const initialTables=["territories","territory_historical_entities","territory_historical_successors","territory_aliases","territory_sets","territory_set_members","territory_set_rules","publishers","imprints","gutenberg_sources","categories","storefront_taxonomies","storefront_taxonomy_nodes","storefront_locales","storefront_markets","storefront_market_locales","storefront_currency_options","storefront_payment_methods","storefront_taxonomy_node_localizations","ui_translation_bundles","ui_translation_messages","storefront_pages","search_synonyms"];
// These tables are required for query/schema compatibility, never for copying private rows.
export const mustBeEmpty=["api_cache","reviews","search_index_outbox","search_query_events","storefront_user_preferences","personal_imports","publishing_release_lifecycles","publishing_publication_versions","publishing_publications","publishing_publication_disclosures","publishing_edition_drafts","publishing_submission_snapshots","publishing_accounts","finance_royalty_contracts","publishing_asset_versions","publishing_ai_disclosures","publishing_titles","finance_parties","publishing_assets","rights_contracts","rights_contract_versions","rights_contract_version_territories","rights_contract_version_formats","rights_contract_version_channels","rights_contract_languages","promotions","search_merchandising_rules"];
export const forbiddenSourceRows=["rights_contracts","rights_contract_versions","rights_contract_languages","rights_contract_version_territories","rights_contract_version_formats","rights_contract_version_channels","publishing_publications","promotions","search_merchandising_rules","rights_grant_scope_snapshots","edition_accessibility_profiles","edition_format_profiles"];
const identifier=(s)=>{if(!/^[a-z][a-z0-9_]*$/.test(s))throw Error("Invalid identifier");return '"'+s+'"';};
export function readSql(item,last=null,targetRead=false,limit=pageLimit(item)){
  if(!Number.isSafeInteger(limit)||limit<1||limit>pageLimit(item))throw Error("Invalid page limit");
  const cs=item.columns.map(c=>targetRead?identifier(c):(item.redact[c]||identifier(c))+" AS "+identifier(c));
  const keys=item.keys.map(identifier);
  return "SELECT "+cs.join(",")+" FROM "+identifier(item.table)+" WHERE "+(targetRead?"1=1":item.filter)+(last===null?"":" AND ("+keys.join(",")+") > ("+keys.map(()=>"?").join(",")+")").replace(/^ AND \(([^,()]+)\) > \(\?\)$/," AND $1 > ?")+" ORDER BY "+keys.join(",")+" LIMIT "+limit;
}
export function insertSql(item){
  const columns=item.columns.map(identifier), keys=item.keys.map(identifier);
  const updates=columns.filter(c=>!keys.includes(c));
  const values=columns.map((_,i)=>"json_extract(value,'$["+i+"]')");
  // WHERE 1 disambiguates UPSERT from a SELECT join; unchanged rows do not
  // fire update triggers. Resuming the prior partial copy is safe.
  return "INSERT INTO "+identifier(item.table)+"("+columns.join(",")+") SELECT "+values.join(",")+" FROM json_each(?) WHERE 1 ON CONFLICT("+keys.join(",")+") "+(updates.length?"DO UPDATE SET "+updates.map(c=>c+"=excluded."+c).join(",")+" WHERE "+updates.map(c=>c+" IS NOT excluded."+c).join(" OR "):"DO NOTHING");
}
export function validateRows(item,rows){
  if(!Array.isArray(rows)||!rows.length||rows.length>pageSize)throw Error("Invalid rows");
  for(const row of rows){
    if(!Array.isArray(row)||row.length!==item.columns.length||row.some(v=>v!==null&&typeof v!=="string"&&!(typeof v==="number"&&Number.isFinite(v))))throw Error("Invalid row");
    const get=(name)=>row[item.columns.indexOf(name)];
    if(item.keys.some(k=>get(k)===null||get(k)===undefined))throw Error("Null key");
    if(item.table==="products"&&get("source_name")!=="gutenberg")throw Error("Non-Gutenberg product");
    if(item.table==="rights_grants"&&(!String(get("source")).startsWith("gutenberg-")||get("contract_id")!==null||get("contract_version_id")!==null||get("notes")!==""||get("contract_reference")!==""))throw Error("Private grant");
    if(item.table==="rights_parties"&&(get("contact_email")!==""||get("reference_code")!==""))throw Error("Private party");
    if(item.table==="asset_versions"&&get("object_key")!==null&&get("object_key")!=="snapshot-only/"+get("id"))throw Error("Private object reference");
    if(item.table==="gutenberg_source_cache"&&(get("last_error")!==""||get("epub_last_error")!==""||get("source_metadata_json")!=="{}"))throw Error("Private source metadata");
    if(item.table==="catalog_state"&&(get("next_url")!==null||get("last_error")!==""||get("lease_token")!==null||get("lease_until")!==null))throw Error("Private catalog state");
    if(item.table==="search_index_state"&&(get("backend")!=="d1"||get("last_error")!==""||get("sync_lease_token")!==null||get("sync_lease_until")!==null))throw Error("Private search state");
  }
  if(new TextEncoder().encode(JSON.stringify(rows)).length>maxBytes)throw Error("Oversized rows");
}
