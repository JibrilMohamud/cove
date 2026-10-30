/* eslint-disable prettier/prettier -- Historical SQL copied only for isolated Node test fixtures; no production imports. */
// Test/local-fixture ONLY. Not imported by production API or deployed Workers.
// Historical catalog source SQL is retained strictly to prepare isolated local
// SQLite fixtures after shared canonical write-builder retirement.
// This file is under scripts/test-* and intentionally outside production audit.
import {readFileSync} from "node:fs";
const catalogIds = (externalId) => ({
 workId:externalId.startsWith("upload_")?`wrk_${externalId}`:`wrk_gutenberg_${externalId}`,
 editionId:externalId.startsWith("upload_")?`ed_${externalId}`:`ed_gutenberg_${externalId}`,
 productId:externalId.startsWith("upload_")?`prd_${externalId}`:`prd_gutenberg_${externalId}`
});
const epubSource=(formats)=>Object.entries(formats).find(([type])=>type.toLowerCase().includes("epub"))?.[1]||"";
const canonicalAssetSource=()=>null;
function catalogInsert(db,book,sourceUrl,at,options={}) {
  const formats = book.formats || {};
  const sourceId = options.sourceId || "pg_us";
  const source =
    sourceId === "pg_us" ? epubSource(formats) : canonicalAssetSource(formats)?.url || "";
  const sourceItemId = options.sourceItemId || String(book.id);
  const sourceProject = options.sourceProject || "Project Gutenberg";
  const sourceLicenseUrl =
    options.sourceLicenseUrl || "https://www.gutenberg.org/policy/license.html";
  const rightsStatus =
    options.rightsStatus || (book.copyright === false ? "public-domain" : "pending");
  const rightsTerritories =
    options.rightsTerritories || (sourceId === "pg_us" && book.copyright === false ? ["US"] : []);
  const commercialUseStatus =
    options.commercialUseStatus ||
    (sourceId === "pg_us" && book.copyright === false ? "approved" : "pending");
  return db
    .prepare(
      `INSERT INTO gutenberg_source_cache(
        id,title,authors_json,summary,subjects_json,bookshelves_json,languages_json,formats_json,download_count,copyright,
        source_url,source_updated_at,first_ingested_at,updated_at,last_seen_at,ingest_status,ingest_attempts,last_error,
        epub_status,epub_attempts,epub_next_attempt_at,epub_cached_at,epub_last_error,
        source_id,source_item_id,source_project,source_license_url,rights_status,rights_territories_json,rights_evidence_url,
        rights_checked_at,rights_evidence_id,commercial_use_status,trademark_cleanup_required,canonicalization_version,source_metadata_json,content_hash
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET
        title=excluded.title,authors_json=excluded.authors_json,summary=excluded.summary,subjects_json=excluded.subjects_json,
        bookshelves_json=excluded.bookshelves_json,languages_json=excluded.languages_json,formats_json=excluded.formats_json,
        download_count=excluded.download_count,copyright=excluded.copyright,source_url=excluded.source_url,
        source_updated_at=excluded.source_updated_at,updated_at=excluded.updated_at,last_seen_at=excluded.last_seen_at,
        ingest_status='active',ingest_attempts=0,last_error='',source_id=excluded.source_id,source_item_id=excluded.source_item_id,
        source_project=excluded.source_project,source_license_url=excluded.source_license_url,
        rights_territories_json=excluded.rights_territories_json,rights_evidence_url=excluded.rights_evidence_url,
        source_metadata_json=excluded.source_metadata_json,content_hash=CASE WHEN gutenberg_source_cache.formats_json=excluded.formats_json AND gutenberg_source_cache.rights_territories_json=excluded.rights_territories_json AND gutenberg_source_cache.rights_evidence_url=excluded.rights_evidence_url AND COALESCE(json_extract(gutenberg_source_cache.source_metadata_json,'$.rightsFingerprint'),'')=COALESCE(json_extract(excluded.source_metadata_json,'$.rightsFingerprint'),'') THEN CASE WHEN excluded.content_hash<>'' THEN excluded.content_hash ELSE gutenberg_source_cache.content_hash END ELSE excluded.content_hash END,
        trademark_cleanup_required=excluded.trademark_cleanup_required,
        rights_status=CASE WHEN gutenberg_source_cache.commercial_use_status='approved' AND gutenberg_source_cache.rights_status='public-domain'
          AND gutenberg_source_cache.rights_territories_json=excluded.rights_territories_json AND gutenberg_source_cache.rights_evidence_url=excluded.rights_evidence_url AND COALESCE(json_extract(gutenberg_source_cache.source_metadata_json,'$.rightsFingerprint'),'')=COALESCE(json_extract(excluded.source_metadata_json,'$.rightsFingerprint'),'')
          THEN gutenberg_source_cache.rights_status ELSE excluded.rights_status END,
        commercial_use_status=CASE WHEN gutenberg_source_cache.commercial_use_status='approved' AND gutenberg_source_cache.rights_status='public-domain'
          AND gutenberg_source_cache.rights_territories_json=excluded.rights_territories_json AND gutenberg_source_cache.rights_evidence_url=excluded.rights_evidence_url AND COALESCE(json_extract(gutenberg_source_cache.source_metadata_json,'$.rightsFingerprint'),'')=COALESCE(json_extract(excluded.source_metadata_json,'$.rightsFingerprint'),'')
          THEN 'approved' ELSE excluded.commercial_use_status END,
        rights_evidence_id=CASE WHEN gutenberg_source_cache.rights_territories_json=excluded.rights_territories_json
          AND gutenberg_source_cache.rights_evidence_url=excluded.rights_evidence_url AND COALESCE(json_extract(gutenberg_source_cache.source_metadata_json,'$.rightsFingerprint'),'')=COALESCE(json_extract(excluded.source_metadata_json,'$.rightsFingerprint'),'') THEN COALESCE(gutenberg_source_cache.rights_evidence_id,excluded.rights_evidence_id) ELSE excluded.rights_evidence_id END,
        rights_checked_at=CASE WHEN gutenberg_source_cache.rights_territories_json=excluded.rights_territories_json
          AND gutenberg_source_cache.rights_evidence_url=excluded.rights_evidence_url AND COALESCE(json_extract(gutenberg_source_cache.source_metadata_json,'$.rightsFingerprint'),'')=COALESCE(json_extract(excluded.source_metadata_json,'$.rightsFingerprint'),'') THEN COALESCE(gutenberg_source_cache.rights_checked_at,excluded.rights_checked_at) ELSE excluded.rights_checked_at END,
        canonicalization_version=CASE WHEN gutenberg_source_cache.formats_json=excluded.formats_json AND COALESCE(json_extract(gutenberg_source_cache.source_metadata_json,'$.rightsFingerprint'),'')=COALESCE(json_extract(excluded.source_metadata_json,'$.rightsFingerprint'),'') THEN gutenberg_source_cache.canonicalization_version ELSE excluded.canonicalization_version END,
        epub_status=CASE WHEN gutenberg_source_cache.epub_status='downloading' AND gutenberg_source_cache.formats_json=excluded.formats_json THEN 'downloading' WHEN gutenberg_source_cache.epub_status='completed' AND gutenberg_source_cache.formats_json=excluded.formats_json
          AND gutenberg_source_cache.rights_territories_json=excluded.rights_territories_json AND gutenberg_source_cache.rights_evidence_url=excluded.rights_evidence_url AND COALESCE(json_extract(gutenberg_source_cache.source_metadata_json,'$.rightsFingerprint'),'')=COALESCE(json_extract(excluded.source_metadata_json,'$.rightsFingerprint'),'')
          THEN 'completed' WHEN excluded.epub_status='unavailable' THEN 'unavailable' ELSE 'pending' END,
        epub_next_attempt_at=CASE WHEN gutenberg_source_cache.epub_status='completed' AND gutenberg_source_cache.formats_json=excluded.formats_json
          AND gutenberg_source_cache.rights_territories_json=excluded.rights_territories_json AND gutenberg_source_cache.rights_evidence_url=excluded.rights_evidence_url AND COALESCE(json_extract(gutenberg_source_cache.source_metadata_json,'$.rightsFingerprint'),'')=COALESCE(json_extract(excluded.source_metadata_json,'$.rightsFingerprint'),'')
          THEN gutenberg_source_cache.epub_next_attempt_at ELSE '' END,
        epub_last_error=CASE WHEN gutenberg_source_cache.epub_status='completed' AND gutenberg_source_cache.formats_json=excluded.formats_json
          AND gutenberg_source_cache.rights_territories_json=excluded.rights_territories_json AND gutenberg_source_cache.rights_evidence_url=excluded.rights_evidence_url AND COALESCE(json_extract(gutenberg_source_cache.source_metadata_json,'$.rightsFingerprint'),'')=COALESCE(json_extract(excluded.source_metadata_json,'$.rightsFingerprint'),'')
          THEN gutenberg_source_cache.epub_last_error ELSE '' END`,
    )
    .bind(
      String(book.id),
      book.title,
      JSON.stringify(book.authors || []),
      book.summaries?.[0] || "",
      JSON.stringify(book.subjects || []),
      JSON.stringify(book.bookshelves || []),
      JSON.stringify(book.languages || []),
      JSON.stringify(formats),
      Number(book.download_count) || 0,
      book.copyright === undefined || book.copyright === null ? null : book.copyright ? 1 : 0,
      sourceUrl,
      at,
      at,
      at,
      at,
      "active",
      0,
      "",
      source ? "pending" : "unavailable",
      0,
      "",
      null,
      "",
      sourceId,
      sourceItemId,
      sourceProject,
      sourceLicenseUrl,
      rightsStatus,
      JSON.stringify(rightsTerritories),
      options.rightsEvidenceUrl || sourceUrl,
      options.rightsEvidenceId ? at : null,
      options.rightsEvidenceId || null,
      commercialUseStatus,
      options.trademarkCleanupRequired ? 1 : 0,
      options.canonicalizationVersion || "",
      JSON.stringify(options.sourceMetadata || {}),
      options.contentHash || "",
    );
}


function commercialCatalogStatements(db,externalId,at) {
  const { workId, editionId, productId } = catalogIds(externalId);
  return [
    db
      .prepare(
        `INSERT OR IGNORE INTO publishers(id,name,website,created_at,updated_at)
      SELECT gs.publisher_id,gs.name,gs.homepage_url,?,? FROM gutenberg_source_cache c JOIN gutenberg_sources gs ON gs.id=c.source_id WHERE c.id=?`,
      )
      .bind(at, at, externalId),
    // US rows created after migration receive the same append-only source evidence as migrated rows.
    db
      .prepare(
        `INSERT OR IGNORE INTO gutenberg_rights_evidence(id,source_id,cache_id,source_item_id,determination,territory_code,evidence_url,evidence_type,evidence_hash,parser_version,status,checked_at,created_at)
      SELECT 'gre_pgus_us_'||c.id,'pg_us',c.id,c.source_item_id,'public-domain','US',COALESCE(NULLIF(c.rights_evidence_url,''),c.source_url),'source-catalog','gutendex:'||c.id,'pgus-v1','approved',?,?
      FROM gutenberg_source_cache c WHERE c.id=? AND c.source_id='pg_us' AND c.copyright=0`,
      )
      .bind(at, at, externalId),
    db
      .prepare(
        `UPDATE gutenberg_source_cache SET rights_evidence_id=COALESCE(rights_evidence_id,'gre_pgus_us_'||id),rights_checked_at=COALESCE(rights_checked_at,?)
      WHERE id=? AND source_id='pg_us' AND copyright=0`,
      )
      .bind(at, externalId),
    db
      .prepare(
        `INSERT INTO works(id,title,description,work_type,canonical_status,created_at,updated_at)
      SELECT ?,title,summary,'public_domain','canonical',first_ingested_at,updated_at FROM gutenberg_source_cache WHERE id=?
      ON CONFLICT(id) DO UPDATE SET title=excluded.title,description=excluded.description,work_type='public_domain',canonical_status='canonical',updated_at=excluded.updated_at`,
      )
      .bind(workId, externalId),
    db
      .prepare(
        `INSERT INTO editions(id,work_id,publisher_id,title,description,language,drm_status,downloadable,release_status,edition_type,differentiation_status,differentiation_summary,canonical_public_domain,created_at,updated_at)
      SELECT ?,?,gs.publisher_id,c.title,c.summary,COALESCE(json_extract(c.languages_json,'$[0]'),'en'),'none',1,
        CASE WHEN c.rights_status='public-domain' AND c.commercial_use_status='approved' THEN 'available' ELSE 'unavailable' END,
        'canonical_public_domain','not_required','Canonical free Project Gutenberg edition',1,c.first_ingested_at,c.updated_at
      FROM gutenberg_source_cache c JOIN gutenberg_sources gs ON gs.id=c.source_id WHERE c.id=?
      ON CONFLICT(id) DO UPDATE SET title=excluded.title,description=excluded.description,language=excluded.language,publisher_id=excluded.publisher_id,release_status=excluded.release_status,edition_type='canonical_public_domain',differentiation_status='not_required',differentiation_summary='Canonical free Project Gutenberg edition',canonical_public_domain=1,updated_at=excluded.updated_at`,
      )
      .bind(editionId, workId, externalId),
    db
      .prepare(
        `INSERT INTO products(id,edition_id,sku,format,storefront_status,source_name,source_external_id,created_at,updated_at)
      SELECT ?,?,'GUTENBERG-'||upper(replace(c.source_id,'pg_',''))||'-'||c.source_item_id,'ebook',
        CASE WHEN c.rights_status='public-domain' AND c.commercial_use_status='approved' THEN 'active' ELSE 'inactive' END,
        'gutenberg',c.id,c.first_ingested_at,c.updated_at FROM gutenberg_source_cache c WHERE c.id=?
      ON CONFLICT(id) DO UPDATE SET edition_id=excluded.edition_id,storefront_status=excluded.storefront_status,updated_at=excluded.updated_at`,
      )
      .bind(productId, editionId, externalId),
    db
      .prepare(
        `INSERT INTO external_identifiers(entity_type,entity_id,scheme,value)
      SELECT 'product',?,gs.identifier_scheme,c.source_item_id FROM gutenberg_source_cache c JOIN gutenberg_sources gs ON gs.id=c.source_id WHERE c.id=?
      ON CONFLICT(entity_type,entity_id,scheme) DO UPDATE SET value=excluded.value`,
      )
      .bind(productId, externalId),
    db
      .prepare(
        `INSERT INTO external_identifiers(entity_type,entity_id,scheme,value)
      SELECT 'product',?,'gutenberg',c.source_item_id FROM gutenberg_source_cache c WHERE c.id=? AND c.source_id='pg_us' AND c.source_item_id<>''
      ON CONFLICT(entity_type,entity_id,scheme) DO UPDATE SET value=excluded.value`,
      )
      .bind(productId, externalId),
    db
      .prepare(
        `INSERT INTO external_identifiers(entity_type,entity_id,scheme,value)
      SELECT 'edition',?,'gutenberg',c.source_item_id FROM gutenberg_source_cache c WHERE c.id=? AND c.source_id='pg_us' AND c.source_item_id<>''
      ON CONFLICT(entity_type,entity_id,scheme) DO UPDATE SET value=excluded.value`,
      )
      .bind(editionId, externalId),
    db
      .prepare(
        `INSERT INTO external_identifiers(entity_type,entity_id,scheme,value)
      SELECT 'work',?,'gutenberg',c.source_item_id FROM gutenberg_source_cache c WHERE c.id=? AND c.source_id='pg_us' AND c.source_item_id<>''
      ON CONFLICT(entity_type,entity_id,scheme) DO UPDATE SET value=excluded.value`,
      )
      .bind(workId, externalId),
    db
      .prepare(
        `INSERT INTO offers(id,product_id,offer_type,currency,amount_minor,active,created_at,updated_at)
      SELECT ?,?,'public-domain','USD',0,CASE WHEN rights_status='public-domain' AND commercial_use_status='approved' THEN 1 ELSE 0 END,?,?
      FROM gutenberg_source_cache WHERE id=?
      ON CONFLICT(id) DO UPDATE SET active=excluded.active,updated_at=excluded.updated_at`,
      )
      .bind(`off_gutenberg_${externalId}`, productId, at, at, externalId),
    // One exact country grant per approved evidence row. Europe therefore never receives an inferred EU/EEA blanket grant.
    db
      .prepare(
        `INSERT INTO rights_grants(
        id,edition_id,rightsholder_id,rightsholder_party_id,territory_code,format,sales_channel,license_type,drm_requirement,
        subscription_permitted,library_permitted,decision,status,promotion_restrictions_json,contract_reference,source,notes,created_at,updated_at,
        exclusivity,scope_summary,source_evidence_id
      )
      SELECT 'right_gutenberg_'||lower(ge.territory_code)||'_'||c.id,?,NULL,NULL,upper(ge.territory_code),'ebook','retail','public-domain','none',
        0,0,'allow','active','{}',ge.evidence_url,'gutenberg-'||c.source_id||'-public-domain',
        'Jurisdiction-scoped public-domain determination from '||c.source_project,?,?,'nonexclusive',upper(ge.territory_code)||' only',ge.id
      FROM gutenberg_source_cache c JOIN gutenberg_rights_evidence ge ON ge.cache_id=c.id AND ge.status='approved' AND ge.determination='public-domain'
      WHERE c.id=? AND c.rights_status='public-domain' AND c.commercial_use_status='approved'
        AND EXISTS(SELECT 1 FROM json_each(c.rights_territories_json) jt WHERE upper(jt.value)=upper(ge.territory_code))
      ON CONFLICT(id) DO NOTHING`,
      )
      .bind(editionId, at, at, externalId),
    db.prepare("DELETE FROM edition_contributors WHERE edition_id=?").bind(editionId),
    db
      .prepare(
        `INSERT OR IGNORE INTO contributors(id,name,sort_name,created_at,updated_at)
      SELECT 'con_name_'||hex(lower(json_extract(j.value,'$.name'))),json_extract(j.value,'$.name'),json_extract(j.value,'$.name'),c.first_ingested_at,c.updated_at
      FROM gutenberg_source_cache c,json_each(c.authors_json) j WHERE c.id=? AND json_extract(j.value,'$.name') IS NOT NULL`,
      )
      .bind(externalId),
    db
      .prepare(
        `INSERT OR IGNORE INTO edition_contributors(edition_id,contributor_id,role,position)
      SELECT ?,'con_name_'||hex(lower(json_extract(j.value,'$.name'))),'author',CAST(j.key AS INTEGER)
      FROM gutenberg_source_cache c,json_each(c.authors_json) j WHERE c.id=? AND json_extract(j.value,'$.name') IS NOT NULL`,
      )
      .bind(editionId, externalId),
    db
      .prepare(
        `INSERT OR IGNORE INTO work_contributors(work_id,contributor_id,role,position)
      SELECT ?,'con_name_'||hex(lower(json_extract(j.value,'$.name'))),'author',CAST(j.key AS INTEGER)
      FROM gutenberg_source_cache c,json_each(c.authors_json) j WHERE c.id=? AND json_extract(j.value,'$.name') IS NOT NULL`,
      )
      .bind(workId, externalId),
    db
      .prepare("DELETE FROM edition_subjects WHERE edition_id=? AND source='gutenberg'")
      .bind(editionId),
    db
      .prepare(
        `INSERT OR IGNORE INTO subjects(id,scheme,name,normalized_name,created_at,updated_at)
      SELECT 'sub_gutenberg_'||hex(lower(j.value)),'gutenberg',j.value,lower(trim(j.value)),c.first_ingested_at,c.updated_at
      FROM gutenberg_source_cache c,json_each(c.subjects_json) j WHERE c.id=? AND trim(j.value)<>''`,
      )
      .bind(externalId),
    db
      .prepare(
        `INSERT OR IGNORE INTO edition_subjects(edition_id,subject_id,position,source)
      SELECT ?,'sub_gutenberg_'||hex(lower(j.value)),CAST(j.key AS INTEGER),'gutenberg'
      FROM gutenberg_source_cache c,json_each(c.subjects_json) j WHERE c.id=? AND trim(j.value)<>''`,
      )
      .bind(editionId, externalId),
    db.prepare("DELETE FROM edition_categories WHERE edition_id=?").bind(editionId),
    db
      .prepare(
        `INSERT OR IGNORE INTO categories(id,scheme,name)
      SELECT 'cat_shelf_'||hex(lower(j.value)),'gutenberg-bookshelf',j.value FROM gutenberg_source_cache c,json_each(c.bookshelves_json) j WHERE c.id=?`,
      )
      .bind(externalId),
    db
      .prepare(
        `INSERT OR IGNORE INTO edition_categories(edition_id,category_id,position)
      SELECT ?,'cat_shelf_'||hex(lower(j.value)),1000+CAST(j.key AS INTEGER) FROM gutenberg_source_cache c,json_each(c.bookshelves_json) j WHERE c.id=?`,
      )
      .bind(editionId, externalId),
    db.prepare("DELETE FROM edition_languages WHERE edition_id=?").bind(editionId),
    db
      .prepare(
        `INSERT OR IGNORE INTO edition_languages(edition_id,language_code,kind)
      SELECT ?,j.value,'content' FROM gutenberg_source_cache c,json_each(c.languages_json) j WHERE c.id=?`,
      )
      .bind(editionId, externalId),
    db
      .prepare(
        `INSERT OR IGNORE INTO languages(code,name,native_name,direction,active,created_at,updated_at)
      SELECT lower(j.value),'','',CASE WHEN lower(j.value) IN ('ar','fa','he','ur') THEN 'rtl' ELSE 'ltr' END,1,c.first_ingested_at,c.updated_at
      FROM gutenberg_source_cache c,json_each(c.languages_json) j WHERE c.id=? AND trim(j.value)<>''`,
      )
      .bind(externalId),
    db
      .prepare(
        `INSERT INTO digital_assets(id,edition_id,kind,drm_status,downloadable,created_at,updated_at)
      SELECT ?,?,'epub','none',1,first_ingested_at,updated_at FROM gutenberg_source_cache WHERE id=? AND (
        COALESCE(json_extract(formats_json,'$."application/epub+zip"'),json_extract(formats_json,'$."application/epub+zip;"')) IS NOT NULL
        OR (source_id IN ('pg_au','pg_ca','pg_eu') AND epub_status='completed'
          AND rights_status='public-domain' AND commercial_use_status='approved'
          AND NULLIF(content_hash,'') IS NOT NULL))
      ON CONFLICT(edition_id,kind) DO UPDATE SET updated_at=excluded.updated_at`,
      )
      .bind(`asset_epub_gutenberg_${externalId}`, editionId, externalId),
    db
      .prepare(
        `INSERT INTO asset_versions(id,asset_id,version_number,source_url,object_key,mime_type,sha256,created_at)
      SELECT ?,?,1,COALESCE(json_extract(formats_json,'$."application/epub+zip"'),json_extract(formats_json,'$."application/epub+zip;"'),json_extract(formats_json,'$."text/html"')),
        CASE WHEN epub_status='completed' THEN 'epubs/'||id||'.epub' ELSE NULL END,'application/epub+zip',NULLIF(content_hash,''),first_ingested_at
      FROM gutenberg_source_cache WHERE id=? AND (
        COALESCE(json_extract(formats_json,'$."application/epub+zip"'),json_extract(formats_json,'$."application/epub+zip;"')) IS NOT NULL
        OR (source_id IN ('pg_au','pg_ca','pg_eu') AND epub_status='completed'
          AND rights_status='public-domain' AND commercial_use_status='approved'
          AND NULLIF(content_hash,'') IS NOT NULL))
      ON CONFLICT(asset_id,version_number) DO UPDATE SET source_url=excluded.source_url,object_key=COALESCE(excluded.object_key,asset_versions.object_key),sha256=COALESCE(excluded.sha256,asset_versions.sha256)`,
      )
      .bind(
        `assetver_epub_gutenberg_${externalId}`,
        `asset_epub_gutenberg_${externalId}`,
        externalId,
      ),
    db
      .prepare("UPDATE digital_assets SET current_version_id=? WHERE id=?")
      .bind(`assetver_epub_gutenberg_${externalId}`, `asset_epub_gutenberg_${externalId}`),
    db
      .prepare(
        `INSERT INTO edition_distinctions(edition_id,edition_type,differentiation_summary,source_text_fingerprint,asset_sha256,verification_status,policy_version,created_at,updated_at)
      SELECT ?,'canonical_public_domain','Canonical free Project Gutenberg edition','',COALESCE(NULLIF(content_hash,''),''),'verified','fore-public-domain-editions-v1',first_ingested_at,updated_at FROM gutenberg_source_cache WHERE id=?
      ON CONFLICT(edition_id) DO UPDATE SET edition_type='canonical_public_domain',differentiation_summary=excluded.differentiation_summary,asset_sha256=excluded.asset_sha256,verification_status='verified',updated_at=excluded.updated_at`,
      )
      .bind(editionId, externalId),
    db
      .prepare(
        `INSERT INTO digital_assets(id,edition_id,kind,drm_status,downloadable,created_at,updated_at)
      SELECT ?,?,'cover','none',1,first_ingested_at,updated_at FROM gutenberg_source_cache WHERE id=? AND source_id='pg_us' AND COALESCE(json_extract(formats_json,'$."image/jpeg"'),json_extract(formats_json,'$."image/png"')) IS NOT NULL
      ON CONFLICT(edition_id,kind) DO UPDATE SET updated_at=excluded.updated_at`,
      )
      .bind(`asset_cover_gutenberg_${externalId}`, editionId, externalId),
    db
      .prepare(
        `INSERT INTO asset_versions(id,asset_id,version_number,source_url,mime_type,created_at)
      SELECT ?,?,1,COALESCE(json_extract(formats_json,'$."image/jpeg"'),json_extract(formats_json,'$."image/png"')),CASE WHEN json_extract(formats_json,'$."image/jpeg"') IS NOT NULL THEN 'image/jpeg' ELSE 'image/png' END,first_ingested_at
      FROM gutenberg_source_cache WHERE id=? AND source_id='pg_us' AND COALESCE(json_extract(formats_json,'$."image/jpeg"'),json_extract(formats_json,'$."image/png"')) IS NOT NULL
      ON CONFLICT(asset_id,version_number) DO UPDATE SET source_url=excluded.source_url,mime_type=excluded.mime_type`,
      )
      .bind(
        `assetver_cover_gutenberg_${externalId}`,
        `asset_cover_gutenberg_${externalId}`,
        externalId,
      ),
    db
      .prepare("UPDATE digital_assets SET current_version_id=? WHERE id=?")
      .bind(`assetver_cover_gutenberg_${externalId}`, `asset_cover_gutenberg_${externalId}`),
    db
      .prepare(
        `INSERT INTO catalog_search_documents(product_id,external_book_id,title,contributors_text,subjects_text,bookshelves_text,categories_text,languages_text,description,download_count,first_ingested_at,updated_at)
      SELECT ?,c.id,c.title,
        COALESCE((SELECT group_concat(x.name,' ') FROM edition_contributors ec JOIN contributors x ON x.id=ec.contributor_id WHERE ec.edition_id=? ORDER BY ec.position),''),
        COALESCE((SELECT group_concat(s.name,' | ') FROM edition_subjects es JOIN subjects s ON s.id=es.subject_id WHERE es.edition_id=? ORDER BY es.position),''),
        COALESCE((SELECT group_concat(cat.name,' | ') FROM edition_categories ec JOIN categories cat ON cat.id=ec.category_id WHERE ec.edition_id=? AND cat.scheme='gutenberg-bookshelf' ORDER BY ec.position),''),
        COALESCE((SELECT group_concat(cat.name,' | ') FROM edition_categories ec JOIN categories cat ON cat.id=ec.category_id WHERE ec.edition_id=? ORDER BY ec.position),''),
        COALESCE((SELECT group_concat(el.language_code,' ') FROM edition_languages el WHERE el.edition_id=? AND el.kind='content'),''),
        c.summary,c.download_count,c.first_ingested_at,c.updated_at
      FROM gutenberg_source_cache c WHERE c.id=?
      ON CONFLICT(product_id) DO UPDATE SET title=excluded.title,contributors_text=excluded.contributors_text,subjects_text=excluded.subjects_text,bookshelves_text=excluded.bookshelves_text,categories_text=excluded.categories_text,languages_text=excluded.languages_text,description=excluded.description,download_count=excluded.download_count,updated_at=excluded.updated_at`,
      )
      .bind(productId, editionId, editionId, editionId, editionId, editionId, externalId),
    db
      .prepare(
        `UPDATE catalog_search_documents SET
      publisher_text=COALESCE((SELECT pub.name FROM products p JOIN editions e ON e.id=p.edition_id LEFT JOIN publishers pub ON pub.id=e.publisher_id WHERE p.id=?),''),
      imprint_text=COALESCE((SELECT imp.name FROM products p JOIN editions e ON e.id=p.edition_id LEFT JOIN imprints imp ON imp.id=e.imprint_id WHERE p.id=?),''),
      series_text=COALESCE((SELECT group_concat(s.name,' | ') FROM products p JOIN editions e ON e.id=p.edition_id JOIN series_memberships sm ON sm.edition_id=e.id JOIN series s ON s.id=sm.series_id WHERE p.id=?),''),
      isbn13=COALESCE((SELECT e.isbn13 FROM products p JOIN editions e ON e.id=p.edition_id WHERE p.id=?),''),
      format=COALESCE((SELECT p.format FROM products p WHERE p.id=?),'ebook'),
      currency=COALESCE((SELECT o.currency FROM offers o WHERE o.product_id=? AND o.active=1 ORDER BY o.created_at DESC LIMIT 1),'USD'),
      price_minor=COALESCE((SELECT o.amount_minor FROM offers o WHERE o.product_id=? AND o.active=1 ORDER BY o.created_at DESC LIMIT 1),0),
      subscription_eligible=COALESCE((SELECT e.subscription_eligible FROM products p JOIN editions e ON e.id=p.edition_id WHERE p.id=?),0),
      library_eligible=COALESCE((SELECT e.library_eligible FROM products p JOIN editions e ON e.id=p.edition_id WHERE p.id=?),0),
      release_date=(SELECT e.release_date FROM products p JOIN editions e ON e.id=p.edition_id WHERE p.id=?),
      publication_date=(SELECT e.publication_date FROM products p JOIN editions e ON e.id=p.edition_id WHERE p.id=?),
      preorder_date=(SELECT e.preorder_date FROM products p JOIN editions e ON e.id=p.edition_id WHERE p.id=?),
      product_created_at=(SELECT p.created_at FROM products p WHERE p.id=?),product_updated_at=(SELECT p.updated_at FROM products p WHERE p.id=?),
      availability=CASE WHEN EXISTS(SELECT 1 FROM products p JOIN editions e ON e.id=p.edition_id WHERE p.id=? AND p.storefront_status='active' AND e.release_status IN ('available','preorder')) THEN 'available' ELSE 'unavailable' END,
      suppressed=CASE WHEN EXISTS(SELECT 1 FROM products p WHERE p.id=? AND p.storefront_status='active') THEN 0 ELSE 1 END WHERE product_id=?`,
      )
      .bind(
        productId,
        productId,
        productId,
        productId,
        productId,
        productId,
        productId,
        productId,
        productId,
        productId,
        productId,
        productId,
        productId,
        productId,
        productId,
        productId,
        productId,
      ),
  ];
}


// Byte-identical original taxonomy maintenance, executed only on disposable
// local SQLite samples rather than the deployed source/owner write plane.
const now=()=>new Date().toISOString();
function syncEditionTaxonomy(db,editionId,sourceUnchanged=false,popularityOnly=false) {
  const at = now();
  // Reconcile rather than destroy/recreate every mapping on every source
  // heartbeat. Existing manual links and exact-match mapping provenance remain
  // untouched. Retries repair missing/stale assignments; changed confidence
  // re-enters the existing INSERT path.
  db
    .prepare(
      `WITH source_values(source_scheme,source_value) AS (
        SELECT c.scheme,c.name FROM edition_categories ec
          JOIN categories c ON c.id=ec.category_id WHERE ec.edition_id=?
        UNION ALL
        SELECT CASE WHEN s.scheme='gutenberg' THEN 'gutenberg-subject' ELSE s.scheme END,s.name
          FROM edition_subjects es JOIN subjects s ON s.id=es.subject_id
          WHERE es.edition_id=?
      ), expected AS (
        SELECT DISTINCT m.taxonomy_node_id,
          CASE WHEN m.match_mode='exact' THEN 1.0 ELSE 0.85 END AS confidence
        FROM source_values src JOIN storefront_taxonomy_mappings m ON m.active=1
          AND (m.source_scheme='*' OR m.source_scheme=src.source_scheme)
          AND ((m.match_mode='exact' AND lower(src.source_value)=lower(m.source_value))
            OR (m.match_mode='prefix' AND lower(src.source_value) LIKE lower(m.source_value)||'%')
            OR (m.match_mode='contains' AND lower(src.source_value) LIKE '%'||lower(m.source_value)||'%'))
      )
      DELETE FROM edition_taxonomy_nodes
      WHERE edition_id=? AND source='mapping'
        AND NOT EXISTS (SELECT 1 FROM expected e
          WHERE e.taxonomy_node_id=edition_taxonomy_nodes.taxonomy_node_id
            AND e.confidence=edition_taxonomy_nodes.confidence)`,
    )
    .bind(editionId, editionId, editionId)
    .run();
  db
    .prepare(
      `INSERT OR IGNORE INTO edition_taxonomy_nodes(edition_id,taxonomy_node_id,source,confidence,is_primary,created_at)
    SELECT DISTINCT src.edition_id,m.taxonomy_node_id,'mapping',CASE WHEN m.match_mode='exact' THEN 1.0 ELSE 0.85 END,0,?
    FROM (
      SELECT ec.edition_id,c.scheme source_scheme,c.name source_value
      FROM edition_categories ec JOIN categories c ON c.id=ec.category_id WHERE ec.edition_id=?
      UNION ALL
      SELECT es.edition_id,CASE WHEN s.scheme='gutenberg' THEN 'gutenberg-subject' ELSE s.scheme END,s.name
      FROM edition_subjects es JOIN subjects s ON s.id=es.subject_id WHERE es.edition_id=?
    ) src
    JOIN storefront_taxonomy_mappings m ON m.active=1
      AND (m.source_scheme='*' OR m.source_scheme=src.source_scheme)
      AND ((m.match_mode='exact' AND lower(src.source_value)=lower(m.source_value))
        OR (m.match_mode='prefix' AND lower(src.source_value) LIKE lower(m.source_value)||'%')
        OR (m.match_mode='contains' AND lower(src.source_value) LIKE '%'||lower(m.source_value)||'%'))`,
    )
    .bind(at, editionId, editionId)
    .run();
  // Before rebuilding the ancestor closure, remove only ancestors which
  // are no longer reachable (or whose confidence changed). Unchanged rows
  // no longer incur a primary-D1 delete + insert on every ingestion sweep.
  db
    .prepare(
      `WITH RECURSIVE ancestors(node_id,parent_id,confidence) AS (
        SELECT n.id,n.parent_id,et.confidence
        FROM edition_taxonomy_nodes et JOIN storefront_taxonomy_nodes n ON n.id=et.taxonomy_node_id
        WHERE et.edition_id=? AND et.source IN ('mapping','manual')
        UNION ALL
        SELECT n.id,n.parent_id,a.confidence FROM ancestors a
        JOIN storefront_taxonomy_nodes n ON n.id=a.parent_id WHERE a.parent_id IS NOT NULL
      )
      DELETE FROM edition_taxonomy_nodes
      WHERE edition_id=? AND source='ancestor'
        AND NOT EXISTS (SELECT 1 FROM ancestors a
          WHERE a.node_id=edition_taxonomy_nodes.taxonomy_node_id
            AND a.confidence=edition_taxonomy_nodes.confidence)`,
    )
    .bind(editionId, editionId)
    .run();
  db
    .prepare(
      `WITH RECURSIVE ancestors(edition_id,node_id,parent_id,confidence) AS (
      SELECT et.edition_id,n.id,n.parent_id,et.confidence
      FROM edition_taxonomy_nodes et JOIN storefront_taxonomy_nodes n ON n.id=et.taxonomy_node_id
      WHERE et.edition_id=? AND et.source IN ('mapping','manual')
      UNION ALL
      SELECT a.edition_id,n.id,n.parent_id,a.confidence
      FROM ancestors a JOIN storefront_taxonomy_nodes n ON n.id=a.parent_id
      WHERE a.parent_id IS NOT NULL
    )
    INSERT OR IGNORE INTO edition_taxonomy_nodes(edition_id,taxonomy_node_id,source,confidence,is_primary,created_at)
    SELECT edition_id,node_id,'ancestor',confidence,0,? FROM ancestors`,
    )
    .bind(editionId, at)
    .run();
  // Avoid firing FTS5 UPDATE triggers when assignments are unchanged.
  // The preceding mapping/ancestor reconciliation still runs every time,
  // including after a partial previous attempt or a changed mapping rule.
  const taxonomyTextWrite = db
    .prepare(
      `UPDATE catalog_search_documents SET taxonomy_text=COALESCE((
    SELECT group_concat(n.path,' | ') FROM products p
    JOIN edition_taxonomy_nodes et ON et.edition_id=p.edition_id
    JOIN storefront_taxonomy_nodes n ON n.id=et.taxonomy_node_id
    WHERE p.id=catalog_search_documents.product_id
  ),''), updated_at=updated_at
  WHERE product_id IN (SELECT id FROM products WHERE edition_id=?)
    AND taxonomy_text IS NOT COALESCE((
      SELECT group_concat(n.path,' | ') FROM products p
      JOIN edition_taxonomy_nodes et ON et.edition_id=p.edition_id
      JOIN storefront_taxonomy_nodes n ON n.id=et.taxonomy_node_id
      WHERE p.id=catalog_search_documents.product_id
    ),'')`,
    )
    .bind(editionId)
    .run();
  // Exact source equality and a zero-row taxonomy update allow preserving an
  // already queued search event. Insert-if-missing still repairs interrupted
  // publication. Missing D1 changes telemetry keeps the conservative old path.
  const changedRows = taxonomyTextWrite?.meta?.changes;
  // A popularity-only refresh is NOT evidence that a separate legal
  // withdrawal was reversed. Keep any queued delete tombstone, even though
  // a new download-count ranking needs an upsert for otherwise active books.
  const preservePendingEvent = sourceUnchanged && changedRows === 0;
  db
    .prepare(
      `INSERT INTO search_index_outbox(product_id,operation,queued_at,attempts,last_error)
    SELECT id,'upsert',?,0,'' FROM products WHERE edition_id=? AND source_name<>'upload'
    ON CONFLICT(product_id) DO UPDATE SET operation='upsert',queued_at=excluded.queued_at,attempts=0,last_error=''
    WHERE ?=0 AND (?=0 OR search_index_outbox.operation<>'delete')`,
    )
    .bind(at, editionId, preservePendingEvent ? 1 : 0, popularityOnly ? 1 : 0)
    .run();
}


export function seedLocalCatalogFixture(raw) {
  if(raw.prepare("SELECT 1 FROM gutenberg_source_cache LIMIT 1").get())return;
  const seed=JSON.parse(readFileSync(new URL("../src/features/fore/catalog-seed.json",import.meta.url),"utf8"));
  const at=new Date().toISOString();
  const facade={prepare(sql){return {bind(...args){return {run(){return raw.prepare(sql).run(...args)}}}}}};
  raw.exec("BEGIN");
  try{
    for(const book of seed.results){
      catalogInsert(facade,book,"https://www.gutenberg.org/ebooks/"+book.id+"/",at).run();
      for(const statement of commercialCatalogStatements(facade,String(book.id),at))
        statement.run();
      syncEditionTaxonomy(facade,catalogIds(String(book.id)).editionId);
    }
    raw.exec("COMMIT");
  }catch(e){raw.exec("ROLLBACK");throw e;}
}

/** Explicit isolated QA catalog pages only; no deployed Worker imports this file.
 * Preserves breadth, release filters and taxonomy for legacy browse tests. */
export function seedAdditionalLocalCatalogBooks(raw, books) {
  if (!Array.isArray(books) || books.length < 1 || books.length > 100)
    throw new Error("isolated_catalog_seed_out_of_bounds");
  const at = new Date().toISOString();
  const facade = {
    prepare(sql) {
      return {
        bind(...args) {
          return { run() { return raw.prepare(sql).run(...args); } };
        },
      };
    },
  };
  raw.exec("BEGIN");
  try {
    for (const book of books) {
      if (!Number.isSafeInteger(book.id) || book.id < 1 || book.copyright !== false)
        throw new Error("invalid_synthetic_catalog_source");
      catalogInsert(facade, book, "https://www.gutenberg.org/ebooks/" + book.id + "/", at).run();
      for (const statement of commercialCatalogStatements(facade, String(book.id), at))
        statement.run();
      syncEditionTaxonomy(facade, catalogIds(String(book.id)).editionId);
    }
    raw.exec("COMMIT");
  } catch (error) {
    raw.exec("ROLLBACK");
    throw error;
  }
}
