import { sql } from "drizzle-orm";
import {
  uniqueIndex,
  check,
  sqliteTable,
  text,
  real,
  integer,
  primaryKey,
  index,
} from "drizzle-orm/sqlite-core";
export const profiles = sqliteTable("profiles", {
  userId: text("user_id").primaryKey(),
  name: text("name").notNull(),
  createdAt: text("created_at").notNull(),
});
export const annotations = sqliteTable(
  "annotations",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    bookId: text("book_id").notNull(),
    bookTitle: text("book_title").notNull(),
    author: text("author").notNull(),
    quote: text("quote").notNull(),
    cfi: text("cfi").notNull(),
    chapter: text("chapter").notNull(),
    color: text("color").notNull(),
    note: text("note").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [index("idx_annotations_user_book").on(t.userId, t.bookId)],
);
export const definitions = sqliteTable(
  "definitions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    word: text("word").notNull(),
    phonetic: text("phonetic").notNull(),
    meaning: text("meaning").notNull(),
    partOfSpeech: text("part_of_speech").notNull(),
    bookId: text("book_id").notNull(),
    bookTitle: text("book_title").notNull(),
    cfi: text("cfi").notNull(),
    context: text("context").notNull(),
    source: text("source").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [index("idx_definitions_user_word").on(t.userId, t.word)],
);
export const apiCache = sqliteTable("api_cache", {
  key: text("key").primaryKey(),
  body: text("body").notNull(),
  expiresAt: integer("expires_at").notNull(),
});
export const gutenbergSourceCache = sqliteTable(
  "gutenberg_source_cache",
  {
    id: text("id").primaryKey(),
    publicId: text("public_id"),
    title: text("title").notNull(),
    authorsJson: text("authors_json").notNull().default("[]"),
    summary: text("summary").notNull().default(""),
    subjectsJson: text("subjects_json").notNull().default("[]"),
    bookshelvesJson: text("bookshelves_json").notNull().default("[]"),
    languagesJson: text("languages_json").notNull().default("[]"),
    formatsJson: text("formats_json").notNull().default("{}"),
    downloadCount: integer("download_count").notNull().default(0),
    copyright: integer("copyright"),
    sourceUrl: text("source_url").notNull(),
    sourceUpdatedAt: text("source_updated_at").notNull(),
    firstIngestedAt: text("first_ingested_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    lastSeenAt: text("last_seen_at").notNull(),
    ingestStatus: text("ingest_status").notNull().default("active"),
    ingestAttempts: integer("ingest_attempts").notNull().default(0),
    lastError: text("last_error").notNull().default(""),
    epubStatus: text("epub_status").notNull().default("pending"),
    epubAttempts: integer("epub_attempts").notNull().default(0),
    epubNextAttemptAt: text("epub_next_attempt_at").notNull().default(""),
    epubCachedAt: text("epub_cached_at"),
    epubLastError: text("epub_last_error").notNull().default(""),
    sourceId: text("source_id").notNull().default("pg_us"),
    sourceItemId: text("source_item_id").notNull().default(""),
    sourceProject: text("source_project").notNull().default("Project Gutenberg"),
    sourceLicenseUrl: text("source_license_url").notNull().default("https://www.gutenberg.org/policy/license.html"),
    rightsStatus: text("rights_status").notNull().default("public-domain"),
    rightsTerritoriesJson: text("rights_territories_json").notNull().default('["US"]'),
    rightsEvidenceUrl: text("rights_evidence_url").notNull().default(""),
    rightsCheckedAt: text("rights_checked_at"),
    rightsEvidenceId: text("rights_evidence_id"),
    commercialUseStatus: text("commercial_use_status").notNull().default("approved"),
    trademarkCleanupRequired: integer("trademark_cleanup_required").notNull().default(0),
    canonicalizationVersion: text("canonicalization_version").notNull().default(""),
    sourceMetadataJson: text("source_metadata_json").notNull().default("{}"),
    contentHash: text("content_hash").notNull().default(""),
  },
  (t) => [
    index("idx_gutenberg_source_cache_popular").on(t.downloadCount),
    index("idx_gutenberg_source_cache_epub_queue").on(t.epubStatus, t.epubNextAttemptAt),
    index("idx_gutenberg_source_cache_updated").on(t.updatedAt),
    uniqueIndex("idx_gutenberg_source_item").on(t.sourceId, t.sourceItemId),
    index("idx_gutenberg_source_cache_source_status").on(t.sourceId, t.ingestStatus, t.rightsStatus, t.commercialUseStatus),
  ],
);
export const catalogState = sqliteTable("catalog_state", {
  id: integer("id").primaryKey(),
  nextUrl: text("next_url"),
  page: integer("page").notNull().default(1),
  status: text("status").notNull().default("idle"),
  lastRunAt: text("last_run_at"),
  lastSuccessAt: text("last_success_at"),
  lastError: text("last_error").notNull().default(""),
  attempts: integer("attempts").notNull().default(0),
  totalCatalogCount: integer("total_catalog_count").notNull().default(0),
  cycleStartedAt: text("cycle_started_at"),
  nextRunAt: text("next_run_at"),
});

// Community and personal reading data. Ratings are integer half-star units.
export const reviews = sqliteTable(
  "reviews",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    bookId: text("book_id").notNull(),
    ratingSteps: integer("rating_steps"),
    body: text("body").notNull().default(""),
    visibility: text("visibility").notNull().default("private"),
    spoiler: integer("spoiler").notNull().default(0),
    wordCount: integer("word_count").notNull().default(0),
    moderation: text("moderation").notNull().default("visible"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    uniqueIndex("idx_reviews_user_book").on(t.userId, t.bookId),
    index("idx_reviews_book_visibility").on(t.bookId, t.visibility, t.moderation, t.createdAt),
    check(
      "review_rating_steps",
      sql`${t.ratingSteps} IS NULL OR ${t.ratingSteps} BETWEEN 1 AND 10`,
    ),
    check("review_visibility", sql`${t.visibility} IN ('public','private')`),
  ],
);
export const reviewHearts = sqliteTable(
  "review_hearts",
  {
    reviewId: text("review_id")
      .notNull()
      .references(() => reviews.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.reviewId, t.userId] }),
    index("idx_hearts_recent").on(t.reviewId, t.createdAt),
  ],
);
export const reviewReports = sqliteTable(
  "review_reports",
  {
    reviewId: text("review_id")
      .notNull()
      .references(() => reviews.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull(),
    reason: text("reason").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.reviewId, t.userId] })],
);
export const shelves = sqliteTable(
  "shelves",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    visibility: text("visibility").notNull().default("private"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    uniqueIndex("idx_shelves_owner_name").on(t.userId, t.name),
    check("shelf_visibility", sql`${t.visibility} IN ('public','private')`),
  ],
);
export const readingSessions = sqliteTable(
  "reading_sessions",
  {
    id: text("id").notNull(),
    userId: text("user_id").notNull(),
    bookId: text("book_id").notNull(),
    mode: text("mode").notNull(),
    startedAt: text("started_at").notNull(),
    endedAt: text("ended_at").notNull(),
    activeSeconds: integer("active_seconds").notNull(),
    wordsRead: integer("words_read").notNull().default(0),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.id] }),
    index("idx_sessions_user_date").on(t.userId, t.startedAt),
  ],
);
export const bookMetrics = sqliteTable(
  "book_metrics",
  {
    userId: text("user_id").notNull(),
    bookId: text("book_id").notNull(),
    wordCount: integer("word_count").notNull(),
    readingLevel: real("reading_level"),
    language: text("language").notNull(),
    method: text("method").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.bookId] })],
);
export const readingGoals = sqliteTable(
  "reading_goals",
  {
    userId: text("user_id").notNull(),
    year: integer("year").notNull(),
    books: integer("books").notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.year] })],
);
export const rateLimits = sqliteTable("rate_limits", {
  key: text("key").primaryKey(),
  windowStart: integer("window_start").notNull(),
  count: integer("count").notNull(),
});
export const audioEditions = sqliteTable(
  "audio_editions",
  {
    id: text("id").primaryKey(),
    gutenbergId: text("gutenberg_id").notNull(),
    bookId: text("book_id"),
    title: text("title").notNull(),
    authorsJson: text("authors_json").notNull(),
    language: text("language").notNull(),
    narration: text("narration").notNull(),
    narrator: text("narrator").notNull().default(""),
    sourceUrl: text("source_url").notNull(),
    rights: text("rights").notNull(),
    tracksJson: text("tracks_json").notNull(),
    alignmentJson: text("alignment_json"),
    epubSha256: text("epub_sha256"),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    index("idx_audio_book").on(t.bookId),
    index("idx_audio_narration").on(t.narration, t.title),
  ],
);
export const playback = sqliteTable(
  "playback",
  {
    userId: text("user_id").notNull(),
    editionId: text("edition_id")
      .notNull()
      .references(() => audioEditions.id, { onDelete: "cascade" }),
    trackId: text("track_id").notNull(),
    seconds: real("seconds").notNull(),
    speed: real("speed").notNull().default(1),
    version: integer("version").notNull().default(1),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.editionId] })],
);

export const authAccounts=sqliteTable("auth_accounts",{providerId:text("provider_id").primaryKey(),appId:text("app_id").notNull().unique(),email:text("email").notNull(),username:text("username").unique(),createdAt:text("created_at").notNull()});

export const audioJobs=sqliteTable("audio_jobs",{id:text("id").primaryKey(),kind:text("kind").notNull(),payloadJson:text("payload_json").notNull(),status:text("status").notNull().default("queued"),attempts:integer("attempts").notNull().default(0),nextAttemptAt:text("next_attempt_at").notNull(),leaseToken:text("lease_token"),leaseUntil:text("lease_until"),lastError:text("last_error").notNull().default(""),updatedAt:text("updated_at").notNull()},t=>[index("idx_audio_jobs_queue").on(t.status,t.nextAttemptAt)]);
export const audioTiming=sqliteTable("audio_timing",{editionId:text("edition_id").notNull().references(()=>audioEditions.id,{onDelete:"cascade"}),trackId:text("track_id").notNull(),audioSha256:text("audio_sha256").notNull(),epubSha256:text("epub_sha256").notNull(),mapSha256:text("map_sha256").notNull(),summaryJson:text("summary_json").notNull(),updatedAt:text("updated_at").notNull()},t=>[primaryKey({columns:[t.editionId,t.trackId]})]);
export const biosyncPositions=sqliteTable("biosync_positions",{userId:text("user_id").notNull(),bookId:text("book_id").notNull(),editionId:text("edition_id").notNull(),mode:text("mode").notNull(),cfi:text("cfi").notNull(),trackId:text("track_id").notNull(),seconds:real("seconds").notNull(),epubSha256:text("epub_sha256").notNull(),audioSha256:text("audio_sha256").notNull(),version:integer("version").notNull().default(1),updatedAt:text("updated_at").notNull()},t=>[primaryKey({columns:[t.userId,t.bookId]})]);

// Commercial catalog foundation. Gutenberg is an external source, not the identity model.
export const publishers = sqliteTable(
  "publishers",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    website: text("website").notNull().default(""),
    slug: text("slug").notNull().default(""),
    description: text("description").notNull().default(""),
    logoUrl: text("logo_url").notNull().default(""),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [uniqueIndex("idx_publishers_name").on(t.name), uniqueIndex("idx_publishers_slug").on(t.slug).where(sql`${t.slug} <> ''`)],
);
export const imprints = sqliteTable(
  "imprints",
  {
    id: text("id").primaryKey(),
    publisherId: text("publisher_id").notNull().references(() => publishers.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    slug: text("slug").notNull().default(""),
    description: text("description").notNull().default(""),
    website: text("website").notNull().default(""),
    logoUrl: text("logo_url").notNull().default(""),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [uniqueIndex("idx_imprints_publisher_name").on(t.publisherId, t.name), uniqueIndex("idx_imprints_slug").on(t.slug).where(sql`${t.slug} <> ''`)],
);
export const works = sqliteTable(
  "works",
  {
    id: text("id").primaryKey(),
    publicId: text("public_id"),
    title: text("title").notNull(),
    subtitle: text("subtitle").notNull().default(""),
    description: text("description").notNull().default(""),
    originalPublicationDate: text("original_publication_date"),
    originalLanguage: text("original_language"),
    minAge: integer("min_age"),
    maxAge: integer("max_age"),
    contentWarnings: text("content_warnings").notNull().default(""),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [index("idx_works_title").on(t.title), uniqueIndex("idx_works_public_id").on(t.publicId).where(sql`${t.publicId} IS NOT NULL`)],
);
export const contributors = sqliteTable(
  "contributors",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    sortName: text("sort_name").notNull().default(""),
    bio: text("bio").notNull().default(""),
    slug: text("slug").notNull().default(""),
    website: text("website").notNull().default(""),
    imageUrl: text("image_url").notNull().default(""),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [index("idx_contributors_name").on(t.name), uniqueIndex("idx_contributors_slug").on(t.slug).where(sql`${t.slug} <> ''`)],
);
export const editions = sqliteTable(
  "editions",
  {
    id: text("id").primaryKey(),
    publicId: text("public_id"),
    workId: text("work_id").notNull().references(() => works.id, { onDelete: "cascade" }),
    publisherId: text("publisher_id").references(() => publishers.id, { onDelete: "set null" }),
    imprintId: text("imprint_id").references(() => imprints.id, { onDelete: "set null" }),
    title: text("title").notNull(),
    subtitle: text("subtitle").notNull().default(""),
    description: text("description").notNull().default(""),
    editionNumber: text("edition_number").notNull().default(""),
    language: text("language").notNull().default("en"),
    originalLanguage: text("original_language"),
    publicationDate: text("publication_date"),
    releaseDate: text("release_date"),
    preorderDate: text("preorder_date"),
    isbn13: text("isbn13"),
    publisherIdentifier: text("publisher_identifier"),
    pageEstimate: integer("page_estimate"),
    wordCount: integer("word_count"),
    readingTimeMinutes: integer("reading_time_minutes"),
    fileSizeBytes: integer("file_size_bytes"),
    epubVersion: text("epub_version"),
    layout: text("layout").notNull().default("reflowable"),
    drmStatus: text("drm_status").notNull().default("none"),
    downloadable: integer("downloadable").notNull().default(1),
    releaseStatus: text("release_status").notNull().default("available"),
    subscriptionEligible: integer("subscription_eligible").notNull().default(0),
    libraryEligible: integer("library_eligible").notNull().default(0),
    publisherDescription: text("publisher_description").notNull().default(""),
    editorialReviews: text("editorial_reviews").notNull().default(""),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    index("idx_editions_work").on(t.workId),
    index("idx_editions_isbn13").on(t.isbn13),
    index("idx_editions_release").on(t.releaseDate),
    uniqueIndex("idx_editions_public_id").on(t.publicId).where(sql`${t.publicId} IS NOT NULL`),
  ],
);
export const editionContributors = sqliteTable(
  "edition_contributors",
  {
    editionId: text("edition_id").notNull().references(() => editions.id, { onDelete: "cascade" }),
    contributorId: text("contributor_id").notNull().references(() => contributors.id, { onDelete: "cascade" }),
    role: text("role").notNull(),
    position: integer("position").notNull().default(0),
  },
  (t) => [
    primaryKey({ columns: [t.editionId, t.contributorId, t.role] }),
    index("idx_edition_contributors_person").on(t.contributorId, t.role),
  ],
);
export const series = sqliteTable(
  "series",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    publisherId: text("publisher_id").references(() => publishers.id, { onDelete: "set null" }),
    slug: text("slug").notNull().default(""),
    seriesType: text("series_type").notNull().default("ordered"),
    heroImageUrl: text("hero_image_url").notNull().default(""),
    status: text("status").notNull().default("active"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [index("idx_series_name").on(t.name), uniqueIndex("idx_series_slug").on(t.slug).where(sql`${t.slug} <> ''`)],
);
export const seriesMemberships = sqliteTable(
  "series_memberships",
  {
    seriesId: text("series_id").notNull().references(() => series.id, { onDelete: "cascade" }),
    editionId: text("edition_id").notNull().references(() => editions.id, { onDelete: "cascade" }),
    position: real("position"),
    label: text("label").notNull().default(""),
    relationship: text("relationship").notNull().default("main"),
    readingOrder: real("reading_order"),
    displayOrder: integer("display_order").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.seriesId, t.editionId] })],
);
export const catalogEntitySlugs = sqliteTable(
  "catalog_entity_slugs",
  {
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id").notNull(),
    slug: text("slug").notNull(),
    canonical: integer("canonical").notNull().default(0),
    createdAt: text("created_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.entityType, t.slug] }), index("idx_catalog_entity_slugs_entity").on(t.entityType,t.entityId,t.canonical)],
);
export const workRelationships = sqliteTable(
  "work_relationships",
  {
    workId: text("work_id").notNull().references(() => works.id, { onDelete: "cascade" }),
    relatedWorkId: text("related_work_id").notNull().references(() => works.id, { onDelete: "cascade" }),
    relationship: text("relationship").notNull(),
    position: integer("position").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.workId,t.relatedWorkId,t.relationship] }), index("idx_work_relationships_related").on(t.relatedWorkId,t.relationship,t.position)],
);
export const personalExportEvents = sqliteTable(
  "personal_export_events",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    productId: text("product_id").notNull().references(() => products.id, { onDelete: "cascade" }),
    externalBookId: text("external_book_id").notNull(),
    exportKind: text("export_kind").notNull(),
    requestedAt: text("requested_at").notNull(),
  },
  (t) => [index("idx_personal_export_events_user_time").on(t.userId,t.requestedAt)],
);
export const categories = sqliteTable(
  "categories",
  {
    id: text("id").primaryKey(),
    scheme: text("scheme").notNull(),
    code: text("code").notNull().default(""),
    name: text("name").notNull(),
    parentId: text("parent_id"),
  },
  (t) => [uniqueIndex("idx_categories_scheme_name").on(t.scheme, t.name)],
);
export const editionCategories = sqliteTable(
  "edition_categories",
  {
    editionId: text("edition_id").notNull().references(() => editions.id, { onDelete: "cascade" }),
    categoryId: text("category_id").notNull().references(() => categories.id, { onDelete: "cascade" }),
    position: integer("position").notNull().default(0),
  },
  (t) => [
    primaryKey({ columns: [t.editionId, t.categoryId] }),
    index("idx_edition_categories_category").on(t.categoryId),
  ],
);
export const editionLanguages = sqliteTable(
  "edition_languages",
  {
    editionId: text("edition_id").notNull().references(() => editions.id, { onDelete: "cascade" }),
    languageCode: text("language_code").notNull(),
    kind: text("kind").notNull().default("content"),
  },
  (t) => [
    primaryKey({ columns: [t.editionId, t.languageCode, t.kind] }),
    index("idx_edition_languages_language").on(t.languageCode),
  ],
);
export const keywords = sqliteTable(
  "keywords",
  { id: text("id").primaryKey(), value: text("value").notNull() },
  (t) => [uniqueIndex("idx_keywords_value").on(t.value)],
);
export const editionKeywords = sqliteTable(
  "edition_keywords",
  {
    editionId: text("edition_id").notNull().references(() => editions.id, { onDelete: "cascade" }),
    keywordId: text("keyword_id").notNull().references(() => keywords.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.editionId, t.keywordId] })],
);
export const subjects = sqliteTable(
  "subjects",
  {
    id: text("id").primaryKey(),
    scheme: text("scheme").notNull().default("source"),
    code: text("code").notNull().default(""),
    name: text("name").notNull(),
    normalizedName: text("normalized_name").notNull(),
    parentId: text("parent_id"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [uniqueIndex("idx_subjects_scheme_normalized").on(t.scheme,t.normalizedName),index("idx_subjects_parent").on(t.parentId,t.name)],
);
export const editionSubjects = sqliteTable(
  "edition_subjects",
  {
    editionId: text("edition_id").notNull().references(() => editions.id, { onDelete: "cascade" }),
    subjectId: text("subject_id").notNull().references(() => subjects.id, { onDelete: "cascade" }),
    position: integer("position").notNull().default(0),
    source: text("source").notNull().default("metadata"),
  },
  (t) => [primaryKey({columns:[t.editionId,t.subjectId]}),index("idx_edition_subjects_subject").on(t.subjectId,t.editionId)],
);
export const languages = sqliteTable("languages", {
  code:text("code").primaryKey(),name:text("name").notNull().default(""),nativeName:text("native_name").notNull().default(""),direction:text("direction").notNull().default("ltr"),active:integer("active").notNull().default(1),createdAt:text("created_at").notNull(),updatedAt:text("updated_at").notNull(),
});
export const workContributors = sqliteTable(
  "work_contributors",
  {workId:text("work_id").notNull().references(()=>works.id,{onDelete:"cascade"}),contributorId:text("contributor_id").notNull().references(()=>contributors.id,{onDelete:"cascade"}),role:text("role").notNull().default("author"),position:integer("position").notNull().default(0)},
  (t)=>[primaryKey({columns:[t.workId,t.contributorId,t.role]}),index("idx_work_contributors_person").on(t.contributorId,t.role,t.workId)],
);
export const products = sqliteTable(
  "products",
  {
    id: text("id").primaryKey(),
    publicId: text("public_id"),
    editionId: text("edition_id").notNull().references(() => editions.id, { onDelete: "cascade" }),
    sku: text("sku").notNull(),
    format: text("format").notNull(),
    storefrontStatus: text("storefront_status").notNull().default("active"),
    sourceName: text("source_name").notNull(),
    sourceExternalId: text("source_external_id").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    uniqueIndex("idx_products_sku").on(t.sku),
    uniqueIndex("idx_products_source").on(t.sourceName, t.sourceExternalId),
    index("idx_products_edition").on(t.editionId),
    uniqueIndex("idx_products_public_id").on(t.publicId).where(sql`${t.publicId} IS NOT NULL`),
  ],
);
export const externalIdentifiers = sqliteTable(
  "external_identifiers",
  {
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id").notNull(),
    scheme: text("scheme").notNull(),
    value: text("value").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.entityType, t.entityId, t.scheme] }),
    uniqueIndex("idx_external_identifiers_lookup").on(t.scheme, t.value, t.entityType),
  ],
);
export const catalogPublicAliases = sqliteTable(
  "catalog_public_aliases",
  {entityType:text("entity_type").notNull(),alias:text("alias").notNull(),entityId:text("entity_id").notNull(),aliasKind:text("alias_kind").notNull().default("legacy"),canonical:integer("canonical").notNull().default(0),createdAt:text("created_at").notNull()},
  (t)=>[primaryKey({columns:[t.entityType,t.alias]}),index("idx_catalog_public_alias_entity").on(t.entityType,t.entityId,t.canonical)],
);
export const territories = sqliteTable("territories", {
  code: text("code").primaryKey(),
  name: text("name").notNull(),
  isoStatus: text("iso_status").notNull().default("official"),
  validFrom: text("valid_from"),
  validTo: text("valid_to"),
  isSellable: integer("is_sellable").notNull().default(1),
});
export const gutenbergSources = sqliteTable("gutenberg_sources", {
  id: text("id").primaryKey(),
  code: text("code").notNull().unique(),
  name: text("name").notNull(),
  homepageUrl: text("homepage_url").notNull(),
  catalogUrl: text("catalog_url").notNull(),
  licenseUrl: text("license_url").notNull(),
  publisherId: text("publisher_id").notNull(),
  identifierScheme: text("identifier_scheme").notNull().unique(),
  jurisdictionMode: text("jurisdiction_mode").notNull(),
  defaultTerritoryCode: text("default_territory_code").references(() => territories.code, { onDelete: "restrict" }),
  feedKind: text("feed_kind").notNull(),
  enabled: integer("enabled").notNull().default(1),
  priority: integer("priority").notNull().default(100),
  refreshSeconds: integer("refresh_seconds").notNull().default(86400),
  maxItemsPerRun: integer("max_items_per_run").notNull().default(250),
  rightsPolicy: text("rights_policy").notNull(),
  commercialPolicy: text("commercial_policy").notNull().default("canonicalize-before-retail"),
  trademarkCleanupRequired: integer("trademark_cleanup_required").notNull().default(0),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (t) => [index("idx_gutenberg_sources_enabled").on(t.enabled, t.priority)]);
export const gutenbergSourceStates = sqliteTable("gutenberg_source_states", {
  sourceId: text("source_id").primaryKey().references(() => gutenbergSources.id, { onDelete: "cascade" }),
  cursor: text("cursor"),
  cycleStartedAt: text("cycle_started_at"),
  etag: text("etag"),
  lastModified: text("last_modified"),
  contentHash: text("content_hash").notNull().default(""),
  status: text("status").notNull().default("idle"),
  lastRunAt: text("last_run_at"),
  lastSuccessAt: text("last_success_at"),
  lastError: text("last_error").notNull().default(""),
  attempts: integer("attempts").notNull().default(0),
  totalCatalogCount: integer("total_catalog_count").notNull().default(0),
  seenCount: integer("seen_count").notNull().default(0),
  acceptedCount: integer("accepted_count").notNull().default(0),
  quarantinedCount: integer("quarantined_count").notNull().default(0),
  nextRunAt: text("next_run_at"),
  leaseToken: text("lease_token"),
  leaseUntil: text("lease_until"),
  updatedAt: text("updated_at").notNull(),
}, (t) => [index("idx_gutenberg_source_states_due").on(t.status, t.nextRunAt)]);
export const gutenbergRightsEvidence = sqliteTable("gutenberg_rights_evidence", {
  id: text("id").primaryKey(),
  sourceId: text("source_id").notNull().references(() => gutenbergSources.id, { onDelete: "restrict" }),
  cacheId: text("cache_id").notNull().references(() => gutenbergSourceCache.id, { onDelete: "restrict" }),
  sourceItemId: text("source_item_id").notNull(),
  determination: text("determination").notNull(),
  territoryCode: text("territory_code").notNull().references(() => territories.code, { onDelete: "restrict" }),
  evidenceUrl: text("evidence_url").notNull(),
  evidenceType: text("evidence_type").notNull(),
  evidenceHash: text("evidence_hash").notNull(),
  parserVersion: text("parser_version").notNull(),
  status: text("status").notNull(),
  checkedAt: text("checked_at").notNull(),
  createdAt: text("created_at").notNull(),
}, (t) => [
  index("idx_gutenberg_evidence_item").on(t.sourceId, t.sourceItemId, t.status, t.territoryCode),
  index("idx_gutenberg_evidence_cache").on(t.cacheId, t.status),
]);
export const gutenbergIngestRuns = sqliteTable("gutenberg_ingest_runs", {
  id: text("id").primaryKey(),
  sourceId: text("source_id").notNull().references(() => gutenbergSources.id, { onDelete: "restrict" }),
  startedAt: text("started_at").notNull(),
  completedAt: text("completed_at"),
  status: text("status").notNull(),
  cursorBefore: text("cursor_before"),
  cursorAfter: text("cursor_after"),
  fetchedCount: integer("fetched_count").notNull().default(0),
  acceptedCount: integer("accepted_count").notNull().default(0),
  quarantinedCount: integer("quarantined_count").notNull().default(0),
  error: text("error").notNull().default(""),
  responseEtag: text("response_etag"),
  responseLastModified: text("response_last_modified"),
  responseHash: text("response_hash").notNull().default(""),
}, (t) => [index("idx_gutenberg_ingest_runs_source").on(t.sourceId, t.startedAt)]);
export const territoryAliases = sqliteTable("territory_aliases", {
  aliasCode:text("alias_code").primaryKey(),territoryCode:text("territory_code").notNull().references(()=>territories.code,{onDelete:"restrict"}),aliasType:text("alias_type").notNull().default("common"),notes:text("notes").notNull().default("")
});
export const territoryHistoricalEntities = sqliteTable("territory_historical_entities", {
  id:text("id").primaryKey(),historicalCode:text("historical_code").notNull(),name:text("name").notNull(),validFrom:text("valid_from"),validTo:text("valid_to"),notes:text("notes").notNull().default("")
},t=>[index("idx_territory_historical_code").on(t.historicalCode,t.validFrom,t.validTo)]);
export const territoryHistoricalSuccessors = sqliteTable("territory_historical_successors", {
  historicalEntityId:text("historical_entity_id").notNull().references(()=>territoryHistoricalEntities.id,{onDelete:"cascade"}),territoryCode:text("territory_code").notNull().references(()=>territories.code,{onDelete:"restrict"}),relationship:text("relationship").notNull().default("successor-market")
},t=>[primaryKey({columns:[t.historicalEntityId,t.territoryCode]})]);
export const territorySets = sqliteTable("territory_sets", {
  id:text("id").primaryKey(),code:text("code").notNull().unique(),name:text("name").notNull(),setType:text("set_type").notNull().default("custom"),description:text("description").notNull().default(""),status:text("status").notNull().default("active"),isSystem:integer("is_system").notNull().default(0),asOfDate:text("as_of_date"),createdAt:text("created_at").notNull(),updatedAt:text("updated_at").notNull()
});
export const territorySetRules = sqliteTable("territory_set_rules", {
  id:text("id").primaryKey(),setId:text("set_id").notNull().references(()=>territorySets.id,{onDelete:"cascade"}),effect:text("effect").notNull(),targetType:text("target_type").notNull(),territoryCode:text("territory_code").references(()=>territories.code,{onDelete:"restrict"}),targetSetId:text("target_set_id").references(()=>territorySets.id,{onDelete:"restrict"}),historicalCode:text("historical_code"),position:integer("position").notNull().default(0),createdAt:text("created_at").notNull()
},t=>[index("idx_territory_set_rules_set").on(t.setId,t.effect,t.position)]);
export const territorySetMembers = sqliteTable("territory_set_members", {
  setId:text("set_id").notNull().references(()=>territorySets.id,{onDelete:"cascade"}),territoryCode:text("territory_code").notNull().references(()=>territories.code,{onDelete:"restrict"}),resolutionSource:text("resolution_source").notNull().default(""),resolvedAt:text("resolved_at").notNull()
},t=>[primaryKey({columns:[t.setId,t.territoryCode]}),index("idx_territory_set_members_territory").on(t.territoryCode,t.setId)]);
export const rightsParties = sqliteTable("rights_parties", {
  id: text("id").primaryKey(),
  displayName: text("display_name").notNull(),
  partyType: text("party_type").notNull().default("publisher"),
  publisherId: text("publisher_id").references(() => publishers.id, { onDelete: "set null" }),
  contributorId: text("contributor_id").references(() => contributors.id, { onDelete: "set null" }),
  contactEmail: text("contact_email").notNull().default(""),
  referenceCode: text("reference_code").notNull().default(""),
  status: text("status").notNull().default("active"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (t) => [index("idx_rights_parties_publisher").on(t.publisherId,t.status)]);
export const rightsContracts = sqliteTable("rights_contracts", {
  id:text("id").primaryKey(),referenceCode:text("reference_code").notNull().unique(),name:text("name").notNull(),rightsholderPartyId:text("rightsholder_party_id").references(()=>rightsParties.id,{onDelete:"restrict"}),status:text("status").notNull().default("active"),effectiveFrom:text("effective_from"),effectiveTo:text("effective_to"),languageMatchMode:text("language_match_mode").notNull().default("all"),source:text("source").notNull().default("operator"),notes:text("notes").notNull().default(""),createdAt:text("created_at").notNull(),updatedAt:text("updated_at").notNull()
},t=>[index("idx_rights_contracts_party").on(t.rightsholderPartyId,t.status,t.effectiveFrom,t.effectiveTo)]);
export const rightsContractLanguages = sqliteTable("rights_contract_languages", {
  id:text("id").primaryKey(),contractId:text("contract_id").notNull().references(()=>rightsContracts.id,{onDelete:"cascade"}),languageCode:text("language_code").notNull(),decision:text("decision").notNull().default("allow"),format:text("format"),salesChannel:text("sales_channel"),startsAt:text("starts_at"),endsAt:text("ends_at"),notes:text("notes").notNull().default(""),createdAt:text("created_at").notNull()
},t=>[index("idx_rights_contract_languages_match").on(t.contractId,t.languageCode,t.decision,t.format,t.salesChannel,t.startsAt,t.endsAt)]);
export const rightsGrants = sqliteTable(
  "rights_grants",
  {
    id: text("id").primaryKey(),
    editionId: text("edition_id").notNull().references(() => editions.id, { onDelete: "cascade" }),
    rightsholderId: text("rightsholder_id").references(() => publishers.id, { onDelete: "set null" }),
    rightsholderPartyId: text("rightsholder_party_id"),
    territoryCode: text("territory_code").notNull().references(() => territories.code, { onDelete: "cascade" }),
    format: text("format").notNull(),
    salesChannel: text("sales_channel").notNull().default("retail"),
    startsAt: text("starts_at"),
    endsAt: text("ends_at"),
    licenseType: text("license_type").notNull(),
    drmRequirement: text("drm_requirement").notNull().default("none"),
    subscriptionPermitted: integer("subscription_permitted").notNull().default(0),
    libraryPermitted: integer("library_permitted").notNull().default(0),
    decision: text("decision").notNull().default("allow"),
    status: text("status").notNull().default("active"),
    promotionRestrictionsJson: text("promotion_restrictions_json").notNull().default("{}"),
    contractReference: text("contract_reference").notNull().default(""),
    source: text("source").notNull().default("operator"),
    notes: text("notes").notNull().default(""),
    contractId: text("contract_id").references(()=>rightsContracts.id,{onDelete:"restrict"}),
    exclusivity: text("exclusivity").notNull().default("nonexclusive"),
    scopeSummary: text("scope_summary").notNull().default(""),
    sourceEvidenceId: text("source_evidence_id"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at"),
  },
  (t) => [index("idx_rights_edition_territory").on(t.editionId, t.territoryCode, t.format),index("idx_rights_grant_match").on(t.editionId,t.territoryCode,t.format,t.salesChannel,t.status,t.decision,t.startsAt,t.endsAt),index("idx_rights_grant_party").on(t.rightsholderPartyId,t.status)],
);
export const rightsDecisions = sqliteTable("rights_decisions", {
  id:text("id").primaryKey(), productId:text("product_id").references(()=>products.id,{onDelete:"set null"}), editionId:text("edition_id").notNull().references(()=>editions.id,{onDelete:"restrict"}), grantId:text("grant_id").references(()=>rightsGrants.id,{onDelete:"set null"}), territoryCode:text("territory_code").notNull(), format:text("format").notNull(), salesChannel:text("sales_channel").notNull(), decision:text("decision").notNull(), reasonCode:text("reason_code").notNull(), rightsholderName:text("rightsholder_name").notNull().default(""), licenseType:text("license_type").notNull().default(""), drmRequirement:text("drm_requirement").notNull().default("none"), promotionRestrictionsJson:text("promotion_restrictions_json").notNull().default("{}"), contextJson:text("context_json").notNull().default("{}"), evaluatedAt:text("evaluated_at").notNull(), contractId:text("contract_id"), scopeSummary:text("scope_summary").notNull().default(""), exclusivity:text("exclusivity").notNull().default("nonexclusive"), languageRightsJson:text("language_rights_json").notNull().default("{}"), sourceEvidenceId:text("source_evidence_id")
},t=>[index("idx_rights_decisions_product").on(t.productId,t.evaluatedAt),index("idx_rights_decisions_edition").on(t.editionId,t.territoryCode,t.salesChannel,t.evaluatedAt)]);
export const rightsGrantAudit = sqliteTable("rights_grant_audit", {
  id:text("id").primaryKey(), grantId:text("grant_id").notNull(), action:text("action").notNull(), snapshotJson:text("snapshot_json").notNull(), recordedAt:text("recorded_at").notNull(),
},t=>[index("idx_rights_grant_audit_grant").on(t.grantId,t.recordedAt)]);
export const rightsGrantTerritoryScopes = sqliteTable("rights_grant_territory_scopes", {
  id:text("id").primaryKey(),grantId:text("grant_id").notNull().references(()=>rightsGrants.id,{onDelete:"cascade"}),effect:text("effect").notNull(),targetType:text("target_type").notNull(),territoryCode:text("territory_code").references(()=>territories.code,{onDelete:"restrict"}),territorySetId:text("territory_set_id").references(()=>territorySets.id,{onDelete:"restrict"}),historicalCode:text("historical_code"),asOfDate:text("as_of_date"),position:integer("position").notNull().default(0),createdAt:text("created_at").notNull()
},t=>[index("idx_rights_grant_scopes_grant").on(t.grantId,t.effect,t.position)]);
export const rightsGrantTerritories = sqliteTable("rights_grant_territories", {
  grantId:text("grant_id").notNull().references(()=>rightsGrants.id,{onDelete:"cascade"}),territoryCode:text("territory_code").notNull().references(()=>territories.code,{onDelete:"restrict"}),resolvedFrom:text("resolved_from").notNull().default(""),snapshottedAt:text("snapshotted_at").notNull()
},t=>[primaryKey({columns:[t.grantId,t.territoryCode]}),index("idx_rights_grant_territories_lookup").on(t.territoryCode,t.grantId)]);
export const rightsGrantScopeSnapshots = sqliteTable("rights_grant_scope_snapshots", {
  id:text("id").primaryKey(),grantId:text("grant_id").notNull(),scopeJson:text("scope_json").notNull(),territoriesJson:text("territories_json").notNull(),recordedAt:text("recorded_at").notNull()
},t=>[index("idx_rights_scope_snapshots_grant").on(t.grantId,t.recordedAt)]);
export const rightsConfigurationAudit = sqliteTable("rights_configuration_audit", {
  id:text("id").primaryKey(),entityType:text("entity_type").notNull(),entityId:text("entity_id").notNull(),action:text("action").notNull(),snapshotJson:text("snapshot_json").notNull(),recordedAt:text("recorded_at").notNull()
},t=>[index("idx_rights_configuration_audit_entity").on(t.entityType,t.entityId,t.recordedAt)]);
export const offers = sqliteTable(
  "offers",
  {
    id: text("id").primaryKey(),
    productId: text("product_id").notNull().references(() => products.id, { onDelete: "cascade" }),
    offerType: text("offer_type").notNull(),
    salesChannel: text("sales_channel").notNull().default("retail"),
    currency: text("currency").notNull(),
    amountMinor: integer("amount_minor").notNull(),
    taxBehavior: text("tax_behavior").notNull().default("exclusive"),
    taxCode: text("tax_code").notNull().default("txcd_10302000"),
    active: integer("active").notNull().default(1),
    startsAt: text("starts_at"),
    endsAt: text("ends_at"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [index("idx_offers_product_active").on(t.productId, t.active, t.startsAt, t.endsAt)],
);
export const priceSchedules = sqliteTable(
  "price_schedules",
  {
    id: text("id").primaryKey(),
    offerId: text("offer_id").notNull().references(() => offers.id, { onDelete: "cascade" }),
    currency: text("currency").notNull(),
    amountMinor: integer("amount_minor").notNull(),
    startsAt: text("starts_at").notNull(),
    endsAt: text("ends_at"),
    territoryCode: text("territory_code"),
    priceKind: text("price_kind").notNull().default("list"),
    source: text("source").notNull().default("publisher"),
    reason: text("reason").notNull().default(""),
    createdAt: text("created_at"),
  },
  (t) => [index("idx_price_schedules_offer").on(t.offerId, t.startsAt),index("idx_price_schedules_scope").on(t.offerId,t.territoryCode,t.currency,t.startsAt,t.endsAt)],
);
export const promotions = sqliteTable("promotions", {
  id: text("id").primaryKey(),
  offerId: text("offer_id").notNull().references(() => offers.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  promotionType: text("promotion_type").notNull(),
  amountMinor: integer("amount_minor"),
  startsAt: text("starts_at").notNull(),
  endsAt: text("ends_at").notNull(),
  active: integer("active").notNull().default(1),
  fundingSource: text("funding_source").notNull().default("publisher"),
  publisherFundingBps: integer("publisher_funding_bps").notNull().default(10000),
  territoryCode: text("territory_code"),
  couponRequired: integer("coupon_required").notNull().default(0),
});
export const digitalAssets = sqliteTable(
  "digital_assets",
  {
    id: text("id").primaryKey(),
    editionId: text("edition_id").notNull().references(() => editions.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    currentVersionId: text("current_version_id"),
    drmStatus: text("drm_status").notNull().default("none"),
    downloadable: integer("downloadable").notNull().default(1),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [uniqueIndex("idx_digital_assets_edition_kind").on(t.editionId, t.kind)],
);
export const assetVersions = sqliteTable(
  "asset_versions",
  {
    id: text("id").primaryKey(),
    assetId: text("asset_id").notNull().references(() => digitalAssets.id, { onDelete: "cascade" }),
    versionNumber: integer("version_number").notNull(),
    objectKey: text("object_key"),
    sourceUrl: text("source_url"),
    mimeType: text("mime_type").notNull(),
    sizeBytes: integer("size_bytes"),
    sha256: text("sha256"),
    epubVersion: text("epub_version"),
    createdAt: text("created_at").notNull(),
  },
  (t) => [uniqueIndex("idx_asset_versions_number").on(t.assetId, t.versionNumber)],
);
export const accessibilityMetadata = sqliteTable("accessibility_metadata", {
  editionId: text("edition_id").primaryKey().references(() => editions.id, { onDelete: "cascade" }),
  screenReaderCompatible: integer("screen_reader_compatible"),
  altTextComplete: integer("alt_text_complete"),
  semanticStructure: integer("semantic_structure"),
  accessibilitySummary: text("accessibility_summary").notNull().default(""),
  certifier: text("certifier").notNull().default(""),
  updatedAt: text("updated_at").notNull(),
});
export const catalogSearchDocuments = sqliteTable(
  "catalog_search_documents",
  {
    productId: text("product_id").primaryKey().references(() => products.id, { onDelete: "cascade" }),
    externalBookId: text("external_book_id").notNull(),
    title: text("title").notNull(),
    subtitle: text("subtitle").notNull().default(""),
    contributorsText: text("contributors_text").notNull().default(""),
    subjectsText: text("subjects_text").notNull().default(""),
    bookshelvesText: text("bookshelves_text").notNull().default(""),
    categoriesText: text("categories_text").notNull().default(""),
    languagesText: text("languages_text").notNull().default(""),
    keywordsText: text("keywords_text").notNull().default(""),
    description: text("description").notNull().default(""),
    downloadCount: integer("download_count").notNull().default(0),
    releaseDate: text("release_date"),
    publicationDate: text("publication_date"),
    preorderDate: text("preorder_date"),
    productCreatedAt: text("product_created_at"),
    productUpdatedAt: text("product_updated_at"),
    taxonomyText: text("taxonomy_text").notNull().default(""),
    publisherText: text("publisher_text").notNull().default(""),
    imprintText: text("imprint_text").notNull().default(""),
    seriesText: text("series_text").notNull().default(""),
    isbn13: text("isbn13").notNull().default(""),
    format: text("format").notNull().default("ebook"),
    currency: text("currency").notNull().default("USD"),
    priceMinor: integer("price_minor").notNull().default(0),
    subscriptionEligible: integer("subscription_eligible").notNull().default(0),
    libraryEligible: integer("library_eligible").notNull().default(0),
    averageRating: real("average_rating").notNull().default(0),
    reviewCount: integer("review_count").notNull().default(0),
    salesVelocity: real("sales_velocity").notNull().default(0),
    merchandisingBoost: real("merchandising_boost").notNull().default(0),
    availability: text("availability").notNull().default("available"),
    isDeal: integer("is_deal").notNull().default(0),
    suppressed: integer("suppressed").notNull().default(0),
    firstIngestedAt: text("first_ingested_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    uniqueIndex("idx_search_external_book").on(t.externalBookId),
    index("idx_search_popular").on(t.downloadCount),
    index("idx_search_added").on(t.firstIngestedAt),
    index("idx_search_price").on(t.currency, t.priceMinor),
    index("idx_search_rating").on(t.averageRating, t.reviewCount),
    index("idx_search_release").on(t.releaseDate),
    index("idx_search_publication_date").on(t.publicationDate),
    index("idx_search_preorder_date").on(t.preorderDate),
    index("idx_search_product_created").on(t.productCreatedAt),
    index("idx_search_product_updated").on(t.productUpdatedAt),
  ],
);

export const storefrontTaxonomies = sqliteTable(
  "storefront_taxonomies",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    version: text("version").notNull(),
    status: text("status").notNull().default("active"),
    isDefault: integer("is_default").notNull().default(0),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [uniqueIndex("idx_storefront_taxonomy_default").on(t.isDefault).where(sql`${t.isDefault} = 1`)],
);
export const storefrontTaxonomyNodes = sqliteTable(
  "storefront_taxonomy_nodes",
  {
    id: text("id").primaryKey(),
    taxonomyId: text("taxonomy_id").notNull().references(() => storefrontTaxonomies.id, { onDelete: "cascade" }),
    parentId: text("parent_id"),
    slug: text("slug").notNull(),
    path: text("path").notNull(),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    depth: integer("depth").notNull().default(0),
    sortOrder: integer("sort_order").notNull().default(0),
    visible: integer("visible").notNull().default(1),
    featured: integer("featured").notNull().default(0),
    seoTitle: text("seo_title").notNull().default(""),
    seoDescription: text("seo_description").notNull().default(""),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    uniqueIndex("idx_storefront_taxonomy_path").on(t.taxonomyId, t.path),
    index("idx_storefront_taxonomy_parent").on(t.taxonomyId, t.parentId, t.sortOrder),
    index("idx_storefront_taxonomy_visible").on(t.taxonomyId, t.visible, t.featured, t.sortOrder),
  ],
);
export const storefrontTaxonomyMappings = sqliteTable(
  "storefront_taxonomy_mappings",
  {
    id: text("id").primaryKey(),
    taxonomyNodeId: text("taxonomy_node_id").notNull().references(() => storefrontTaxonomyNodes.id, { onDelete: "cascade" }),
    sourceScheme: text("source_scheme").notNull(),
    sourceValue: text("source_value").notNull(),
    matchMode: text("match_mode").notNull().default("contains"),
    priority: integer("priority").notNull().default(0),
    active: integer("active").notNull().default(1),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [index("idx_storefront_taxonomy_mapping_source").on(t.sourceScheme, t.active, t.priority)],
);
export const editionTaxonomyNodes = sqliteTable(
  "edition_taxonomy_nodes",
  {
    editionId: text("edition_id").notNull().references(() => editions.id, { onDelete: "cascade" }),
    taxonomyNodeId: text("taxonomy_node_id").notNull().references(() => storefrontTaxonomyNodes.id, { onDelete: "cascade" }),
    source: text("source").notNull().default("mapping"),
    confidence: real("confidence").notNull().default(1),
    isPrimary: integer("is_primary").notNull().default(0),
    createdAt: text("created_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.editionId, t.taxonomyNodeId] }), index("idx_edition_taxonomy_node").on(t.taxonomyNodeId, t.editionId)],
);
export const storefrontPages = sqliteTable(
  "storefront_pages",
  {
    id: text("id").primaryKey(),
    path: text("path").notNull(),
    pageType: text("page_type").notNull().default("browse"),
    title: text("title").notNull(),
    heading: text("heading").notNull(),
    description: text("description").notNull().default(""),
    eyebrow: text("eyebrow").notNull().default(""),
    seoTitle: text("seo_title").notNull().default(""),
    seoDescription: text("seo_description").notNull().default(""),
    taxonomyNodeId: text("taxonomy_node_id").references(() => storefrontTaxonomyNodes.id, { onDelete: "set null" }),
    collectionId: text("collection_id"),
    queryJson: text("query_json").notNull().default("{}"),
    status: text("status").notNull().default("published"),
    territoryCode: text("territory_code"),
    languageCode: text("language_code"),
    startsAt: text("starts_at"),
    endsAt: text("ends_at"),
    noindex: integer("noindex").notNull().default(0),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [uniqueIndex("idx_storefront_pages_path").on(t.path), index("idx_storefront_pages_publish").on(t.status, t.territoryCode, t.languageCode, t.startsAt, t.endsAt)],
);

export const storefrontRedirects = sqliteTable(
  "storefront_redirects",
  { fromPath: text("from_path").primaryKey(), toPath: text("to_path").notNull(), statusCode: integer("status_code").notNull().default(301), createdAt: text("created_at").notNull(), updatedAt: text("updated_at").notNull() },
  (t) => [index("idx_storefront_redirect_target").on(t.toPath)],
);

export const merchCampaigns = sqliteTable(
  "merch_campaigns",
  {
    id: text("id").primaryKey(), slug: text("slug").notNull(), name: text("name").notNull(),
    status: text("status").notNull().default("draft"), campaignType: text("campaign_type").notNull().default("editorial"),
    priority: integer("priority").notNull().default(0), territoryCode: text("territory_code"), languageCode: text("language_code"),
    audienceJson: text("audience_json").notNull().default("{}"), startsAt: text("starts_at"), endsAt: text("ends_at"),
    createdBy: text("created_by").notNull().default("operator"), createdAt: text("created_at").notNull(), updatedAt: text("updated_at").notNull(),
  },
  (t) => [uniqueIndex("idx_merch_campaign_slug").on(t.slug), index("idx_merch_campaign_live").on(t.status, t.territoryCode, t.languageCode, t.startsAt, t.endsAt, t.priority)],
);
export const merchSlots = sqliteTable(
  "merch_slots",
  { id: text("id").primaryKey(), slotKey: text("slot_key").notNull(), name: text("name").notNull(), placementType: text("placement_type").notNull().default("rail"), maxItems: integer("max_items").notNull().default(12), description: text("description").notNull().default(""), active: integer("active").notNull().default(1), maxPlacements: integer("max_placements").notNull().default(1), createdAt: text("created_at").notNull(), updatedAt: text("updated_at").notNull() },
  (t) => [uniqueIndex("idx_merch_slot_key").on(t.slotKey)],
);
export const merchCollections = sqliteTable(
  "merch_collections",
  { id: text("id").primaryKey(), slug: text("slug").notNull(), title: text("title").notNull(), description: text("description").notNull().default(""), curator: text("curator").notNull().default("Cove editors"), mode: text("mode").notNull().default("manual"), queryJson: text("query_json").notNull().default("{}"), status: text("status").notNull().default("draft"), territoryCode: text("territory_code"), languageCode: text("language_code"), startsAt: text("starts_at"), endsAt: text("ends_at"), createdAt: text("created_at").notNull(), updatedAt: text("updated_at").notNull() },
  (t) => [uniqueIndex("idx_merch_collection_slug").on(t.slug), index("idx_merch_collection_live").on(t.status, t.territoryCode, t.languageCode, t.startsAt, t.endsAt)],
);
export const merchCollectionItems = sqliteTable(
  "merch_collection_items",
  { collectionId: text("collection_id").notNull().references(() => merchCollections.id, { onDelete: "cascade" }), productId: text("product_id").notNull().references(() => products.id, { onDelete: "cascade" }), sortOrder: integer("sort_order").notNull().default(0), badge: text("badge").notNull().default(""), titleOverride: text("title_override").notNull().default(""), subtitleOverride: text("subtitle_override").notNull().default(""), startsAt: text("starts_at"), endsAt: text("ends_at") },
  (t) => [primaryKey({ columns: [t.collectionId, t.productId] }), index("idx_merch_collection_items_order").on(t.collectionId, t.sortOrder)],
);
export const merchExperiments = sqliteTable(
  "merch_experiments",
  { id: text("id").primaryKey(), experimentKey: text("experiment_key").notNull(), name: text("name").notNull(), status: text("status").notNull().default("draft"), variantsJson: text("variants_json").notNull().default('[{"key":"control","weight":100}]'), startsAt: text("starts_at"), endsAt: text("ends_at"), createdAt: text("created_at").notNull(), updatedAt: text("updated_at").notNull() },
  (t) => [uniqueIndex("idx_merch_experiment_key").on(t.experimentKey), index("idx_merch_experiment_live").on(t.status, t.startsAt, t.endsAt)],
);
export const merchPlacements = sqliteTable(
  "merch_placements",
  { id: text("id").primaryKey(), campaignId: text("campaign_id").notNull().references(() => merchCampaigns.id, { onDelete: "cascade" }), slotId: text("slot_id").notNull().references(() => merchSlots.id, { onDelete: "cascade" }), sourceType: text("source_type").notNull().default("collection"), productId: text("product_id").references(() => products.id, { onDelete: "cascade" }), collectionId: text("collection_id").references(() => merchCollections.id, { onDelete: "cascade" }), queryJson: text("query_json").notNull().default("{}"), title: text("title").notNull().default(""), eyebrow: text("eyebrow").notNull().default(""), body: text("body").notNull().default(""), ctaLabel: text("cta_label").notNull().default(""), ctaHref: text("cta_href").notNull().default(""), imageUrl: text("image_url").notNull().default(""), badge: text("badge").notNull().default(""), sortOrder: integer("sort_order").notNull().default(0), weight: integer("weight").notNull().default(100), sponsored: integer("sponsored").notNull().default(0), sponsorName: text("sponsor_name").notNull().default(""), territoryCode: text("territory_code"), languageCode: text("language_code"), experimentId: text("experiment_id").references(() => merchExperiments.id, { onDelete: "set null" }), experimentVariant: text("experiment_variant"), startsAt: text("starts_at"), endsAt: text("ends_at"), active: integer("active").notNull().default(1), createdAt: text("created_at").notNull(), updatedAt: text("updated_at").notNull() },
  (t) => [index("idx_merch_placements_slot").on(t.slotId, t.active, t.sortOrder), index("idx_merch_placements_schedule").on(t.active, t.territoryCode, t.languageCode, t.startsAt, t.endsAt), index("idx_merch_placements_campaign").on(t.campaignId)],
);
export const merchEvents = sqliteTable(
  "merch_events",
  { id: text("id").primaryKey(), eventType: text("event_type").notNull(), placementId: text("placement_id").notNull().references(() => merchPlacements.id, { onDelete: "cascade" }), campaignId: text("campaign_id").notNull().references(() => merchCampaigns.id, { onDelete: "cascade" }), slotKey: text("slot_key").notNull(), visitorId: text("visitor_id").notNull(), userId: text("user_id"), productId: text("product_id").references(() => products.id, { onDelete: "set null" }), experimentId: text("experiment_id"), experimentVariant: text("experiment_variant"), position: integer("position"), pageViewId: text("page_view_id"), createdAt: text("created_at").notNull() },
  (t) => [index("idx_merch_events_campaign").on(t.campaignId, t.eventType, t.createdAt), index("idx_merch_events_placement").on(t.placementId, t.eventType, t.createdAt), index("idx_merch_events_visitor").on(t.visitorId, t.createdAt)],
);

export const storefrontAdminAudit = sqliteTable(
  "storefront_admin_audit",
  { id: text("id").primaryKey(), actor: text("actor").notNull(), action: text("action").notNull(), entityType: text("entity_type").notNull(), entityId: text("entity_id").notNull(), beforeJson: text("before_json"), afterJson: text("after_json"), createdAt: text("created_at").notNull() },
  (t) => [index("idx_storefront_admin_audit_entity").on(t.entityType, t.entityId, t.createdAt), index("idx_storefront_admin_audit_recent").on(t.createdAt)],
);

// FTS5 virtual tables are created by migration 0006 and intentionally are not modeled by Drizzle.
export const searchIndexOutbox = sqliteTable("search_index_outbox", {
  productId: text("product_id").primaryKey(),
  operation: text("operation").notNull().default("upsert"),
  queuedAt: text("queued_at").notNull(),
  attempts: integer("attempts").notNull().default(0),
  lastError: text("last_error").notNull().default(""),
});
export const searchIndexState = sqliteTable("search_index_state", {
  id: integer("id").primaryKey(),
  backend: text("backend").notNull().default("d1"),
  indexUid: text("index_uid").notNull().default("fore_books"),
  settingsVersion: integer("settings_version").notNull().default(0),
  lastSyncedAt: text("last_synced_at"),
  lastError: text("last_error").notNull().default(""),
  documentsIndexed: integer("documents_indexed").notNull().default(0),
});
export const searchSynonyms = sqliteTable("search_synonyms", {
  term: text("term").primaryKey(),
  synonymsJson: text("synonyms_json").notNull(),
  enabled: integer("enabled").notNull().default(1),
  updatedAt: text("updated_at").notNull(),
});
export const searchQueryEvents = sqliteTable(
  "search_query_events",
  {
    id: text("id").primaryKey(),
    userId: text("user_id"),
    query: text("query").notNull().default(""),
    normalizedQuery: text("normalized_query").notNull().default(""),
    filtersJson: text("filters_json").notNull().default("{}"),
    sort: text("sort").notNull().default("relevance"),
    resultCount: integer("result_count").notNull().default(0),
    backend: text("backend").notNull(),
    durationMs: integer("duration_ms").notNull().default(0),
    correctedQuery: text("corrected_query"),
    resultImpressionsJson: text("result_impressions_json").notNull().default("[]"),
    createdAt: text("created_at").notNull(),
  },
  (t) => [index("idx_search_events_recent").on(t.createdAt), index("idx_search_events_query").on(t.normalizedQuery, t.createdAt)],
);
export const searchClickEvents = sqliteTable(
  "search_click_events",
  {
    queryId: text("query_id").notNull().references(() => searchQueryEvents.id, { onDelete: "cascade" }),
    productId: text("product_id").notNull().references(() => products.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.queryId, t.productId, t.position] }), index("idx_search_clicks_product").on(t.productId, t.createdAt)],
);
export const searchMerchandisingRules = sqliteTable(
  "search_merchandising_rules",
  {
    id: text("id").primaryKey(),
    productId: text("product_id").notNull().references(() => products.id, { onDelete: "cascade" }),
    boost: real("boost").notNull().default(0),
    startsAt: text("starts_at"),
    endsAt: text("ends_at"),
    active: integer("active").notNull().default(1),
    reason: text("reason").notNull().default(""),
  },
  (t) => [index("idx_search_merchandising_active").on(t.active, t.startsAt, t.endsAt)],
);
export const entitlements = sqliteTable(
  "entitlements",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    productId: text("product_id").notNull().references(() => products.id, { onDelete: "cascade" }),
    entitlementType: text("entitlement_type").notNull(),
    status: text("status").notNull().default("active"),
    source: text("source").notNull(),
    orderItemId: text("order_item_id"),
    startsAt: text("starts_at"),
    endsAt: text("ends_at"),
    grantedAt: text("granted_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    uniqueIndex("idx_entitlements_user_product_type").on(t.userId, t.productId, t.entitlementType),
    index("idx_entitlements_active").on(t.userId, t.status, t.endsAt),
  ],
);
export const readingStates = sqliteTable(
  "reading_states",
  {
    userId: text("user_id").notNull(),
    productId: text("product_id").notNull().references(() => products.id, { onDelete: "cascade" }),
    externalBookId: text("external_book_id").notNull(),
    inLibrary: integer("in_library").notNull().default(1),
    status: text("status").notNull().default("want-to-read"),
    progress: real("progress").notNull().default(0),
    cfi: text("cfi").notNull().default(""),
    legacyShelvesJson: text("legacy_shelves_json").notNull().default("[]"),
    legacyRating: real("legacy_rating"),
    legacyReview: text("legacy_review").notNull().default(""),
    reviewMigrated: integer("review_migrated").notNull().default(0),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.productId] }),
    index("idx_reading_states_library").on(t.userId, t.inLibrary, t.updatedAt),
  ],
);
export const personalImports = sqliteTable(
  "personal_imports",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    productId: text("product_id").notNull().references(() => products.id, { onDelete: "cascade" }),
    objectKey: text("object_key").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [index("idx_personal_imports_user").on(t.userId)],
);
export const shelfItems = sqliteTable(
  "shelf_items",
  {
    shelfId: text("shelf_id").notNull().references(() => shelves.id, { onDelete: "cascade" }),
    productId: text("product_id").notNull().references(() => products.id, { onDelete: "cascade" }),
    externalBookId: text("external_book_id").notNull(),
    position: integer("position").notNull().default(0),
    note: text("note").notNull().default(""),
    addedAt: text("added_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.shelfId, t.productId] }),
    index("idx_shelf_items_order").on(t.shelfId, t.position),
  ],
);
export const completionEvents = sqliteTable(
  "completion_events",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    productId: text("product_id").notNull().references(() => products.id, { onDelete: "cascade" }),
    externalBookId: text("external_book_id").notNull(),
    finishedAt: text("finished_at").notNull(),
  },
  (t) => [index("idx_completion_events_user_date").on(t.userId, t.finishedAt)],
);
export const prices = sqliteTable(
  "prices",
  {
    id: text("id").primaryKey(),
    offerId: text("offer_id").notNull().references(() => offers.id, { onDelete: "cascade" }),
    territoryCode: text("territory_code").references(() => territories.code, { onDelete: "cascade" }),
    currency: text("currency").notNull(),
    amountMinor: integer("amount_minor").notNull(),
    taxInclusive: integer("tax_inclusive").notNull().default(0),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [uniqueIndex("idx_prices_offer_territory_currency").on(t.offerId, t.territoryCode, t.currency)],
);
export const orders = sqliteTable(
  "orders",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    status: text("status").notNull(),
    currency: text("currency").notNull(),
    subtotalMinor: integer("subtotal_minor").notNull(),
    taxMinor: integer("tax_minor").notNull().default(0),
    totalMinor: integer("total_minor").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [index("idx_orders_user_date").on(t.userId, t.createdAt)],
);
export const orderItems = sqliteTable(
  "order_items",
  {
    id: text("id").primaryKey(),
    orderId: text("order_id").notNull().references(() => orders.id, { onDelete: "cascade" }),
    productId: text("product_id").notNull().references(() => products.id, { onDelete: "restrict" }),
    offerId: text("offer_id").references(() => offers.id, { onDelete: "set null" }),
    unitAmountMinor: integer("unit_amount_minor").notNull(),
    taxMinor: integer("tax_minor").notNull().default(0),
    quantity: integer("quantity").notNull().default(1),
    fulfillmentStatus: text("fulfillment_status").notNull().default("pending"),
    createdAt: text("created_at").notNull(),
  },
  (t) => [index("idx_order_items_order").on(t.orderId), index("idx_order_items_product").on(t.productId)],
);
export const payments = sqliteTable(
  "payments",
  {
    id: text("id").primaryKey(),
    orderId: text("order_id").notNull().references(() => orders.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    providerPaymentId: text("provider_payment_id"),
    status: text("status").notNull(),
    amountMinor: integer("amount_minor").notNull(),
    currency: text("currency").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [uniqueIndex("idx_payments_provider_id").on(t.provider, t.providerPaymentId), index("idx_payments_order").on(t.orderId)],
);
export const refunds = sqliteTable(
  "refunds",
  {
    id: text("id").primaryKey(),
    paymentId: text("payment_id").notNull().references(() => payments.id, { onDelete: "cascade" }),
    orderItemId: text("order_item_id").references(() => orderItems.id, { onDelete: "set null" }),
    amountMinor: integer("amount_minor").notNull(),
    currency: text("currency").notNull(),
    status: text("status").notNull(),
    reason: text("reason").notNull().default(""),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [index("idx_refunds_payment").on(t.paymentId)],
);
export const licenses = sqliteTable(
  "licenses",
  {
    id: text("id").primaryKey(),
    entitlementId: text("entitlement_id").notNull().references(() => entitlements.id, { onDelete: "cascade" }),
    licenseType: text("license_type").notNull(),
    drmPolicy: text("drm_policy").notNull().default("none"),
    downloadable: integer("downloadable").notNull().default(1),
    maxDevices: integer("max_devices"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [uniqueIndex("idx_licenses_entitlement").on(t.entitlementId)],
);
export const devices = sqliteTable(
  "devices",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    deviceKey: text("device_key").notNull(),
    name: text("name").notNull().default(""),
    platform: text("platform").notNull().default(""),
    lastSeenAt: text("last_seen_at").notNull(),
    revokedAt: text("revoked_at"),
    createdAt: text("created_at").notNull(),
  },
  (t) => [uniqueIndex("idx_devices_user_key").on(t.userId, t.deviceKey)],
);
export const subscriptions = sqliteTable(
  "subscriptions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    planCode: text("plan_code").notNull(),
    status: text("status").notNull(),
    currentPeriodStart: text("current_period_start").notNull(),
    currentPeriodEnd: text("current_period_end").notNull(),
    cancelAtEnd: integer("cancel_at_end").notNull().default(0),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [index("idx_subscriptions_user_status").on(t.userId, t.status)],
);
export const subscriptionCatalog = sqliteTable(
  "subscription_catalog",
  {
    productId: text("product_id").notNull().references(() => products.id, { onDelete: "cascade" }),
    planCode: text("plan_code").notNull(),
    territoryCode: text("territory_code").notNull().references(() => territories.code, { onDelete: "cascade" }),
    startsAt: text("starts_at"),
    endsAt: text("ends_at"),
  },
  (t) => [primaryKey({ columns: [t.productId, t.planCode, t.territoryCode] })],
);
export const subscriptionUsage = sqliteTable(
  "subscription_usage",
  {
    id: text("id").primaryKey(),
    subscriptionId: text("subscription_id").notNull().references(() => subscriptions.id, { onDelete: "cascade" }),
    productId: text("product_id").notNull().references(() => products.id, { onDelete: "restrict" }),
    metric: text("metric").notNull(),
    quantity: real("quantity").notNull(),
    occurredAt: text("occurred_at").notNull(),
  },
  (t) => [index("idx_subscription_usage_period").on(t.subscriptionId, t.occurredAt)],
);
export const publisherAccounts = sqliteTable("publisher_accounts", {
  id: text("id").primaryKey(),
  legalName: text("legal_name").notNull(),
  displayName: text("display_name").notNull(),
  status: text("status").notNull().default("pending"),
  countryCode: text("country_code"),
  taxProfileStatus: text("tax_profile_status").notNull().default("missing"),
  payoutProfileStatus: text("payout_profile_status").notNull().default("missing"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});
export const publisherUsers = sqliteTable(
  "publisher_users",
  {
    publisherAccountId: text("publisher_account_id").notNull().references(() => publisherAccounts.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull(),
    role: text("role").notNull(),
    status: text("status").notNull().default("active"),
    createdAt: text("created_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.publisherAccountId, t.userId] })],
);
export const royaltyContracts = sqliteTable(
  "royalty_contracts",
  {
    id: text("id").primaryKey(),
    publisherAccountId: text("publisher_account_id").notNull().references(() => publisherAccounts.id, { onDelete: "cascade" }),
    productId: text("product_id").references(() => products.id, { onDelete: "set null" }),
    territoryCode: text("territory_code").references(() => territories.code, { onDelete: "set null" }),
    channel: text("channel").notNull(),
    rateBps: integer("rate_bps").notNull(),
    termsVersion: text("terms_version").notNull(),
    effectiveAt: text("effective_at").notNull(),
    endsAt: text("ends_at"),
    createdAt: text("created_at").notNull(),
  },
  (t) => [index("idx_royalty_contract_lookup").on(t.publisherAccountId, t.productId, t.channel, t.effectiveAt)],
);
export const royaltyEvents = sqliteTable(
  "royalty_events",
  {
    id: text("id").primaryKey(),
    publisherAccountId: text("publisher_account_id").notNull().references(() => publisherAccounts.id, { onDelete: "restrict" }),
    productId: text("product_id").notNull().references(() => products.id, { onDelete: "restrict" }),
    orderItemId: text("order_item_id").references(() => orderItems.id, { onDelete: "set null" }),
    subscriptionUsageId: text("subscription_usage_id").references(() => subscriptionUsage.id, { onDelete: "set null" }),
    eventType: text("event_type").notNull(),
    grossMinor: integer("gross_minor").notNull().default(0),
    netMinor: integer("net_minor").notNull().default(0),
    royaltyMinor: integer("royalty_minor").notNull(),
    currency: text("currency").notNull(),
    occurredAt: text("occurred_at").notNull(),
  },
  (t) => [index("idx_royalty_events_publisher_period").on(t.publisherAccountId, t.occurredAt)],
);
export const ledgerEntries = sqliteTable(
  "ledger_entries",
  {
    id: text("id").primaryKey(),
    accountType: text("account_type").notNull(),
    accountId: text("account_id").notNull(),
    orderId: text("order_id").references(() => orders.id, { onDelete: "set null" }),
    royaltyEventId: text("royalty_event_id").references(() => royaltyEvents.id, { onDelete: "set null" }),
    entryType: text("entry_type").notNull(),
    amountMinor: integer("amount_minor").notNull(),
    currency: text("currency").notNull(),
    occurredAt: text("occurred_at").notNull(),
    metadataJson: text("metadata_json").notNull().default("{}"),
  },
  (t) => [index("idx_ledger_account_period").on(t.accountType, t.accountId, t.occurredAt)],
);
export const payouts = sqliteTable(
  "payouts",
  {
    id: text("id").primaryKey(),
    publisherAccountId: text("publisher_account_id").notNull().references(() => publisherAccounts.id, { onDelete: "restrict" }),
    status: text("status").notNull(),
    currency: text("currency").notNull(),
    amountMinor: integer("amount_minor").notNull(),
    periodStart: text("period_start").notNull(),
    periodEnd: text("period_end").notNull(),
    providerReference: text("provider_reference"),
    createdAt: text("created_at").notNull(),
    paidAt: text("paid_at"),
  },
  (t) => [index("idx_payouts_publisher_period").on(t.publisherAccountId, t.periodEnd)],
);
export const statements = sqliteTable(
  "statements",
  {
    id: text("id").primaryKey(),
    publisherAccountId: text("publisher_account_id").notNull().references(() => publisherAccounts.id, { onDelete: "restrict" }),
    periodStart: text("period_start").notNull(),
    periodEnd: text("period_end").notNull(),
    currency: text("currency").notNull(),
    grossMinor: integer("gross_minor").notNull().default(0),
    refundsMinor: integer("refunds_minor").notNull().default(0),
    royaltiesMinor: integer("royalties_minor").notNull().default(0),
    payoutMinor: integer("payout_minor").notNull().default(0),
    status: text("status").notNull().default("draft"),
    generatedAt: text("generated_at").notNull(),
  },
  (t) => [uniqueIndex("idx_statements_period").on(t.publisherAccountId, t.periodStart, t.periodEnd, t.currency)],
);

// Commercial recommendation platform. Personal reading data remains separate from public catalog features.
export const recommendationPrivacy = sqliteTable("recommendation_privacy", {
  userId: text("user_id").primaryKey(), personalizationEnabled: integer("personalization_enabled").notNull().default(1),
  activityPersonalizationEnabled: integer("activity_personalization_enabled").notNull().default(1), personalizedSearchEnabled: integer("personalized_search_enabled").notNull().default(1),
  consentVersion: text("consent_version").notNull().default("2026-09"), updatedAt: text("updated_at").notNull(),
});
export const recommendationEvents = sqliteTable("recommendation_events", {
  id:text("id").primaryKey(), userId:text("user_id"), visitorId:text("visitor_id"), sessionId:text("session_id"), productId:text("product_id").notNull().references(()=>products.id,{onDelete:"cascade"}),
  eventType:text("event_type").notNull(), sourceSurface:text("source_surface").notNull().default(""), recommendationRequestId:text("recommendation_request_id"), position:integer("position"), value:real("value"), metadataJson:text("metadata_json").notNull().default("{}"), occurredAt:text("occurred_at").notNull(), eventKey:text("event_key"),
},t=>[index("idx_rec_events_user_time").on(t.userId,t.occurredAt),index("idx_rec_events_product_time").on(t.productId,t.occurredAt),uniqueIndex("idx_rec_events_event_key").on(t.eventKey)]);
export const recommendationUserFeatures = sqliteTable("recommendation_user_features", {
  userId:text("user_id").notNull(), featureType:text("feature_type").notNull(), featureKey:text("feature_key").notNull(), score:real("score").notNull().default(0), positiveEvents:integer("positive_events").notNull().default(0), negativeEvents:integer("negative_events").notNull().default(0), lastEventAt:text("last_event_at"), modelVersion:text("model_version").notNull(), updatedAt:text("updated_at").notNull(),
},t=>[primaryKey({columns:[t.userId,t.featureType,t.featureKey]}),index("idx_rec_user_features_score").on(t.userId,t.featureType,t.score)]);
export const recommendationItemNeighbors = sqliteTable("recommendation_item_neighbors", {
  productId:text("product_id").notNull().references(()=>products.id,{onDelete:"cascade"}), neighborProductId:text("neighbor_product_id").notNull().references(()=>products.id,{onDelete:"cascade"}), strategy:text("strategy").notNull(), score:real("score").notNull(), reasonJson:text("reason_json").notNull().default("{}"), modelVersion:text("model_version").notNull(), updatedAt:text("updated_at").notNull(),
},t=>[primaryKey({columns:[t.productId,t.neighborProductId,t.strategy]}),index("idx_rec_neighbors_lookup").on(t.productId,t.strategy,t.score)]);
export const recommendationItemMetrics = sqliteTable("recommendation_item_metrics", { productId:text("product_id").primaryKey().references(()=>products.id,{onDelete:"cascade"}), views7d:integer("views_7d").notNull().default(0), clicks7d:integer("clicks_7d").notNull().default(0), libraryAdds30d:integer("library_adds_30d").notNull().default(0), completions90d:integer("completions_90d").notNull().default(0), wishlists:integer("wishlists").notNull().default(0), averageRating:real("average_rating").notNull().default(0), ratingCount:integer("rating_count").notNull().default(0), popularityScore:real("popularity_score").notNull().default(0), trendScore:real("trend_score").notNull().default(0), updatedAt:text("updated_at").notNull() });
export const recommendationModels = sqliteTable("recommendation_models", { id:text("id").primaryKey(), modelKey:text("model_key").notNull(), version:text("version").notNull(), status:text("status").notNull(), algorithm:text("algorithm").notNull(), configJson:text("config_json").notNull().default("{}"), trainedAt:text("trained_at"), activatedAt:text("activated_at"), createdAt:text("created_at").notNull() },t=>[uniqueIndex("idx_rec_models_key_version").on(t.modelKey,t.version)]);
export const recommendationRequests = sqliteTable("recommendation_requests", { id:text("id").primaryKey(),userId:text("user_id"),visitorId:text("visitor_id"),surface:text("surface").notNull(),anchorProductId:text("anchor_product_id").references(()=>products.id,{onDelete:"set null"}),modelKey:text("model_key").notNull(),modelVersion:text("model_version").notNull(),experimentId:text("experiment_id"),experimentVariant:text("experiment_variant"),algorithm:text("algorithm").notNull(),consentMode:text("consent_mode").notNull(),territoryCode:text("territory_code").notNull(),contextJson:text("context_json").notNull().default("{}"),candidateCount:integer("candidate_count").notNull().default(0),latencyMs:integer("latency_ms").notNull().default(0),scorerMode:text("scorer_mode").notNull().default("local"),fallbackReason:text("fallback_reason").notNull().default(""),createdAt:text("created_at").notNull() });
export const recommendationImpressions = sqliteTable("recommendation_impressions", { requestId:text("request_id").notNull().references(()=>recommendationRequests.id,{onDelete:"cascade"}),productId:text("product_id").notNull().references(()=>products.id,{onDelete:"cascade"}),position:integer("position").notNull(),score:real("score").notNull(),reasonCode:text("reason_code").notNull(),reasonText:text("reason_text").notNull(),candidateSourcesJson:text("candidate_sources_json").notNull().default("[]"),impressedAt:text("impressed_at"),clickedAt:text("clicked_at") },t=>[primaryKey({columns:[t.requestId,t.productId]})]);
export const recommendationFeedback = sqliteTable("recommendation_feedback", { userId:text("user_id").notNull(),entityType:text("entity_type").notNull(),entityId:text("entity_id").notNull(),action:text("action").notNull(),reason:text("reason").notNull().default(""),createdAt:text("created_at").notNull(),updatedAt:text("updated_at").notNull() },t=>[primaryKey({columns:[t.userId,t.entityType,t.entityId,t.action]})]);
export const authorFollows = sqliteTable("author_follows", { userId:text("user_id").notNull(),contributorId:text("contributor_id").notNull().references(()=>contributors.id,{onDelete:"cascade"}),createdAt:text("created_at").notNull() },t=>[primaryKey({columns:[t.userId,t.contributorId]})]);
export const wishlistItems = sqliteTable("wishlist_items", { userId:text("user_id").notNull(),productId:text("product_id").notNull().references(()=>products.id,{onDelete:"cascade"}),addedAt:text("added_at").notNull(),baselinePriceMinor:integer("baseline_price_minor"),lastSeenPriceMinor:integer("last_seen_price_minor"),lastNotifiedPriceMinor:integer("last_notified_price_minor") },t=>[primaryKey({columns:[t.userId,t.productId]}),index("idx_wishlist_user_time").on(t.userId,t.addedAt)]);
export const recommendationExperiments = sqliteTable("recommendation_experiments", { id:text("id").primaryKey(),experimentKey:text("experiment_key").notNull().unique(),surface:text("surface").notNull(),status:text("status").notNull().default("draft"),variantsJson:text("variants_json").notNull().default('[{"key":"control","weight":100}]'),startsAt:text("starts_at"),endsAt:text("ends_at"),createdAt:text("created_at").notNull(),updatedAt:text("updated_at").notNull() },t=>[index("idx_rec_experiments_surface").on(t.surface,t.status,t.startsAt,t.endsAt)]);
export const recommendationCache = sqliteTable("recommendation_cache", { cacheKey:text("cache_key").primaryKey(),payloadJson:text("payload_json").notNull(),modelVersion:text("model_version").notNull(),expiresAt:text("expires_at").notNull(),createdAt:text("created_at").notNull() },t=>[index("idx_rec_cache_expiry").on(t.expiresAt)]);
export const recommendationJobs = sqliteTable("recommendation_jobs", { id:text("id").primaryKey(),jobType:text("job_type").notNull(),entityId:text("entity_id"),status:text("status").notNull().default("pending"),attempts:integer("attempts").notNull().default(0),maxAttempts:integer("max_attempts").notNull().default(5),lastError:text("last_error").notNull().default(""),queuedAt:text("queued_at").notNull(),availableAt:text("available_at").notNull(),startedAt:text("started_at"),lockedAt:text("locked_at"),leaseUntil:text("lease_until"),finishedAt:text("finished_at") },t=>[index("idx_rec_jobs_queue").on(t.status,t.availableAt,t.queuedAt),index("idx_rec_jobs_entity").on(t.jobType,t.entityId,t.status)]);
export const recommendationModelEvaluations = sqliteTable("recommendation_model_evaluations", { id:text("id").primaryKey(),modelKey:text("model_key").notNull(),modelVersion:text("model_version").notNull(),surface:text("surface").notNull(),windowDays:integer("window_days").notNull(),requests:integer("requests").notNull().default(0),visibleImpressions:integer("visible_impressions").notNull().default(0),clicks:integer("clicks").notNull().default(0),uniqueProducts:integer("unique_products").notNull().default(0),catalogProducts:integer("catalog_products").notNull().default(0),ctr:real("ctr").notNull().default(0),catalogCoverage:real("catalog_coverage").notNull().default(0),meanPositionClicked:real("mean_position_clicked"),sourceEntropy:real("source_entropy").notNull().default(0),generatedAt:text("generated_at").notNull() },t=>[uniqueIndex("idx_rec_model_eval_unique").on(t.modelKey,t.modelVersion,t.surface,t.windowDays),index("idx_rec_model_eval_lookup").on(t.modelKey,t.modelVersion,t.surface,t.generatedAt)]);
export const recommendationModelAudit = sqliteTable("recommendation_model_audit", { id:text("id").primaryKey(),modelKey:text("model_key").notNull(),version:text("version").notNull(),action:text("action").notNull(),previousStatus:text("previous_status"),nextStatus:text("next_status").notNull(),configJson:text("config_json").notNull().default("{}"),createdAt:text("created_at").notNull() },t=>[index("idx_rec_model_audit_time").on(t.createdAt)]);

// Commercial product-detail, preview and wishlist/commerce primitives.
export const productRankings = sqliteTable("product_rankings", {
  productId:text("product_id").notNull().references(()=>products.id,{onDelete:"cascade"}), rankingScope:text("ranking_scope").notNull(), rankingKey:text("ranking_key").notNull().default(""), rank:integer("rank").notNull(), score:real("score").notNull().default(0), window:text("window").notNull().default("current"), updatedAt:text("updated_at").notNull(),
},t=>[primaryKey({columns:[t.productId,t.rankingScope,t.rankingKey,t.window]}),index("idx_product_rankings_lookup").on(t.rankingScope,t.rankingKey,t.window,t.rank)]);
export const previewPolicies = sqliteTable("preview_policies", { editionId:text("edition_id").primaryKey().references(()=>editions.id,{onDelete:"cascade"}), enabled:integer("enabled").notNull().default(1), mode:text("mode").notNull().default("percent"), limitValue:integer("limit_value").notNull().default(10), maxPercentage:integer("max_percentage").notNull().default(20), version:integer("version").notNull().default(1), startsAt:text("starts_at"), endsAt:text("ends_at"), updatedBy:text("updated_by").notNull().default("system"), createdAt:text("created_at").notNull(), updatedAt:text("updated_at").notNull() });
export const previewDerivatives = sqliteTable("preview_derivatives", { id:text("id").primaryKey(), productId:text("product_id").notNull().references(()=>products.id,{onDelete:"cascade"}), assetVersionId:text("asset_version_id").notNull().references(()=>assetVersions.id,{onDelete:"cascade"}), policyVersion:integer("policy_version").notNull(), objectKey:text("object_key").notNull(), spineItems:integer("spine_items").notNull().default(0), sizeBytes:integer("size_bytes"), sha256:text("sha256"), createdAt:text("created_at").notNull() },t=>[uniqueIndex("idx_preview_derivative_unique").on(t.productId,t.assetVersionId,t.policyVersion),index("idx_preview_derivatives_product").on(t.productId,t.createdAt)]);
export const previewStates = sqliteTable("preview_states", { userId:text("user_id").notNull(), productId:text("product_id").notNull().references(()=>products.id,{onDelete:"cascade"}), cfi:text("cfi").notNull().default(""), sampleProgress:real("sample_progress").notNull().default(0), startedAt:text("started_at").notNull(), updatedAt:text("updated_at").notNull(), convertedAt:text("converted_at") },t=>[primaryKey({columns:[t.userId,t.productId]})]);
export const wishlistProfiles = sqliteTable("wishlist_profiles", { userId:text("user_id").primaryKey(), shareEnabled:integer("share_enabled").notNull().default(0), shareToken:text("share_token"), title:text("title").notNull().default("My wishlist"), createdAt:text("created_at").notNull(), updatedAt:text("updated_at").notNull() },t=>[uniqueIndex("idx_wishlist_profiles_share_token").on(t.shareToken)]);
export const wishlistEvents = sqliteTable("wishlist_events", { id:text("id").primaryKey(), userId:text("user_id").notNull(), productId:text("product_id").notNull().references(()=>products.id,{onDelete:"cascade"}), eventType:text("event_type").notNull(), sourceSurface:text("source_surface").notNull().default(""), sourceRequestId:text("source_request_id"), metadataJson:text("metadata_json").notNull().default("{}"), createdAt:text("created_at").notNull() },t=>[index("idx_wishlist_events_user").on(t.userId,t.createdAt),index("idx_wishlist_events_product").on(t.productId,t.eventType,t.createdAt)]);
export const commerceNotifications = sqliteTable("commerce_notifications", { id:text("id").primaryKey(), userId:text("user_id").notNull(), productId:text("product_id").references(()=>products.id,{onDelete:"cascade"}), notificationType:text("notification_type").notNull(), dedupeKey:text("dedupe_key").notNull(), title:text("title").notNull(), body:text("body").notNull(), payloadJson:text("payload_json").notNull().default("{}"), readAt:text("read_at"), createdAt:text("created_at").notNull() },t=>[uniqueIndex("idx_commerce_notifications_dedupe").on(t.userId,t.dedupeKey),index("idx_commerce_notifications_user").on(t.userId,t.readAt,t.createdAt)]);
export const shoppingCarts = sqliteTable("shopping_carts", { id:text("id").primaryKey(), userId:text("user_id").notNull().unique(), currency:text("currency"), createdAt:text("created_at").notNull(), updatedAt:text("updated_at").notNull() });
export const shoppingCartItems = sqliteTable("shopping_cart_items", { cartId:text("cart_id").notNull().references(()=>shoppingCarts.id,{onDelete:"cascade"}), productId:text("product_id").notNull().references(()=>products.id,{onDelete:"cascade"}), offerId:text("offer_id"), quantity:integer("quantity").notNull().default(1), priceSnapshotMinor:integer("price_snapshot_minor"), currency:text("currency"), sourceSurface:text("source_surface").notNull().default(""), sourceRequestId:text("source_request_id"), addedAt:text("added_at").notNull(), updatedAt:text("updated_at").notNull() },t=>[primaryKey({columns:[t.cartId,t.productId]}),index("idx_cart_items_product").on(t.productId)]);

// Stripe-backed commercial commerce. Stripe processes card/payment methods; Cove owns orders and accounting.
export const commerceCustomers = sqliteTable("commerce_customers", { userId:text("user_id").primaryKey(), stripeCustomerId:text("stripe_customer_id").unique(), email:text("email").notNull().default(""), createdAt:text("created_at").notNull(), updatedAt:text("updated_at").notNull() });
export const commerceCheckoutQuotes = sqliteTable("commerce_checkout_quotes", { id:text("id").primaryKey(), userId:text("user_id").notNull(), cartId:text("cart_id").notNull().references(()=>shoppingCarts.id,{onDelete:"cascade"}), cartFingerprint:text("cart_fingerprint").notNull(), territoryCode:text("territory_code").notNull(), currency:text("currency").notNull(), itemsJson:text("items_json").notNull(), billingAddressJson:text("billing_address_json").notNull(), subtotalMinor:integer("subtotal_minor").notNull(), promoDiscountMinor:integer("promo_discount_minor").notNull().default(0), taxMinor:integer("tax_minor").notNull().default(0), taxInclusiveMinor:integer("tax_inclusive_minor").notNull().default(0), giftCardMinor:integer("gift_card_minor").notNull().default(0), storeCreditMinor:integer("store_credit_minor").notNull().default(0), totalMinor:integer("total_minor").notNull(), stripeDueMinor:integer("stripe_due_minor").notNull(), promoCodeHash:text("promo_code_hash"), giftCardHash:text("gift_card_hash"), stripeTaxCalculationId:text("stripe_tax_calculation_id"), taxBreakdownJson:text("tax_breakdown_json").notNull().default("[]"), expiresAt:text("expires_at").notNull(), consumedAt:text("consumed_at"), createdAt:text("created_at").notNull() },t=>[index("idx_checkout_quotes_user").on(t.userId,t.createdAt),index("idx_checkout_quotes_expiry").on(t.expiresAt,t.consumedAt)]);
export const commerceOrders = sqliteTable("commerce_orders", { id:text("id").primaryKey(), userId:text("user_id").notNull(), quoteId:text("quote_id").references(()=>commerceCheckoutQuotes.id,{onDelete:"set null"}), invoiceNumber:text("invoice_number").notNull().unique(), status:text("status").notNull(), currency:text("currency").notNull(), territoryCode:text("territory_code").notNull(), subtotalMinor:integer("subtotal_minor").notNull(), promoDiscountMinor:integer("promo_discount_minor").notNull().default(0), taxMinor:integer("tax_minor").notNull().default(0), taxInclusiveMinor:integer("tax_inclusive_minor").notNull().default(0), giftCardMinor:integer("gift_card_minor").notNull().default(0), storeCreditMinor:integer("store_credit_minor").notNull().default(0), totalMinor:integer("total_minor").notNull(), stripeDueMinor:integer("stripe_due_minor").notNull(), refundedMinor:integer("refunded_minor").notNull().default(0), billingAddressJson:text("billing_address_json").notNull(), stripeCustomerId:text("stripe_customer_id"), stripePaymentIntentId:text("stripe_payment_intent_id").unique(), stripeChargeId:text("stripe_charge_id"), stripeTaxCalculationId:text("stripe_tax_calculation_id"), stripeTaxTransactionId:text("stripe_tax_transaction_id"), receiptUrl:text("receipt_url"), paymentMethodSummary:text("payment_method_summary").notNull().default(""), riskLevel:text("risk_level"), riskScore:integer("risk_score"), captureMethod:text("capture_method").notNull().default("automatic_async"), idempotencyKey:text("idempotency_key").notNull().unique(), failureCode:text("failure_code"), failureMessage:text("failure_message"), createdAt:text("created_at").notNull(), updatedAt:text("updated_at").notNull(), authorizedAt:text("authorized_at"), paidAt:text("paid_at"), canceledAt:text("canceled_at") },t=>[index("idx_commerce_orders_user").on(t.userId,t.createdAt),uniqueIndex("idx_commerce_orders_quote_unique").on(t.quoteId),index("idx_commerce_orders_status").on(t.status,t.updatedAt)]);
export const commerceOrderItems = sqliteTable("commerce_order_items", { id:text("id").primaryKey(), orderId:text("order_id").notNull().references(()=>commerceOrders.id,{onDelete:"restrict"}), productId:text("product_id").notNull().references(()=>products.id,{onDelete:"restrict"}), offerId:text("offer_id"), titleSnapshot:text("title_snapshot").notNull(), skuSnapshot:text("sku_snapshot").notNull(), unitAmountMinor:integer("unit_amount_minor").notNull(), discountMinor:integer("discount_minor").notNull().default(0), taxMinor:integer("tax_minor").notNull().default(0), totalMinor:integer("total_minor").notNull(), sourceSurface:text("source_surface").notNull().default(""), sourceRequestId:text("source_request_id"), entitlementStatus:text("entitlement_status").notNull().default("pending"), pricingDecisionId:text("pricing_decision_id"), royaltyContractVersionId:text("royalty_contract_version_id"), rightsDecisionId:text("rights_decision_id"), rightsGrantId:text("rights_grant_id"), rightsSnapshotJson:text("rights_snapshot_json").notNull().default("{}"), recognizedRevenueMinor:integer("recognized_revenue_minor").notNull().default(0), createdAt:text("created_at").notNull() },t=>[index("idx_order_items_order").on(t.orderId),index("idx_order_items_product").on(t.productId,t.createdAt)]);
export const commerceLedgerEntries = sqliteTable("commerce_ledger_entries", { id:text("id").primaryKey(), orderId:text("order_id").references(()=>commerceOrders.id,{onDelete:"restrict"}), refundId:text("refund_id"), userId:text("user_id"), entryType:text("entry_type").notNull(), accountCode:text("account_code").notNull(), amountMinor:integer("amount_minor").notNull(), currency:text("currency").notNull(), externalReference:text("external_reference").notNull().default(""), metadataJson:text("metadata_json").notNull().default("{}"), createdAt:text("created_at").notNull() },t=>[index("idx_commerce_ledger_order").on(t.orderId,t.createdAt),index("idx_commerce_ledger_account").on(t.accountCode,t.currency,t.createdAt),uniqueIndex("idx_commerce_ledger_idempotent").on(t.orderId,t.entryType,t.accountCode,t.externalReference)]);
export const commercePaymentAttempts = sqliteTable("commerce_payment_attempts", { id:text("id").primaryKey(), orderId:text("order_id").notNull().references(()=>commerceOrders.id,{onDelete:"cascade"}), provider:text("provider").notNull().default("stripe"), providerPaymentId:text("provider_payment_id"), status:text("status").notNull(), amountMinor:integer("amount_minor").notNull(), currency:text("currency").notNull(), failureCode:text("failure_code"), failureMessage:text("failure_message"), providerPayloadJson:text("provider_payload_json").notNull().default("{}"), createdAt:text("created_at").notNull(), updatedAt:text("updated_at").notNull() },t=>[index("idx_payment_attempts_order").on(t.orderId,t.createdAt)]);
export const commercePromoCodes = sqliteTable("commerce_promo_codes", { codeHash:text("code_hash").primaryKey(), codeLabel:text("code_label").notNull(), kind:text("kind").notNull(), value:integer("value").notNull(), currency:text("currency"), minimumSubtotalMinor:integer("minimum_subtotal_minor").notNull().default(0), maxRedemptions:integer("max_redemptions"), maxPerUser:integer("max_per_user").notNull().default(1), redemptions:integer("redemptions").notNull().default(0), active:integer("active").notNull().default(1), startsAt:text("starts_at"), endsAt:text("ends_at"), createdAt:text("created_at").notNull(), updatedAt:text("updated_at").notNull() });
export const commercePromoRedemptions = sqliteTable("commerce_promo_redemptions", { id:text("id").primaryKey(), codeHash:text("code_hash").notNull().references(()=>commercePromoCodes.codeHash,{onDelete:"restrict"}), userId:text("user_id").notNull(), orderId:text("order_id").references(()=>commerceOrders.id,{onDelete:"set null"}), quoteId:text("quote_id"), amountMinor:integer("amount_minor").notNull(), status:text("status").notNull(), createdAt:text("created_at").notNull(), updatedAt:text("updated_at").notNull() },t=>[index("idx_promo_redemptions_code").on(t.codeHash,t.status),index("idx_promo_redemptions_user").on(t.userId,t.codeHash,t.status)]);
export const commerceGiftCards = sqliteTable("commerce_gift_cards", { codeHash:text("code_hash").primaryKey(), last4:text("last4").notNull(), currency:text("currency").notNull(), originalBalanceMinor:integer("original_balance_minor").notNull(), balanceMinor:integer("balance_minor").notNull(), status:text("status").notNull().default("active"), expiresAt:text("expires_at"), issuedBy:text("issued_by").notNull().default("operator"), createdAt:text("created_at").notNull(), updatedAt:text("updated_at").notNull() });
export const commerceGiftCardLedger = sqliteTable("commerce_gift_card_ledger", { id:text("id").primaryKey(), codeHash:text("code_hash").notNull().references(()=>commerceGiftCards.codeHash,{onDelete:"restrict"}), orderId:text("order_id").references(()=>commerceOrders.id,{onDelete:"set null"}), entryType:text("entry_type").notNull(), amountMinor:integer("amount_minor").notNull(), balanceAfterMinor:integer("balance_after_minor").notNull(), createdAt:text("created_at").notNull() },t=>[index("idx_gift_card_ledger_card").on(t.codeHash,t.createdAt)]);
export const commerceStoreCreditLedger = sqliteTable("commerce_store_credit_ledger", { id:text("id").primaryKey(), userId:text("user_id").notNull(), orderId:text("order_id").references(()=>commerceOrders.id,{onDelete:"set null"}), entryType:text("entry_type").notNull(), amountMinor:integer("amount_minor").notNull(), currency:text("currency").notNull(), reference:text("reference").notNull().default(""), createdAt:text("created_at").notNull() },t=>[index("idx_store_credit_user").on(t.userId,t.currency,t.createdAt)]);
export const commerceBalanceReservations = sqliteTable("commerce_balance_reservations", { id:text("id").primaryKey(), userId:text("user_id").notNull(), orderId:text("order_id").notNull().references(()=>commerceOrders.id,{onDelete:"cascade"}), sourceType:text("source_type").notNull(), sourceKey:text("source_key").notNull(), amountMinor:integer("amount_minor").notNull(), currency:text("currency").notNull(), status:text("status").notNull().default("reserved"), expiresAt:text("expires_at").notNull(), createdAt:text("created_at").notNull(), updatedAt:text("updated_at").notNull() },t=>[index("idx_balance_reservations_source").on(t.sourceType,t.sourceKey,t.status,t.expiresAt)]);
export const commerceRefunds = sqliteTable("commerce_refunds", { id:text("id").primaryKey(), orderId:text("order_id").notNull().references(()=>commerceOrders.id,{onDelete:"restrict"}), providerRefundId:text("provider_refund_id").unique(), amountMinor:integer("amount_minor").notNull(), stripeAmountMinor:integer("stripe_amount_minor").notNull().default(0), giftCardAmountMinor:integer("gift_card_amount_minor").notNull().default(0), storeCreditAmountMinor:integer("store_credit_amount_minor").notNull().default(0), currency:text("currency").notNull(), reason:text("reason").notNull().default(""), status:text("status").notNull(), taxReversalId:text("tax_reversal_id"), idempotencyKey:text("idempotency_key").notNull().unique(), createdAt:text("created_at").notNull(), updatedAt:text("updated_at").notNull(), succeededAt:text("succeeded_at") },t=>[index("idx_refunds_order").on(t.orderId,t.createdAt)]);
export const commerceDisputes = sqliteTable("commerce_disputes", { providerDisputeId:text("provider_dispute_id").primaryKey(), orderId:text("order_id").references(()=>commerceOrders.id,{onDelete:"set null"}), chargeId:text("charge_id").notNull(), amountMinor:integer("amount_minor").notNull(), currency:text("currency").notNull(), reason:text("reason").notNull().default(""), status:text("status").notNull(), evidenceDueAt:text("evidence_due_at"), createdAt:text("created_at").notNull(), updatedAt:text("updated_at").notNull(), closedAt:text("closed_at") },t=>[index("idx_disputes_order").on(t.orderId,t.updatedAt)]);
export const commerceWebhookEvents = sqliteTable("commerce_webhook_events", { providerEventId:text("provider_event_id").primaryKey(), eventType:text("event_type").notNull(), livemode:integer("livemode").notNull().default(0), payloadSha256:text("payload_sha256").notNull(), status:text("status").notNull().default("received"), error:text("error"), receivedAt:text("received_at").notNull(), processedAt:text("processed_at") },t=>[index("idx_webhook_events_status").on(t.status,t.receivedAt)]);
export const commerceReconciliationRuns = sqliteTable("commerce_reconciliation_runs", { id:text("id").primaryKey(), startedAt:text("started_at").notNull(), finishedAt:text("finished_at"), status:text("status").notNull(), checkedOrders:integer("checked_orders").notNull().default(0), mismatches:integer("mismatches").notNull().default(0), repaired:integer("repaired").notNull().default(0), detailsJson:text("details_json").notNull().default("[]") },t=>[index("idx_reconciliation_runs").on(t.startedAt)]);

// Commercial pricing / multi-party finance (migration 0013)
export const pricingPolicies = sqliteTable("pricing_policies", { id:text("id").primaryKey(), name:text("name").notNull(), status:text("status").notNull(), baseCurrency:text("base_currency").notNull(), roundingRule:text("rounding_rule").notNull(), fxMarkupBps:integer("fx_markup_bps").notNull().default(0), createdAt:text("created_at").notNull(), updatedAt:text("updated_at").notNull() });
export const pricingRegionRules = sqliteTable("pricing_region_rules", { id:text("id").primaryKey(), policyId:text("policy_id").notNull().references(()=>pricingPolicies.id,{onDelete:"cascade"}), territoryCode:text("territory_code").notNull(), currency:text("currency").notNull(), floorMinor:integer("floor_minor"), ceilingMinor:integer("ceiling_minor"), taxInclusive:integer("tax_inclusive").notNull().default(0), fxSource:text("fx_source").notNull().default("manual"), active:integer("active").notNull().default(1), createdAt:text("created_at").notNull(), updatedAt:text("updated_at").notNull() });
export const fxRates = sqliteTable("fx_rates", { id:text("id").primaryKey(), baseCurrency:text("base_currency").notNull(), quoteCurrency:text("quote_currency").notNull(), ratePpm:integer("rate_ppm").notNull(), source:text("source").notNull(), effectiveAt:text("effective_at").notNull(), expiresAt:text("expires_at"), createdAt:text("created_at").notNull() });
export const pricingDecisions = sqliteTable("pricing_decisions", { id:text("id").primaryKey(), productId:text("product_id").notNull().references(()=>products.id,{onDelete:"restrict"}), offerId:text("offer_id").notNull().references(()=>offers.id,{onDelete:"restrict"}), territoryCode:text("territory_code").notNull(), currency:text("currency").notNull(), baseAmountMinor:integer("base_amount_minor").notNull(), scheduledAmountMinor:integer("scheduled_amount_minor").notNull(), promotionAmountMinor:integer("promotion_amount_minor").notNull().default(0), promotionId:text("promotion_id"), effectiveAmountMinor:integer("effective_amount_minor").notNull(), floorMinor:integer("floor_minor"), fxRatePpm:integer("fx_rate_ppm"), fxSource:text("fx_source"), preorderGuaranteeApplied:integer("preorder_guarantee_applied").notNull().default(0), ruleTraceJson:text("rule_trace_json").notNull().default("[]"), validUntil:text("valid_until"), createdAt:text("created_at").notNull() });
export const financeParties = sqliteTable("finance_parties", { id:text("id").primaryKey(), partyType:text("party_type").notNull(), displayName:text("display_name").notNull(), publisherId:text("publisher_id"), contributorId:text("contributor_id"), taxCountry:text("tax_country"), withholdingBps:integer("withholding_bps").notNull().default(0), payoutCurrency:text("payout_currency").notNull().default("USD"), status:text("status").notNull().default("active"), createdAt:text("created_at").notNull(), updatedAt:text("updated_at").notNull() });
export const financeRoyaltyContracts = sqliteTable("finance_royalty_contracts", { id:text("id").primaryKey(), name:text("name").notNull(), publisherId:text("publisher_id"), productId:text("product_id"), editionId:text("edition_id"), territoryCode:text("territory_code"), format:text("format"), salesChannel:text("sales_channel").notNull().default("retail"), effectiveFrom:text("effective_from").notNull(), effectiveTo:text("effective_to"), status:text("status").notNull().default("active"), createdAt:text("created_at").notNull(), updatedAt:text("updated_at").notNull() });
export const financeRoyaltyContractVersions = sqliteTable("finance_royalty_contract_versions", { id:text("id").primaryKey(), contractId:text("contract_id").notNull().references(()=>financeRoyaltyContracts.id,{onDelete:"cascade"}), version:integer("version").notNull(), calculationBasis:text("calculation_basis").notNull(), foreCommissionBps:integer("fore_commission_bps").notNull(), paymentTermsDays:integer("payment_terms_days").notNull(), reserveBps:integer("reserve_bps").notNull(), effectiveFrom:text("effective_from").notNull(), createdAt:text("created_at").notNull() });
export const financeRoyaltyEvents = sqliteTable("finance_royalty_events", { id:text("id").primaryKey(), orderId:text("order_id").notNull(), orderItemId:text("order_item_id").notNull(), refundId:text("refund_id"), contractVersionId:text("contract_version_id").notNull(), partyId:text("party_id").notNull(), eventType:text("event_type").notNull(), basisMinor:integer("basis_minor").notNull(), royaltyMinor:integer("royalty_minor").notNull(), withholdingMinor:integer("withholding_minor").notNull().default(0), reserveMinor:integer("reserve_minor").notNull().default(0), payableMinor:integer("payable_minor").notNull(), currency:text("currency").notNull(), status:text("status").notNull(), availableAt:text("available_at").notNull(), externalReference:text("external_reference").notNull().default(""), createdAt:text("created_at").notNull() });
export const payoutBatches = sqliteTable("payout_batches", { id:text("id").primaryKey(), currency:text("currency").notNull(), periodStart:text("period_start").notNull(), periodEnd:text("period_end").notNull(), status:text("status").notNull(), grossMinor:integer("gross_minor").notNull().default(0), withholdingMinor:integer("withholding_minor").notNull().default(0), netMinor:integer("net_minor").notNull().default(0), createdAt:text("created_at").notNull(), approvedAt:text("approved_at"), paidAt:text("paid_at") });
