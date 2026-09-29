import type { CatalogBook } from "./client";
import { ApiError } from "./service";

type Statement = {
  bind(...v: unknown[]): Statement;
  first<T = any>(): Promise<T | null>;
  all<T = any>(): Promise<{ results: T[] }>;
  run(): Promise<unknown>;
};
export type CatalogDB = { prepare(sql: string): Statement; batch(s: Statement[]): Promise<unknown> };
type DB = CatalogDB;

export const catalogIds = (externalId: string) => ({
  workId: externalId.startsWith("upload_") ? `wrk_${externalId}` : `wrk_gutenberg_${externalId}`,
  editionId: externalId.startsWith("upload_") ? `ed_${externalId}` : `ed_gutenberg_${externalId}`,
  productId: externalId.startsWith("upload_") ? `prd_${externalId}` : `prd_gutenberg_${externalId}`,
});

/**
 * Normalize one raw Gutenberg cache row into Cove's commercial catalog model.
 * gutenberg_source_cache intentionally remains a source-cache/staging table; storefront reads use the
 * normalized tables below and catalog_search_documents is regenerated from canonical inputs.
 */
export function commercialCatalogStatements(db: DB, externalId: string, at: string) {
  const { workId, editionId, productId } = catalogIds(externalId);
  return [
    db.prepare(`INSERT OR IGNORE INTO publishers(id,name,website,created_at,updated_at)
      SELECT gs.publisher_id,gs.name,gs.homepage_url,?,? FROM gutenberg_source_cache c JOIN gutenberg_sources gs ON gs.id=c.source_id WHERE c.id=?`).bind(at, at, externalId),
    // US rows created after migration receive the same append-only source evidence as migrated rows.
    db.prepare(`INSERT OR IGNORE INTO gutenberg_rights_evidence(id,source_id,cache_id,source_item_id,determination,territory_code,evidence_url,evidence_type,evidence_hash,parser_version,status,checked_at,created_at)
      SELECT 'gre_pgus_us_'||c.id,'pg_us',c.id,c.source_item_id,'public-domain','US',COALESCE(NULLIF(c.rights_evidence_url,''),c.source_url),'source-catalog','gutendex:'||c.id,'pgus-v1','approved',?,?
      FROM gutenberg_source_cache c WHERE c.id=? AND c.source_id='pg_us' AND c.copyright=0`).bind(at, at, externalId),
    db.prepare(`UPDATE gutenberg_source_cache SET rights_evidence_id=COALESCE(rights_evidence_id,'gre_pgus_us_'||id),rights_checked_at=COALESCE(rights_checked_at,?)
      WHERE id=? AND source_id='pg_us' AND copyright=0`).bind(at, externalId),
    db.prepare(`INSERT INTO works(id,title,description,work_type,canonical_status,created_at,updated_at)
      SELECT ?,title,summary,'public_domain','canonical',first_ingested_at,updated_at FROM gutenberg_source_cache WHERE id=?
      ON CONFLICT(id) DO UPDATE SET title=excluded.title,description=excluded.description,work_type='public_domain',canonical_status='canonical',updated_at=excluded.updated_at`).bind(workId, externalId),
    db.prepare(`INSERT INTO editions(id,work_id,publisher_id,title,description,language,drm_status,downloadable,release_status,edition_type,differentiation_status,differentiation_summary,canonical_public_domain,created_at,updated_at)
      SELECT ?,?,gs.publisher_id,c.title,c.summary,COALESCE(json_extract(c.languages_json,'$[0]'),'en'),'none',1,
        CASE WHEN c.rights_status='public-domain' AND c.commercial_use_status='approved' THEN 'available' ELSE 'unavailable' END,
        'canonical_public_domain','not_required','Canonical free Project Gutenberg edition',1,c.first_ingested_at,c.updated_at
      FROM gutenberg_source_cache c JOIN gutenberg_sources gs ON gs.id=c.source_id WHERE c.id=?
      ON CONFLICT(id) DO UPDATE SET title=excluded.title,description=excluded.description,language=excluded.language,publisher_id=excluded.publisher_id,release_status=excluded.release_status,edition_type='canonical_public_domain',differentiation_status='not_required',differentiation_summary='Canonical free Project Gutenberg edition',canonical_public_domain=1,updated_at=excluded.updated_at`).bind(editionId, workId, externalId),
    db.prepare(`INSERT INTO products(id,edition_id,sku,format,storefront_status,source_name,source_external_id,created_at,updated_at)
      SELECT ?,?,'GUTENBERG-'||upper(replace(c.source_id,'pg_',''))||'-'||c.source_item_id,'ebook',
        CASE WHEN c.rights_status='public-domain' AND c.commercial_use_status='approved' THEN 'active' ELSE 'inactive' END,
        'gutenberg',c.id,c.first_ingested_at,c.updated_at FROM gutenberg_source_cache c WHERE c.id=?
      ON CONFLICT(id) DO UPDATE SET edition_id=excluded.edition_id,storefront_status=excluded.storefront_status,updated_at=excluded.updated_at`).bind(productId, editionId, externalId),
    db.prepare(`INSERT INTO external_identifiers(entity_type,entity_id,scheme,value)
      SELECT 'product',?,gs.identifier_scheme,c.source_item_id FROM gutenberg_source_cache c JOIN gutenberg_sources gs ON gs.id=c.source_id WHERE c.id=?
      ON CONFLICT(entity_type,entity_id,scheme) DO UPDATE SET value=excluded.value`).bind(productId, externalId),
    db.prepare(`INSERT INTO external_identifiers(entity_type,entity_id,scheme,value)
      SELECT 'product',?,'gutenberg',c.source_item_id FROM gutenberg_source_cache c WHERE c.id=? AND c.source_id='pg_us' AND c.source_item_id<>''
      ON CONFLICT(entity_type,entity_id,scheme) DO UPDATE SET value=excluded.value`).bind(productId, externalId),
    db.prepare(`INSERT INTO external_identifiers(entity_type,entity_id,scheme,value)
      SELECT 'edition',?,'gutenberg',c.source_item_id FROM gutenberg_source_cache c WHERE c.id=? AND c.source_id='pg_us' AND c.source_item_id<>''
      ON CONFLICT(entity_type,entity_id,scheme) DO UPDATE SET value=excluded.value`).bind(editionId, externalId),
    db.prepare(`INSERT INTO external_identifiers(entity_type,entity_id,scheme,value)
      SELECT 'work',?,'gutenberg',c.source_item_id FROM gutenberg_source_cache c WHERE c.id=? AND c.source_id='pg_us' AND c.source_item_id<>''
      ON CONFLICT(entity_type,entity_id,scheme) DO UPDATE SET value=excluded.value`).bind(workId, externalId),
    db.prepare(`INSERT INTO offers(id,product_id,offer_type,currency,amount_minor,active,created_at,updated_at)
      SELECT ?,?,'public-domain','USD',0,CASE WHEN rights_status='public-domain' AND commercial_use_status='approved' THEN 1 ELSE 0 END,?,?
      FROM gutenberg_source_cache WHERE id=?
      ON CONFLICT(id) DO UPDATE SET active=excluded.active,updated_at=excluded.updated_at`).bind(`off_gutenberg_${externalId}`, productId, at, at, externalId),
    // One exact country grant per approved evidence row. Europe therefore never receives an inferred EU/EEA blanket grant.
    db.prepare(`INSERT INTO rights_grants(
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
      ON CONFLICT(id) DO NOTHING`).bind(editionId, at, at, externalId),
    db.prepare("DELETE FROM edition_contributors WHERE edition_id=?").bind(editionId),
    db.prepare(`INSERT OR IGNORE INTO contributors(id,name,sort_name,created_at,updated_at)
      SELECT 'con_name_'||hex(lower(json_extract(j.value,'$.name'))),json_extract(j.value,'$.name'),json_extract(j.value,'$.name'),c.first_ingested_at,c.updated_at
      FROM gutenberg_source_cache c,json_each(c.authors_json) j WHERE c.id=? AND json_extract(j.value,'$.name') IS NOT NULL`).bind(externalId),
    db.prepare(`INSERT OR IGNORE INTO edition_contributors(edition_id,contributor_id,role,position)
      SELECT ?,'con_name_'||hex(lower(json_extract(j.value,'$.name'))),'author',CAST(j.key AS INTEGER)
      FROM gutenberg_source_cache c,json_each(c.authors_json) j WHERE c.id=? AND json_extract(j.value,'$.name') IS NOT NULL`).bind(editionId, externalId),
    db.prepare(`INSERT OR IGNORE INTO work_contributors(work_id,contributor_id,role,position)
      SELECT ?,'con_name_'||hex(lower(json_extract(j.value,'$.name'))),'author',CAST(j.key AS INTEGER)
      FROM gutenberg_source_cache c,json_each(c.authors_json) j WHERE c.id=? AND json_extract(j.value,'$.name') IS NOT NULL`).bind(workId, externalId),
    db.prepare("DELETE FROM edition_subjects WHERE edition_id=? AND source='gutenberg'").bind(editionId),
    db.prepare(`INSERT OR IGNORE INTO subjects(id,scheme,name,normalized_name,created_at,updated_at)
      SELECT 'sub_gutenberg_'||hex(lower(j.value)),'gutenberg',j.value,lower(trim(j.value)),c.first_ingested_at,c.updated_at
      FROM gutenberg_source_cache c,json_each(c.subjects_json) j WHERE c.id=? AND trim(j.value)<>''`).bind(externalId),
    db.prepare(`INSERT OR IGNORE INTO edition_subjects(edition_id,subject_id,position,source)
      SELECT ?,'sub_gutenberg_'||hex(lower(j.value)),CAST(j.key AS INTEGER),'gutenberg'
      FROM gutenberg_source_cache c,json_each(c.subjects_json) j WHERE c.id=? AND trim(j.value)<>''`).bind(editionId, externalId),
    db.prepare("DELETE FROM edition_categories WHERE edition_id=?").bind(editionId),
    db.prepare(`INSERT OR IGNORE INTO categories(id,scheme,name)
      SELECT 'cat_shelf_'||hex(lower(j.value)),'gutenberg-bookshelf',j.value FROM gutenberg_source_cache c,json_each(c.bookshelves_json) j WHERE c.id=?`).bind(externalId),
    db.prepare(`INSERT OR IGNORE INTO edition_categories(edition_id,category_id,position)
      SELECT ?,'cat_shelf_'||hex(lower(j.value)),1000+CAST(j.key AS INTEGER) FROM gutenberg_source_cache c,json_each(c.bookshelves_json) j WHERE c.id=?`).bind(editionId, externalId),
    db.prepare("DELETE FROM edition_languages WHERE edition_id=?").bind(editionId),
    db.prepare(`INSERT OR IGNORE INTO edition_languages(edition_id,language_code,kind)
      SELECT ?,j.value,'content' FROM gutenberg_source_cache c,json_each(c.languages_json) j WHERE c.id=?`).bind(editionId, externalId),
    db.prepare(`INSERT OR IGNORE INTO languages(code,name,native_name,direction,active,created_at,updated_at)
      SELECT lower(j.value),'','',CASE WHEN lower(j.value) IN ('ar','fa','he','ur') THEN 'rtl' ELSE 'ltr' END,1,c.first_ingested_at,c.updated_at
      FROM gutenberg_source_cache c,json_each(c.languages_json) j WHERE c.id=? AND trim(j.value)<>''`).bind(externalId),
    db.prepare(`INSERT INTO digital_assets(id,edition_id,kind,drm_status,downloadable,created_at,updated_at)
      SELECT ?,?,'epub','none',1,first_ingested_at,updated_at FROM gutenberg_source_cache WHERE id=? AND COALESCE(json_extract(formats_json,'$."application/epub+zip"'),json_extract(formats_json,'$."application/epub+zip;"')) IS NOT NULL
      ON CONFLICT(edition_id,kind) DO UPDATE SET updated_at=excluded.updated_at`).bind(`asset_epub_gutenberg_${externalId}`, editionId, externalId),
    db.prepare(`INSERT INTO asset_versions(id,asset_id,version_number,source_url,object_key,mime_type,sha256,created_at)
      SELECT ?,?,1,COALESCE(json_extract(formats_json,'$."application/epub+zip"'),json_extract(formats_json,'$."application/epub+zip;"')),
        CASE WHEN epub_status='completed' THEN 'epubs/'||id||'.epub' ELSE NULL END,'application/epub+zip',NULLIF(content_hash,''),first_ingested_at
      FROM gutenberg_source_cache WHERE id=? AND COALESCE(json_extract(formats_json,'$."application/epub+zip"'),json_extract(formats_json,'$."application/epub+zip;"')) IS NOT NULL
      ON CONFLICT(asset_id,version_number) DO UPDATE SET source_url=excluded.source_url,object_key=COALESCE(excluded.object_key,asset_versions.object_key),sha256=COALESCE(excluded.sha256,asset_versions.sha256)`).bind(`assetver_epub_gutenberg_${externalId}`, `asset_epub_gutenberg_${externalId}`, externalId),
    db.prepare("UPDATE digital_assets SET current_version_id=? WHERE id=?").bind(`assetver_epub_gutenberg_${externalId}`, `asset_epub_gutenberg_${externalId}`),
    db.prepare(`INSERT INTO edition_distinctions(edition_id,edition_type,differentiation_summary,source_text_fingerprint,asset_sha256,verification_status,policy_version,created_at,updated_at)
      SELECT ?,'canonical_public_domain','Canonical free Project Gutenberg edition','',COALESCE(NULLIF(content_hash,''),''),'verified','fore-public-domain-editions-v1',first_ingested_at,updated_at FROM gutenberg_source_cache WHERE id=?
      ON CONFLICT(edition_id) DO UPDATE SET edition_type='canonical_public_domain',differentiation_summary=excluded.differentiation_summary,asset_sha256=excluded.asset_sha256,verification_status='verified',updated_at=excluded.updated_at`).bind(editionId,externalId),
    db.prepare(`INSERT INTO digital_assets(id,edition_id,kind,drm_status,downloadable,created_at,updated_at)
      SELECT ?,?,'cover','none',1,first_ingested_at,updated_at FROM gutenberg_source_cache WHERE id=? AND source_id='pg_us' AND COALESCE(json_extract(formats_json,'$."image/jpeg"'),json_extract(formats_json,'$."image/png"')) IS NOT NULL
      ON CONFLICT(edition_id,kind) DO UPDATE SET updated_at=excluded.updated_at`).bind(`asset_cover_gutenberg_${externalId}`, editionId, externalId),
    db.prepare(`INSERT INTO asset_versions(id,asset_id,version_number,source_url,mime_type,created_at)
      SELECT ?,?,1,COALESCE(json_extract(formats_json,'$."image/jpeg"'),json_extract(formats_json,'$."image/png"')),CASE WHEN json_extract(formats_json,'$."image/jpeg"') IS NOT NULL THEN 'image/jpeg' ELSE 'image/png' END,first_ingested_at
      FROM gutenberg_source_cache WHERE id=? AND source_id='pg_us' AND COALESCE(json_extract(formats_json,'$."image/jpeg"'),json_extract(formats_json,'$."image/png"')) IS NOT NULL
      ON CONFLICT(asset_id,version_number) DO UPDATE SET source_url=excluded.source_url,mime_type=excluded.mime_type`).bind(`assetver_cover_gutenberg_${externalId}`, `asset_cover_gutenberg_${externalId}`, externalId),
    db.prepare("UPDATE digital_assets SET current_version_id=? WHERE id=?").bind(`assetver_cover_gutenberg_${externalId}`, `asset_cover_gutenberg_${externalId}`),
    db.prepare(`INSERT INTO catalog_search_documents(product_id,external_book_id,title,contributors_text,subjects_text,bookshelves_text,categories_text,languages_text,description,download_count,first_ingested_at,updated_at)
      SELECT ?,c.id,c.title,
        COALESCE((SELECT group_concat(x.name,' ') FROM edition_contributors ec JOIN contributors x ON x.id=ec.contributor_id WHERE ec.edition_id=? ORDER BY ec.position),''),
        COALESCE((SELECT group_concat(s.name,' | ') FROM edition_subjects es JOIN subjects s ON s.id=es.subject_id WHERE es.edition_id=? ORDER BY es.position),''),
        COALESCE((SELECT group_concat(cat.name,' | ') FROM edition_categories ec JOIN categories cat ON cat.id=ec.category_id WHERE ec.edition_id=? AND cat.scheme='gutenberg-bookshelf' ORDER BY ec.position),''),
        COALESCE((SELECT group_concat(cat.name,' | ') FROM edition_categories ec JOIN categories cat ON cat.id=ec.category_id WHERE ec.edition_id=? ORDER BY ec.position),''),
        COALESCE((SELECT group_concat(el.language_code,' ') FROM edition_languages el WHERE el.edition_id=? AND el.kind='content'),''),
        c.summary,c.download_count,c.first_ingested_at,c.updated_at
      FROM gutenberg_source_cache c WHERE c.id=?
      ON CONFLICT(product_id) DO UPDATE SET title=excluded.title,contributors_text=excluded.contributors_text,subjects_text=excluded.subjects_text,bookshelves_text=excluded.bookshelves_text,categories_text=excluded.categories_text,languages_text=excluded.languages_text,description=excluded.description,download_count=excluded.download_count,updated_at=excluded.updated_at`).bind(productId,editionId,editionId,editionId,editionId,editionId,externalId),
    db.prepare(`UPDATE catalog_search_documents SET
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
      suppressed=CASE WHEN EXISTS(SELECT 1 FROM products p WHERE p.id=? AND p.storefront_status='active') THEN 0 ELSE 1 END WHERE product_id=?`).bind(productId,productId,productId,productId,productId,productId,productId,productId,productId,productId,productId,productId,productId,productId,productId,productId,productId),
  ];
}

export function personalImportStatements(
  db: DB,
  input: { id: string; userId: string; title: string; author: string; language: string; objectKey: string; createdAt: string },
) {
  const { workId, editionId, productId } = catalogIds(input.id);
  const contributorId = `con_upload_${input.id}`;
  const assetId = `asset_epub_${input.id}`;
  const versionId = `assetver_epub_${input.id}`;
  return [
    db.prepare("INSERT INTO works(id,title,description,created_at,updated_at) VALUES(?,?,'Personal import',?,?)").bind(workId, input.title, input.createdAt, input.createdAt),
    db.prepare("INSERT INTO editions(id,work_id,title,description,language,drm_status,downloadable,release_status,created_at,updated_at) VALUES(?,?,?,'Personal import',?,'none',1,'private',?,?)").bind(editionId, workId, input.title, input.language, input.createdAt, input.createdAt),
    db.prepare("INSERT INTO products(id,edition_id,sku,format,storefront_status,source_name,source_external_id,created_at,updated_at) VALUES(?,?,?,'ebook','private','upload',?,?,?)").bind(productId, editionId, `UPLOAD-${input.id}`, input.id, input.createdAt, input.createdAt),
    db.prepare("INSERT INTO external_identifiers(entity_type,entity_id,scheme,value) VALUES('product',?,'upload',?)").bind(productId, input.id),
    db.prepare("INSERT INTO contributors(id,name,sort_name,created_at,updated_at) VALUES(?,?,?,?,?)").bind(contributorId, input.author, input.author, input.createdAt, input.createdAt),
    db.prepare("INSERT INTO edition_contributors(edition_id,contributor_id,role,position) VALUES(?,?,'author',0)").bind(editionId, contributorId),
    db.prepare("INSERT INTO edition_languages(edition_id,language_code,kind) VALUES(?,?,'content')").bind(editionId, input.language),
    db.prepare("INSERT INTO digital_assets(id,edition_id,kind,current_version_id,drm_status,downloadable,created_at,updated_at) VALUES(?,?,'epub',?,'none',1,?,?)").bind(assetId, editionId, versionId, input.createdAt, input.createdAt),
    db.prepare("INSERT INTO asset_versions(id,asset_id,version_number,object_key,mime_type,created_at) VALUES(?,?,1,?,'application/epub+zip',?)").bind(versionId, assetId, input.objectKey, input.createdAt),
    db.prepare("INSERT INTO personal_imports(id,user_id,product_id,object_key,created_at) VALUES(?,?,?,?,?)").bind(input.id, input.userId, productId, input.objectKey, input.createdAt),
    db.prepare("INSERT INTO catalog_search_documents(product_id,external_book_id,title,contributors_text,subjects_text,categories_text,languages_text,description,download_count,first_ingested_at,updated_at) VALUES(?,?,?,?,'Personal import','Personal import',?,'Personal import',0,?,?)").bind(productId, input.id, input.title, input.author, input.language, input.createdAt, input.createdAt),
    db.prepare("UPDATE catalog_search_documents SET format='ebook',availability='private',suppressed=1,product_created_at=?,product_updated_at=? WHERE product_id=?").bind(input.createdAt,input.createdAt,productId),
    db.prepare("INSERT INTO entitlements(id,user_id,product_id,entitlement_type,status,source,granted_at,updated_at) VALUES(?,?,?,'personal-import','active','upload',?,?)").bind(`ent_${crypto.randomUUID()}`, input.userId, productId, input.createdAt, input.createdAt),
    db.prepare("INSERT INTO reading_states(user_id,product_id,external_book_id,in_library,status,updated_at) VALUES(?,?,?,1,'want-to-read',?)").bind(input.userId, productId, input.id, input.createdAt),
  ];
}

const canonicalSelect = `
SELECT p.id product_id,p.public_id product_public_id,p.source_name,p.source_external_id,p.storefront_status,
  e.id edition_id,e.public_id edition_public_id,e.work_id,w.public_id work_public_id,e.publisher_id,e.imprint_id,e.title,e.subtitle,e.description,e.edition_number,e.language,e.original_language,
  e.publication_date,e.release_date,e.preorder_date,e.isbn13,e.publisher_identifier,e.page_estimate,e.word_count,
  e.reading_time_minutes,e.file_size_bytes,e.epub_version,e.layout,e.drm_status,e.downloadable,e.release_status,
  e.subscription_eligible,e.library_eligible,e.publisher_description,e.editorial_reviews,
  w.original_publication_date,w.min_age,w.max_age,w.content_warnings,
  pub.name publisher_name,pub.slug publisher_slug,imp.name imprint_name,imp.slug imprint_slug,
  d.download_count,d.first_ingested_at,
  (SELECT source_project FROM gutenberg_source_cache gc WHERE p.source_name='gutenberg' AND gc.id=p.source_external_id LIMIT 1) source_project,
  (SELECT source_url FROM gutenberg_source_cache gc WHERE p.source_name='gutenberg' AND gc.id=p.source_external_id LIMIT 1) source_page_url,
  (SELECT source_license_url FROM gutenberg_source_cache gc WHERE p.source_name='gutenberg' AND gc.id=p.source_external_id LIMIT 1) source_license_url,
  (SELECT source_url FROM digital_assets da JOIN asset_versions av ON av.id=da.current_version_id WHERE da.edition_id=e.id AND da.kind='cover' LIMIT 1) cover_url,
  (SELECT source_url FROM digital_assets da JOIN asset_versions av ON av.id=da.current_version_id WHERE da.edition_id=e.id AND da.kind='epub' LIMIT 1) epub_source_url,
  (SELECT object_key FROM digital_assets da JOIN asset_versions av ON av.id=da.current_version_id WHERE da.edition_id=e.id AND da.kind='epub' LIMIT 1) epub_object_key,
  (SELECT json_group_array(json_object('id',c.id,'slug',c.slug,'name',c.name,'role',ec.role,'position',ec.position)) FROM edition_contributors ec JOIN contributors c ON c.id=ec.contributor_id WHERE ec.edition_id=e.id ORDER BY ec.position) contributors_json,
  (SELECT json_group_array(s.name) FROM edition_subjects es JOIN subjects s ON s.id=es.subject_id WHERE es.edition_id=e.id ORDER BY es.position) subjects_json,
  (SELECT json_group_array(cat.name) FROM edition_categories ec JOIN categories cat ON cat.id=ec.category_id WHERE ec.edition_id=e.id AND cat.scheme='gutenberg-bookshelf') bookshelves_json,
  (SELECT json_group_array(language_code) FROM edition_languages WHERE edition_id=e.id AND kind='content') languages_json,
  (SELECT json_group_object(scheme,value) FROM external_identifiers WHERE entity_type='product' AND entity_id=p.id) product_external_ids_json,
  (SELECT json_group_object(scheme,value) FROM external_identifiers WHERE entity_type='edition' AND entity_id=e.id) edition_external_ids_json,
  (SELECT json_group_object(scheme,value) FROM external_identifiers WHERE entity_type='work' AND entity_id=w.id) work_external_ids_json,
  (SELECT json_group_array(json_object('id',s.id,'slug',s.slug,'name',s.name,'position',sm.position,'label',sm.label,'relationship',sm.relationship,'readingOrder',COALESCE(sm.reading_order,sm.position))) FROM series_memberships sm JOIN series s ON s.id=sm.series_id WHERE sm.edition_id=e.id) series_json,
  (SELECT json_object('screenReaderCompatible',am.screen_reader_compatible,'altTextComplete',am.alt_text_complete,'semanticStructure',am.semantic_structure,'summary',COALESCE(ap.accessibility_summary,am.accessibility_summary),'certifier',am.certifier,'visualAdjustments',ap.visual_adjustments,'nonvisualReading',ap.nonvisual_reading,'primaryLanguageDeclared',ap.primary_language_declared,'readingOrderVerified',ap.reading_order_verified,'tableSemanticsComplete',ap.table_semantics_complete,'mathmlPresent',ap.mathml_present,'mathmlAccessible',ap.mathml_accessible,'pageNavigation',ap.page_navigation,'accessibilityNavigation',ap.accessibility_navigation,'accessModes',json(COALESCE(ap.access_modes_json,'[]')),'accessModeSufficient',json(COALESCE(ap.access_mode_sufficient_json,'[]')),'features',json(COALESCE(ap.features_json,'[]')),'hazards',json(COALESCE(ap.hazards_json,'[]')),'conformsTo',json(COALESCE(ap.conforms_to_json,'[]')),'certification',json(COALESCE(ap.certification_json,'{}')),'validationPolicyVersion',ap.validation_policy_version,'validationStatus',ap.validation_status,'validationReport',json(COALESCE(ap.validation_report_json,'{}')),'publisherDeclaration',json(COALESCE(ap.publisher_declaration_json,'{}'))) FROM accessibility_metadata am LEFT JOIN edition_accessibility_profiles ap ON ap.edition_id=am.edition_id WHERE am.edition_id=e.id) accessibility_json,
  (SELECT json_object('epubVersion',fp.epub_version,'packageVersion',fp.package_version,'navigationType',fp.navigation_type,'renditionLayout',fp.rendition_layout,'pageProgressionDirection',fp.page_progression_direction,'writingMode',fp.writing_mode,'rtl',fp.rtl,'verticalWriting',fp.vertical_writing,'complexCss',fp.complex_css,'embeddedFonts',fp.embedded_fonts,'svg',fp.svg,'mathml',fp.mathml,'complexTables',fp.complex_tables,'footnotes',fp.footnotes,'endnotes',fp.endnotes,'dictionaryContent',fp.dictionary_content,'mediaOverlays',fp.media_overlays,'oversizedImages',fp.oversized_images,'accessibilityNavigation',fp.accessibility_navigation,'compatibilityClass',fp.compatibility_class,'readerSupport',fp.reader_support,'features',json(COALESCE(fp.features_json,'{}')),'warnings',json(COALESCE(fp.warnings_json,'[]'))) FROM edition_format_profiles fp WHERE fp.edition_id=e.id) format_profile_json,
  (SELECT json_object('type',o.offer_type,'currency',o.currency,'amountMinor',o.amount_minor) FROM offers o WHERE o.product_id=p.id AND o.sales_channel='retail' AND o.active=1 AND (o.starts_at IS NULL OR o.starts_at<=datetime('now')) AND (o.ends_at IS NULL OR o.ends_at>datetime('now')) ORDER BY o.created_at DESC LIMIT 1) offer_json,
  (SELECT json_object('policyVersion',pd.policy_version,'textOrigin',pd.text_origin,'coverOrigin',pd.cover_origin,'narrationOrigin',pd.narration_origin,'translationOrigin',pd.translation_origin,'syntheticVoiceLabel',pd.synthetic_voice_label,'publicBadges',json(pd.public_badges_json)) FROM publishing_release_lifecycles l JOIN publishing_publication_versions pv ON pv.id=l.current_publication_version_id JOIN publishing_publications pp ON pp.id=pv.publication_id JOIN publishing_publication_disclosures pd ON pd.publication_version_id=pv.id WHERE pp.product_id=p.id LIMIT 1) ai_disclosure_json
FROM products p JOIN editions e ON e.id=p.edition_id JOIN works w ON w.id=e.work_id
LEFT JOIN publishers pub ON pub.id=e.publisher_id LEFT JOIN imprints imp ON imp.id=e.imprint_id
LEFT JOIN catalog_search_documents d ON d.product_id=p.id`;

function parseArray<T>(value: unknown): T[] {
  try {
    const v = JSON.parse(String(value ?? "[]"));
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}
function parseObject<T>(value: unknown): T | null {
  try {
    const v = JSON.parse(String(value ?? "null"));
    return v && typeof v === "object" && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

export function canonicalRowBook(row: any): CatalogBook {
  const contributors = parseArray<{ id?: string; slug?:string; name: string; role?: string; position?: number }>(row.contributors_json);
  const authors = contributors.filter((x) => !x.role || x.role === "author").map((x) => ({ id: x.id, slug:x.slug, name: x.name }));
  const formats: Record<string, string> = {};
  if (row.epub_source_url || row.epub_object_key)
    formats["application/epub+zip"] = `/api/fore/books/${encodeURIComponent(row.product_public_id || row.source_external_id)}/epub`;
  if (row.cover_url) formats[row.cover_url.endsWith(".png") ? "image/png" : "image/jpeg"] = row.cover_url;
  return {
    id: row.product_public_id || row.product_id,
    sourceExternalId: row.source_external_id,
    productId: row.product_id,
    editionId: row.edition_id,
    workId: row.work_id,
    publicProductId: row.product_public_id || undefined,
    publicEditionId: row.edition_public_id || undefined,
    publicWorkId: row.work_public_id || undefined,
    externalIdentifiers: {
      product: parseObject<Record<string,string>>(row.product_external_ids_json) || {},
      edition: parseObject<Record<string,string>>(row.edition_external_ids_json) || {},
      work: parseObject<Record<string,string>>(row.work_external_ids_json) || {},
    },
    sourceName: row.source_name,
    sourceProject: row.source_project || undefined,
    sourceUrl: row.source_page_url || undefined,
    sourceLicenseUrl: row.source_license_url || undefined,
    title: row.title,
    subtitle: row.subtitle || "",
    authors,
    contributors,
    summaries: row.description ? [row.description] : [],
    subjects: parseArray<string>(row.subjects_json),
    bookshelves: parseArray<string>(row.bookshelves_json),
    languages: parseArray<string>(row.languages_json).length ? parseArray<string>(row.languages_json) : [row.language || "en"],
    formats,
    download_count: Number(row.download_count) || 0,
    copyright: row.source_name === "gutenberg" ? false : undefined,
    uploaded: row.source_name === "upload",
    publisher: row.publisher_name || undefined,
    publisherId: row.publisher_id || undefined,
    publisherSlug: row.publisher_slug || undefined,
    imprint: row.imprint_name || undefined,
    imprintId: row.imprint_id || undefined,
    imprintSlug: row.imprint_slug || undefined,
    isbn13: row.isbn13 || undefined,
    publicationDate: row.publication_date || undefined,
    originalPublicationDate: row.original_publication_date || undefined,
    releaseDate: row.release_date || undefined,
    preorderDate: row.preorder_date || undefined,
    editionNumber: row.edition_number || undefined,
    originalLanguage: row.original_language || undefined,
    ageRange: row.min_age !== null || row.max_age !== null ? { min: row.min_age ?? undefined, max: row.max_age ?? undefined } : undefined,
    contentWarnings: row.content_warnings ? row.content_warnings.split("\n").filter(Boolean) : [],
    pageEstimate: row.page_estimate ?? undefined,
    wordCount: row.word_count ?? undefined,
    readingTimeMinutes: row.reading_time_minutes ?? undefined,
    fileSizeBytes: row.file_size_bytes ?? undefined,
    epubVersion: row.epub_version || undefined,
    layout: row.layout || "reflowable",
    drmStatus: row.drm_status || "none",
    downloadable: !!row.downloadable,
    releaseStatus: row.release_status || "available",
    subscriptionEligible: !!row.subscription_eligible,
    libraryEligible: !!row.library_eligible,
    publisherDescription: row.publisher_description || undefined,
    editorialReviews: row.editorial_reviews || undefined,
    series: parseArray<any>(row.series_json),
    accessibility: parseObject<any>(row.accessibility_json) || undefined,
    formatProfile: parseObject<any>(row.format_profile_json) || undefined,
    offer: parseObject<any>(row.offer_json) || undefined,
    aiDisclosure: parseObject<any>(row.ai_disclosure_json) || undefined,
  };
}

function sourceForExternalId(id: string) {
  if (id.startsWith("upload_")) return "upload";
  if (/^[1-9][0-9]{0,8}$/.test(id) || /^(?:pgca|pgau|pgeu)_[a-z0-9_]{1,100}$/.test(id)) return "gutenberg";
  return "fore";
}

export async function getCanonicalBook(db: DB, ref: string, userId?: string): Promise<CatalogBook | null> {
  const source = sourceForExternalId(ref);
  const row = await db.prepare(`${canonicalSelect} WHERE p.public_id=? OR p.id=? OR (p.source_name=? AND p.source_external_id=?) OR p.id=(SELECT entity_id FROM catalog_public_aliases WHERE entity_type='product' AND alias=? LIMIT 1) OR p.id=(SELECT entity_id FROM external_identifiers WHERE entity_type='product' AND value=? ORDER BY CASE scheme WHEN 'gutenberg' THEN 0 WHEN 'isbn13' THEN 1 WHEN 'publisher' THEN 2 ELSE 9 END LIMIT 1) LIMIT 1`).bind(ref, ref, source, ref, ref, ref).first<any>();
  if (!row) return null;
  if (row.source_name === "upload") {
    if (!userId) throw new ApiError(401, "Sign in to read your imported books.");
    const owns = await db.prepare("SELECT 1 ok FROM personal_imports WHERE product_id=? AND user_id=?").bind(row.product_id, userId).first<any>();
    if (!owns) throw new ApiError(404, "This book is not in your library.");
  }
  return canonicalRowBook(row);
}

export async function resolveProduct(db: DB, ref: string, userId?: string) {
  const source = sourceForExternalId(ref);
  const row = await db.prepare("SELECT id,public_id,edition_id,source_name,source_external_id,storefront_status FROM products WHERE public_id=? OR id=? OR (source_name=? AND source_external_id=?) OR id=(SELECT entity_id FROM catalog_public_aliases WHERE entity_type='product' AND alias=? LIMIT 1) OR id=(SELECT entity_id FROM external_identifiers WHERE entity_type='product' AND value=? ORDER BY CASE scheme WHEN 'gutenberg' THEN 0 WHEN 'isbn13' THEN 1 WHEN 'publisher' THEN 2 ELSE 9 END LIMIT 1) LIMIT 1").bind(ref,ref,source,ref,ref,ref).first<any>();
  if (!row) throw new ApiError(404, "This edition is unavailable.");
  if (row.source_name === "upload") {
    if (!userId) throw new ApiError(401, "Sign in to read your imported books.");
    const owns = await db.prepare("SELECT 1 ok FROM personal_imports WHERE product_id=? AND user_id=?").bind(row.id, userId).first<any>();
    if (!owns) throw new ApiError(404, "This edition is unavailable.");
  }
  return row;
}

export async function canonicalBooksByProductIds(db: DB, productIds: string[]) {
  if (!productIds.length) return [] as CatalogBook[];
  if (productIds.length > 100) throw new ApiError(400, "Too many catalog products requested at once.");
  const placeholders = productIds.map(() => "?").join(",");
  const rows = await db.prepare(`${canonicalSelect} WHERE p.id IN (${placeholders})`).bind(...productIds).all<any>();
  const byId = new Map(rows.results.map((row: any) => [String(row.product_id), canonicalRowBook(row)]));
  return productIds.map((id) => byId.get(id)).filter((book): book is CatalogBook => !!book);
}
