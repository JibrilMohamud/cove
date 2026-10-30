import type { CatalogBook } from "./client";
import { ApiError } from "./service";

type Statement = {
  bind(...v: unknown[]): Statement;
  first<T = any>(): Promise<T | null>;
  all<T = any>(): Promise<{ results: T[] }>;
  run(): Promise<unknown>;
};
export type CatalogDB = {
  prepare(sql: string): Statement;
  batch(s: Statement[]): Promise<unknown>;
};
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
const canonicalSelect = `
SELECT p.id product_id,p.public_id product_public_id,p.source_name,p.source_external_id,p.storefront_status,
  e.id edition_id,e.public_id edition_public_id,e.work_id,w.public_id work_public_id,e.publisher_id,e.imprint_id,e.title,e.subtitle,e.description,e.edition_number,e.language,e.original_language,
  e.publication_date,e.release_date,e.preorder_date,e.isbn13,e.publisher_identifier,e.page_estimate,e.word_count,
  e.reading_time_minutes,e.file_size_bytes,e.epub_version,e.layout,e.drm_status,e.downloadable,e.release_status,
  e.subscription_eligible,e.library_eligible,e.publisher_description,e.editorial_reviews,
  w.original_publication_date,w.min_age,w.max_age,w.content_warnings,
  pub.name publisher_name,pub.slug publisher_slug,imp.name imprint_name,imp.slug imprint_slug,
  d.download_count,d.first_ingested_at,
  (SELECT epub_status FROM gutenberg_source_cache gc WHERE p.source_name='gutenberg' AND gc.id=p.source_external_id LIMIT 1) epub_storage_status,
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
  const contributors = parseArray<{
    id?: string;
    slug?: string;
    name: string;
    role?: string;
    position?: number;
  }>(row.contributors_json);
  const authors = contributors
    .filter((x) => !x.role || x.role === "author")
    .map((x) => ({ id: x.id, slug: x.slug, name: x.name }));
  const formats: Record<string, string> = {};
  const readingState =
    !row.epub_object_key && ["failed", "unavailable"].includes(row.epub_storage_status)
      ? "unavailable"
      : row.epub_object_key
        ? "stored"
        : row.epub_source_url &&
            row.source_name === "gutenberg" &&
            !/^(pgca|pgau|pgeu)_/.test(row.source_external_id || "")
          ? "on-demand"
          : "processing";
  if (readingState !== "unavailable" && (row.epub_source_url || row.epub_object_key))
    formats["application/epub+zip"] =
      `/api/fore/books/${encodeURIComponent(row.product_public_id || row.source_external_id)}/epub`;
  if (row.cover_url)
    formats[row.cover_url.endsWith(".png") ? "image/png" : "image/jpeg"] = row.cover_url;
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
      product: parseObject<Record<string, string>>(row.product_external_ids_json) || {},
      edition: parseObject<Record<string, string>>(row.edition_external_ids_json) || {},
      work: parseObject<Record<string, string>>(row.work_external_ids_json) || {},
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
    languages: parseArray<string>(row.languages_json).length
      ? parseArray<string>(row.languages_json)
      : [row.language || "en"],
    formats,
    readingAvailability: { state: readingState },
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
    ageRange:
      row.min_age !== null || row.max_age !== null
        ? { min: row.min_age ?? undefined, max: row.max_age ?? undefined }
        : undefined,
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
  if (/^[1-9][0-9]{0,8}$/.test(id) || /^(?:pgca|pgau|pgeu)_[a-z0-9_]{1,100}$/.test(id))
    return "gutenberg";
  return "fore";
}

export async function getCanonicalBook(
  db: DB,
  ref: string,
  userId?: string,
): Promise<CatalogBook | null> {
  const source = sourceForExternalId(ref);
  const row = await db
    .prepare(
      `${canonicalSelect} WHERE p.public_id=? OR p.id=? OR (p.source_name=? AND p.source_external_id=?) OR p.id=(SELECT entity_id FROM catalog_public_aliases WHERE entity_type='product' AND alias=? LIMIT 1) OR p.id=(SELECT entity_id FROM external_identifiers WHERE entity_type='product' AND value=? ORDER BY CASE scheme WHEN 'gutenberg' THEN 0 WHEN 'isbn13' THEN 1 WHEN 'publisher' THEN 2 ELSE 9 END LIMIT 1) LIMIT 1`,
    )
    .bind(ref, ref, source, ref, ref, ref)
    .first<any>();
  if (!row) return null;
  if (row.source_name === "upload") {
    if (!userId) throw new ApiError(401, "Sign in to read your imported books.");
    const owns = await db
      .prepare("SELECT 1 ok FROM personal_imports WHERE product_id=? AND user_id=?")
      .bind(row.product_id, userId)
      .first<any>();
    if (!owns) throw new ApiError(404, "This book is not in your library.");
  }
  return canonicalRowBook(row);
}

export async function resolveProduct(db: DB, ref: string, userId?: string) {
  const source = sourceForExternalId(ref);
  const row = await db
    .prepare(
      "SELECT id,public_id,edition_id,source_name,source_external_id,storefront_status FROM products WHERE public_id=? OR id=? OR (source_name=? AND source_external_id=?) OR id=(SELECT entity_id FROM catalog_public_aliases WHERE entity_type='product' AND alias=? LIMIT 1) OR id=(SELECT entity_id FROM external_identifiers WHERE entity_type='product' AND value=? ORDER BY CASE scheme WHEN 'gutenberg' THEN 0 WHEN 'isbn13' THEN 1 WHEN 'publisher' THEN 2 ELSE 9 END LIMIT 1) LIMIT 1",
    )
    .bind(ref, ref, source, ref, ref, ref)
    .first<any>();
  if (!row) throw new ApiError(404, "This edition is unavailable.");
  if (row.source_name === "upload") {
    if (!userId) throw new ApiError(401, "Sign in to read your imported books.");
    const owns = await db
      .prepare("SELECT 1 ok FROM personal_imports WHERE product_id=? AND user_id=?")
      .bind(row.id, userId)
      .first<any>();
    if (!owns) throw new ApiError(404, "This edition is unavailable.");
  }
  return row;
}

export async function canonicalBooksByProductIds(db: DB, productIds: string[]) {
  if (!productIds.length) return [] as CatalogBook[];
  if (productIds.length > 100)
    throw new ApiError(400, "Too many catalog products requested at once.");
  const placeholders = productIds.map(() => "?").join(",");
  const rows = await db
    .prepare(`${canonicalSelect} WHERE p.id IN (${placeholders})`)
    .bind(...productIds)
    .all<any>();
  const byId = new Map(
    rows.results.map((row: any) => [String(row.product_id), canonicalRowBook(row)]),
  );
  return productIds.map((id) => byId.get(id)).filter((book): book is CatalogBook => !!book);
}

/**
 * A rights-checked first-page shelf needs covers, prices and bylines—not the
 * complete detail page's accessibility, editions, identifiers and provenance
 * aggregation. The caller MUST select current territory-eligible product IDs.
 * The regular /catalog request hydrates full metadata after first paint.
 * Never use this projection to authorize reading, purchases, or downloads.
 */
const firstPaintBookProjectionSql = `SELECT p.id product_id,p.public_id product_public_id,p.source_name,p.source_external_id,
        e.id edition_id,e.public_id edition_public_id,e.work_id,w.public_id work_public_id,
        e.title,e.subtitle,e.description,e.language,e.original_language,e.isbn13,
        e.release_status,e.drm_status,e.downloadable,e.publisher_id,e.imprint_id,
        e.reading_time_minutes,e.word_count,e.page_estimate,e.release_date,
        pub.name publisher_name,pub.slug publisher_slug,
        imp.name imprint_name,imp.slug imprint_slug,
        d.download_count,
        gc.epub_status epub_storage_status,gc.source_project,gc.source_url source_page_url,
        gc.source_license_url,
        cover_version.source_url cover_url,
        epub_version.source_url epub_source_url,epub_version.object_key epub_object_key,
        (SELECT json_group_array(json_object('id',c.id,'slug',c.slug,'name',c.name,'role',ec.role,'position',ec.position))
         FROM edition_contributors ec JOIN contributors c ON c.id=ec.contributor_id
         WHERE ec.edition_id=e.id ORDER BY ec.position) contributors_json,
        (SELECT json_group_array(s.name) FROM edition_subjects es JOIN subjects s ON s.id=es.subject_id
         WHERE es.edition_id=e.id ORDER BY es.position) subjects_json,
        (SELECT json_group_array(cat.name) FROM edition_categories ec
         JOIN categories cat ON cat.id=ec.category_id
         WHERE ec.edition_id=e.id AND cat.scheme='gutenberg-bookshelf') bookshelves_json,
        (SELECT json_group_array(json_object('id',s.id,'slug',s.slug,'name',s.name,
         'position',sm.position,'label',sm.label,'relationship',sm.relationship,
         'readingOrder',COALESCE(sm.reading_order,sm.position)))
         FROM series_memberships sm JOIN series s ON s.id=sm.series_id WHERE sm.edition_id=e.id) series_json,
        (SELECT json_object('type',o.offer_type,'currency',o.currency,'amountMinor',o.amount_minor)
         FROM offers o WHERE o.product_id=p.id AND o.sales_channel='retail' AND o.active=1
         AND (o.starts_at IS NULL OR o.starts_at<=datetime('now'))
         AND (o.ends_at IS NULL OR o.ends_at>datetime('now'))
         ORDER BY o.created_at DESC LIMIT 1) offer_json
       FROM products p
       JOIN editions e ON e.id=p.edition_id
       JOIN works w ON w.id=e.work_id
       LEFT JOIN publishers pub ON pub.id=e.publisher_id
       LEFT JOIN imprints imp ON imp.id=e.imprint_id
       LEFT JOIN catalog_search_documents d ON d.product_id=p.id
       LEFT JOIN gutenberg_source_cache gc ON gc.id=p.source_external_id AND p.source_name='gutenberg'
       LEFT JOIN digital_assets cover ON cover.edition_id=e.id AND cover.kind='cover'
       LEFT JOIN asset_versions cover_version ON cover_version.id=cover.current_version_id
       LEFT JOIN digital_assets epub ON epub.edition_id=e.id AND epub.kind='epub'
       LEFT JOIN asset_versions epub_version ON epub_version.id=epub.current_version_id`;
const firstPaintLiveCandidateProjectionSql = firstPaintBookProjectionSql.replace(
  "FROM products p",
  ", (SELECT COUNT(*) FROM eligible) AS candidate_total FROM products p",
);

export async function canonicalFirstPaintBooksByProductIds(db: DB, productIds: string[]) {
  if (!productIds.length) return [] as CatalogBook[];
  if (productIds.length > 100)
    throw new ApiError(400, "Too many catalog products requested at once.");
  const rows = await db
    .prepare(
      `${firstPaintBookProjectionSql}
       WHERE p.id IN (${productIds.map(() => "?").join(",")})`,
    )
    .bind(...productIds)
    .all<Record<string, unknown>>();
  const byId = new Map(rows.results.map((row) => [String(row.product_id), canonicalRowBook(row)]));
  return productIds.map((id) => byId.get(id)).filter((book): book is CatalogBook => !!book);
}

/**
 * Prepared presentation IDs have no authorization power. One fresh primary
 * statement rechecks the SAME active/unsuppressed/available, territorial
 * retail view and current market currency used by the canonical first-paint
 * shelf. The private read-model may reorder candidates, never grant access.
 */
export async function canonicalAuthorizedPreparedFirstPaintBooks(
  db: DB,
  productIds: string[],
  territory: string,
  expectedCurrency: string,
  limit = 24,
  diagnostics?: FirstPaintD1QueryMetrics,
): Promise<{ books: CatalogBook[]; hasMore: boolean }> {
  if (
    !/^[A-Z]{2}$/.test(territory) ||
    !/^[A-Z]{3}$/.test(expectedCurrency) ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 24 ||
    productIds.length > 128 ||
    productIds.some((id) => !/^[A-Za-z0-9][A-Za-z0-9_-]{1,159}$/.test(id)) ||
    new Set(productIds).size !== productIds.length
  )
    throw new ApiError(400, "Invalid prepared storefront candidates.");
  // Even an empty projection reaches the authority; it is never a cached grant.
  // CROSS JOIN fixes the outer loop to at most 128 candidate IDs. Materialize
  // only the 25 eligible IDs before hydrating contributors/assets/series.
  const projection = firstPaintBookProjectionSql.replace(
    "FROM products p",
    "FROM selected candidate CROSS JOIN products p ON p.id=candidate.product_id",
  );
  const rows = await db
    .prepare(
      `WITH market(currency) AS MATERIALIZED (
      SELECT COALESCE(
        (SELECT default_currency FROM storefront_markets WHERE country_code=? AND market_status='active'),
        (SELECT default_currency FROM storefront_markets WHERE country_code='US' AND market_status='active'))
    ), candidates AS MATERIALIZED (
      SELECT value product_id, CAST(key AS INTEGER) position FROM json_each(?)
    ), selected AS MATERIALIZED (
      SELECT c.product_id,c.position FROM candidates c
      CROSS JOIN products p ON p.id=c.product_id
      JOIN editions e ON e.id=p.edition_id
      JOIN catalog_search_documents d ON d.product_id=p.id
      WHERE p.storefront_status='active' AND p.source_name<>'upload'
        AND e.release_status IN ('available','preorder')
        AND d.suppressed=0 AND d.availability='available'
        AND d.currency=? AND ?=(SELECT currency FROM market)
        AND EXISTS (SELECT 1 FROM retail_product_availability_rows rpa
          WHERE rpa.product_id=p.id AND rpa.territory_code=?)
      ORDER BY c.position LIMIT ?
    ) ${projection} ORDER BY candidate.position`,
    )
    .bind(
      territory,
      JSON.stringify(productIds),
      expectedCurrency,
      expectedCurrency,
      territory,
      limit + 1,
    )
    .all<Record<string, unknown>>();
  if (diagnostics) recordFirstPaintD1Metrics(rows, diagnostics);
  const distinct = new Map<string, CatalogBook>();
  for (const row of rows.results) {
    const id = String(row.product_id);
    if (!distinct.has(id)) distinct.set(id, canonicalRowBook(row));
  }
  return { books: [...distinct.values()].slice(0, limit), hasMore: distinct.size > limit };
}

/**
 * Authoritative first-paint selection and hydration in a single D1 statement.
 * The caller constructs the predicate exclusively from the existing rights-
 * checked candidateParts query, not from request-supplied SQL. A materialized
 * 25-ID candidate set keeps the stable, index-supported popular sort and
 * prevents the hydration query from adding an extra D1 network round trip.
 * Both selection and books are from one live SQLite read snapshot.
 */
export type FirstPaintD1QueryMetrics = {
  sqlDurationMs?: number;
  rowsRead?: number;
  attempts?: number;
  servedByRegion?: string;
  servedByPrimary?: boolean;
};

export type PrimaryStorefrontAuthorityRow = {
  product_id: string;
  product_public_id: string | null;
  edition_id: string;
  edition_public_id: string | null;
  offer_json: string | null;
};

/** Presentation DTOs are independently materialized. This live authority
 * statement deliberately never hydrates authors, covers, works or series. */
export async function authorizeStorefrontPresentationIds(
  db: DB,
  ids: string[],
  territory: string,
  currency: string,
  diagnostics?: FirstPaintD1QueryMetrics,
) {
  if (
    !/^[A-Z]{2}$/.test(territory) ||
    !/^[A-Z]{3}$/.test(currency) ||
    ids.length > 128 ||
    ids.some((id) => !/^[A-Za-z0-9][A-Za-z0-9_-]{1,159}$/.test(id)) ||
    new Set(ids).size !== ids.length
  )
    throw new ApiError(400, "Invalid storefront presentation candidates.");
  const result = await db
    .prepare(
      `WITH market(currency) AS MATERIALIZED (
      SELECT COALESCE(
        (SELECT default_currency FROM storefront_markets WHERE country_code=? AND market_status='active'),
        (SELECT default_currency FROM storefront_markets WHERE country_code='US' AND market_status='active'))
    ), candidates AS MATERIALIZED (
      SELECT value product_id,CAST(key AS INTEGER) position FROM json_each(?)
    ), authorized AS MATERIALIZED (
      SELECT p.id product_id,p.public_id product_public_id,p.edition_id,
        e.public_id edition_public_id,c.position,d.currency
      FROM candidates c CROSS JOIN products p ON p.id=c.product_id
      JOIN editions e ON e.id=p.edition_id
      JOIN catalog_search_documents d ON d.product_id=p.id
      WHERE p.storefront_status='active' AND p.source_name<>'upload'
        AND e.release_status IN ('available','preorder')
        AND d.suppressed=0 AND d.availability='available'
        AND d.currency=? AND ?=(SELECT currency FROM market)
        AND EXISTS (SELECT 1 FROM retail_product_availability_rows rpa
          WHERE rpa.product_id=p.id AND rpa.territory_code=?)
      ORDER BY c.position LIMIT 25
    ) SELECT a.product_id,a.product_public_id,a.edition_id,a.edition_public_id,
      (SELECT json_object('type',o.offer_type,'currency',o.currency,'amountMinor',o.amount_minor)
        FROM offers o WHERE o.product_id=a.product_id AND o.sales_channel='retail'
          AND o.currency=a.currency AND o.active=1
          AND (o.starts_at IS NULL OR o.starts_at<=datetime('now'))
          AND (o.ends_at IS NULL OR o.ends_at>datetime('now'))
        ORDER BY o.created_at DESC LIMIT 1) offer_json
      FROM authorized a ORDER BY a.position`,
    )
    .bind(territory, JSON.stringify(ids), currency, currency, territory)
    .all<PrimaryStorefrontAuthorityRow>();
  if (diagnostics) recordFirstPaintD1Metrics(result, diagnostics);
  return result.results;
}

function recordFirstPaintD1Metrics(result: unknown, diagnostics: FirstPaintD1QueryMetrics) {
  const meta = (
    result as {
      meta?: {
        duration?: number;
        timings?: { sql_duration_ms?: number };
        rows_read?: number;
        total_attempts?: number;
        served_by_region?: string;
        served_by_primary?: boolean;
      };
    }
  ).meta;
  for (const [key, value] of Object.entries({
    sqlDurationMs: meta?.timings?.sql_duration_ms ?? meta?.duration,
    rowsRead: meta?.rows_read,
    attempts: meta?.total_attempts,
  }))
    if (typeof value === "number" && Number.isFinite(value) && value >= 0)
      Object.assign(diagnostics, { [key]: value });
  if (typeof meta?.served_by_primary === "boolean")
    diagnostics.servedByPrimary = meta.served_by_primary;
  if (/^[A-Za-z0-9-]{1,32}$/.test(meta?.served_by_region || ""))
    diagnostics.servedByRegion = meta!.served_by_region;
}

export async function canonicalFirstPaintShelfByRightsQuery(
  db: DB,
  selection: {
    from: string;
    where: string;
    order: string;
    binds: unknown[];
    limit: number;
    /** Trusted country only; activates an authoritative currency preflight CTE. */
    currencyCountry?: string;
  },
  diagnostics?: FirstPaintD1QueryMetrics,
): Promise<{ books: CatalogBook[]; hasMore: boolean }> {
  if (!Number.isInteger(selection.limit) || selection.limit < 1 || selection.limit > 100)
    throw new ApiError(400, "Invalid storefront shelf limit.");
  // Nested scalar currency resolution plus the complex legally-scoped
  // retail view overflowed SQLite's 100-level expression tree in production.
  // Keep currency resolution and indexed existence checks in separate,
  // materialized, non-correlated CTEs. Both execute in this SAME primary D1
  // statement and cannot cache/grant rights.
  const currencyPrelude = selection.currencyCountry
    ? `WITH first_paint_currency(currency) AS MATERIALIZED (
         SELECT COALESCE(
           (SELECT default_currency FROM storefront_markets
            WHERE country_code=upper(?) AND market_status='active'),
           (SELECT default_currency FROM storefront_markets
            WHERE country_code='US' AND market_status='active')
         )
       ), first_paint_currency_available AS MATERIALIZED (
         SELECT 1 FROM catalog_search_documents currency_probe INDEXED BY idx_search_price
         WHERE currency_probe.currency=(SELECT currency FROM first_paint_currency)
           AND currency_probe.availability='available'
           AND currency_probe.suppressed=0 LIMIT 1
       ), eligible AS MATERIALIZED (`
    : "WITH eligible AS MATERIALIZED (";
  const bindings = selection.currencyCountry
    ? [selection.currencyCountry, ...selection.binds, selection.limit + 1]
    : [...selection.binds, selection.limit + 1];
  const rows = await db
    .prepare(
      `${currencyPrelude}
         SELECT d.product_id,d.fore_bestseller_score AS sort_score,
           d.external_book_id AS sort_source
         FROM ${selection.from}
         WHERE ${selection.where}
         ORDER BY ${selection.order},d.product_id ASC LIMIT ?
       )
       ${firstPaintLiveCandidateProjectionSql}
       JOIN eligible selected ON selected.product_id=p.id
       ORDER BY selected.sort_score DESC,selected.sort_source ASC,selected.product_id ASC`,
    )
    .bind(...bindings)
    .all<Record<string, unknown>>();
  if (diagnostics) recordFirstPaintD1Metrics(rows, diagnostics);
  const distinct = new Map<string, CatalogBook>();
  for (const row of rows.results) {
    const id = String(row.product_id);
    if (!distinct.has(id)) distinct.set(id, canonicalRowBook(row));
  }
  return {
    books: [...distinct.values()].slice(0, selection.limit),
    hasMore: Number(rows.results[0]?.candidate_total || 0) > selection.limit,
  };
}

/** Hydrate an already entitlement-filtered library page without per-book round trips.
 * Personal imports retain their independent ownership check even if a stale
 * or incorrectly assigned entitlement exists. Never use the public bulk reader
 * for private library pages.
 */
export async function canonicalLibraryBooks(db: DB, productIds: string[], userId: string) {
  if (!userId) throw new ApiError(401, "Sign in to view your library.");
  if (productIds.length > 100) throw new ApiError(400, "Too many library products requested.");
  const byId = new Map<string, CatalogBook>();
  for (let offset = 0; offset < productIds.length; offset += 80) {
    const chunk = productIds.slice(offset, offset + 80);
    const rows = await db
      .prepare(
        `${canonicalSelect} WHERE p.id IN (${chunk.map(() => "?").join(",")}) AND (p.source_name<>'upload' OR EXISTS(SELECT 1 FROM personal_imports pi WHERE pi.product_id=p.id AND pi.user_id=?))`,
      )
      .bind(...chunk, userId)
      .all<Record<string, unknown>>();
    for (const row of rows.results) byId.set(String(row.product_id), canonicalRowBook(row));
  }
  return byId;
}
