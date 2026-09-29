import type { CatalogBook } from "./client";
import { canonicalBooksByProductIds, type CatalogDB } from "./catalog-model.server";
import { ApiError } from "./service";
import { normalizeTerritoryCode } from "./rights.server";
import { personalizeSearchBooks, personalizedSearchEnabled } from "./recommendations.server";

type SearchEnv = {
  DB: CatalogDB;
  FORE_SEARCH_BACKEND?: string;
  FORE_SEARCH_URL?: string;
  FORE_SEARCH_SEARCH_KEY?: string;
  FORE_SEARCH_ADMIN_KEY?: string;
  FORE_SEARCH_INDEX?: string;
  FORE_SEARCH_EMBEDDER?: string;
};

type FacetValue = { value: string; count: number };
export type SearchFacets = {
  categories: FacetValue[];
  languages: FacetValue[];
  formats: FacetValue[];
  publishers: FacetValue[];
  series: FacetValue[];
  availability: FacetValue[];
  price: { currency: string; min: number; max: number } | null;
};
export type SearchInput = {
  query: string;
  topic?: string;
  taxonomy: string[];
  categories: string[];
  subjects: string[];
  languages: string[];
  formats: string[];
  publishers: string[];
  series: string[];
  contributorIds: string[];
  seriesIds: string[];
  publisherIds: string[];
  imprintIds: string[];
  currency?: string;
  minPrice?: number;
  maxPrice?: number;
  subscription?: boolean;
  library?: boolean;
  minRating?: number;
  minReviews?: number;
  publishedAfter?: string;
  publishedBefore?: string;
  preorder?: boolean;
  newRelease?: boolean;
  deals?: boolean;
  availability?: string;
  territory: string;
  sort: string;
  page: number;
  limit: number;
};
export type SearchResult = {
  books: CatalogBook[];
  count: number;
  facets: SearchFacets;
  queryId: string | null;
  backend: "meilisearch" | "d1-fts5";
  processingTimeMs: number;
  correctedQuery?: string;
  limit: number;
  personalizationApplied?: boolean;
};

type SearchDocument = {
  id: string;
  externalBookId: string;
  publicProductId: string;
  title: string;
  subtitle: string;
  authors: string[];
  contributors: string[];
  contributorIds: string[];
  series: string[];
  seriesIds: string[];
  publisher: string;
  publisherId: string;
  imprint: string;
  imprintId: string;
  isbn13: string;
  categories: string[];
  subjects: string[];
  languages: string[];
  keywords: string[];
  description: string;
  format: string;
  currency: string;
  priceMinor: number;
  subscriptionEligible: boolean;
  libraryEligible: boolean;
  averageRating: number;
  reviewCount: number;
  releaseTimestamp: number;
  publicationTimestamp: number;
  preorderTimestamp: number;
  comingSoonTimestamp: number;
  firstIngestedTimestamp: number;
  updatedTimestamp: number;
  taxonomyPaths: string[];
  preorder: boolean;
  deal: boolean;
  popularityScore: number;
  salesVelocity: number;
  readScore: number;
  wishlistScore: number;
  ratingScore: number;
  noteworthyScore: number;
  availability: string;
  territories: string[];
  merchandisingBoost: number;
  sourceName: string;
  storefrontStatus: string;
  suppressed: boolean;
  titleSort: string;
};

const SEARCH_SETTINGS_VERSION = 9;
const DEFAULT_INDEX = "fore_books";
const DAY = 86_400_000;
let synonymCache: { expires: number; values: Map<string, string[]> } | null = null;

function cleanText(value: string, max = 160) {
  return value.normalize("NFKC").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}
function uniq(values: string[], max = 20) {
  return [...new Set(values.map((x) => cleanText(String(x), 180)).filter(Boolean))].slice(0, max);
}
function parseJsonArray(value: unknown): string[] {
  try {
    const parsed = JSON.parse(String(value ?? "[]"));
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}
function timestamp(value: unknown) {
  const ms = Date.parse(String(value || ""));
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : 0;
}
function meiliConfigured(env: SearchEnv) {
  return !!(env.FORE_SEARCH_URL && (env.FORE_SEARCH_SEARCH_KEY || env.FORE_SEARCH_ADMIN_KEY));
}
function preferredBackend(env: SearchEnv) {
  const configured = (env.FORE_SEARCH_BACKEND || "auto").toLowerCase();
  if (configured === "d1" || configured === "fts5") return "d1" as const;
  if (configured === "meilisearch" && !meiliConfigured(env)) throw new ApiError(503, "Commercial search is not configured.");
  return meiliConfigured(env) ? ("meilisearch" as const) : ("d1" as const);
}
function searchIndex(env: SearchEnv) {
  return cleanText(env.FORE_SEARCH_INDEX || DEFAULT_INDEX, 60).replace(/[^a-zA-Z0-9_-]/g, "_") || DEFAULT_INDEX;
}
function normalizeQuery(value: string) {
  return cleanText(value, 160).toLocaleLowerCase();
}
function queryTokens(value: string) {
  return normalizeQuery(value).match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu) || [];
}
function compactIdentifier(value: string) {
  return normalizeQuery(value).replace(/[\s-]/g, "");
}
function isbnLike(value: string) {
  return /^(?:\d{13}|\d{9}[\dXx])$/.test(compactIdentifier(value));
}
function meiliQueryText(query: string, topic?: string) {
  const normalized = isbnLike(query) ? compactIdentifier(query) : query;
  return [normalized, topic].filter(Boolean).join(" ").trim();
}
function quoteFts(value: string) {
  return `"${value.replace(/"/g, '""')}"`;
}
function booleanParam(value: string | null) {
  if (value === null || value === "") return undefined;
  if (value === "true" || value === "1") return true;
  if (value === "false" || value === "0") return false;
  throw new ApiError(400, "Invalid search filter.");
}
function numberParam(value: string | null, min: number, max: number) {
  if (value === null || value === "") return undefined;
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || n > max) throw new ApiError(400, "Invalid numeric search filter.");
  return n;
}
function listParam(params: URLSearchParams, key: string, max = 10) {
  const raw = [...params.getAll(key), ...(params.get(key)?.includes(",") ? String(params.get(key)).split(",") : [])];
  return uniq(raw, max);
}
function moneyParam(value: string | null) {
  if (value === null || value === "") return undefined;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > 100_000) throw new ApiError(400, "Invalid price search filter.");
  return Math.round(n * 100);
}
function dateParam(value: string | null) {
  if (value === null || value === "") return undefined;
  const cleaned = cleanText(value, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(cleaned) || !Number.isFinite(Date.parse(`${cleaned}T00:00:00Z`))) {
    throw new ApiError(400, "Invalid publication date filter.");
  }
  return cleaned;
}

export function parseSearchInput(url: URL): SearchInput {
  const p = url.searchParams;
  const legacyLanguage = cleanText(p.get("languages") || "", 20).toLowerCase();
  const languages = listParam(p, "language", 12).map((x) => x.toLowerCase());
  if (legacyLanguage && legacyLanguage !== "all" && !languages.includes(legacyLanguage)) languages.push(legacyLanguage);
  const taxonomy = listParam(p, "taxonomy", 8);
  const categories = listParam(p, "category", 12);
  const legacyTopic = cleanText(p.get("topic") || "", 100);
  const page = Number(p.get("page") || 1);
  const limit = Number(p.get("limit") || 24);
  if (!Number.isInteger(page) || page < 1 || page > 500) throw new ApiError(400, "Invalid catalog page.");
  if (!Number.isInteger(limit) || limit < 1 || limit > 60) throw new ApiError(400, "Invalid search page size.");
  const allowedSort = new Set(["relevance", "popular", "bestselling", "trending", "most_read", "most_wishlisted", "noteworthy", "newest", "released", "published", "added", "updated", "coming_soon", "descending", "ascending", "price_asc", "price_desc", "rating", "top_rated", "title"]);
  let sort = cleanText(p.get("sort") || "", 30).toLowerCase();
  if (!sort) sort = p.get("search") || p.get("q") ? "relevance" : "popular";
  if (!allowedSort.has(sort)) throw new ApiError(400, "Invalid search sort.");
  if (sort === "descending") sort = "added";
  if (sort === "ascending") sort = "title";
  if (sort === "newest") sort = "released";
  const preorder = booleanParam(p.get("preorder"));
  return {
    query: cleanText(p.get("q") || p.get("search") || "", 160),
    topic: legacyTopic || undefined,
    taxonomy,
    categories,
    languages,
    formats: listParam(p, "format", 6).map((x) => x.toLowerCase()),
    publishers: listParam(p, "publisher", 8),
    series: listParam(p, "series", 8),
    contributorIds: listParam(p, "authorId", 8),
    seriesIds: listParam(p, "seriesId", 8),
    publisherIds: listParam(p, "publisherId", 8),
    imprintIds: listParam(p, "imprintId", 8),
    currency: cleanText(p.get("currency") || "USD", 3).toUpperCase(),
    minPrice: moneyParam(p.get("minPrice")),
    maxPrice: moneyParam(p.get("maxPrice")),
    subscription: booleanParam(p.get("subscription")),
    library: booleanParam(p.get("library")),
    minRating: numberParam(p.get("minRating"), 0, 5),
    minReviews: numberParam(p.get("minReviews"), 0, 10_000_000),
    publishedAfter: dateParam(p.get("publishedAfter")),
    publishedBefore: dateParam(p.get("publishedBefore")),
    preorder,
    newRelease: booleanParam(p.get("newRelease")),
    deals: booleanParam(p.get("deals")),
    availability: cleanText(p.get("availability") || "available", 30).toLowerCase(),
    territory: normalizeTerritoryCode(cleanText(p.get("territory") || "US", 2)),
    sort,
    page,
    limit,
  };
}

async function synonyms(db: CatalogDB) {
  const now = Date.now();
  if (synonymCache && synonymCache.expires > now) return synonymCache.values;
  const rows = await db.prepare("SELECT term,synonyms_json FROM search_synonyms WHERE enabled=1").all<any>();
  const map = new Map<string, string[]>();
  for (const row of rows.results) map.set(normalizeQuery(row.term), uniq(parseJsonArray(row.synonyms_json), 12));
  synonymCache = { expires: now + 5 * 60_000, values: map };
  return map;
}

async function ftsExpression(db: CatalogDB, input: SearchInput, queryOverride?: string) {
  const query = queryOverride ?? input.query;
  const normalized = normalizeQuery(query);
  const compact = compactIdentifier(query);
  if (isbnLike(query)) return `isbn13 : ${quoteFts(compact)}`;
  if (/^(?:\d{1,9}|(?:pgca|pgau|pgeu)_[a-z0-9_]{1,100})$/.test(normalized)) return `external_book_id : ${quoteFts(normalized)}`;
  const tokenGroups = queryTokens(query);
  const syns = await synonyms(db);
  const groups = tokenGroups.map((token, i) => {
    const variants = [token, ...(syns.get(token) || [])].slice(0, 5);
    const isLast = i === tokenGroups.length - 1;
    return `(${variants.map((v) => `${quoteFts(v)}${isLast && !v.includes(" ") ? "*" : ""}`).join(" OR ")})`;
  });
  if (input.topic) groups.push(`categories_text : ${quoteFts(input.topic)}*`);
  return groups.join(" AND ");
}

function buildSqlFilters(input: SearchInput) {
  const where = [
    "p.storefront_status='active'",
    "p.source_name<>'upload'",
    "d.suppressed=0",
    "e.release_status IN ('available','preorder')",
  ];
  const binds: unknown[] = [];
  if (input.availability) {
    where.push("d.availability=?");
    binds.push(input.availability);
  }
  if (input.territory) {
    where.push(`EXISTS(SELECT 1 FROM retail_product_availability rpa WHERE rpa.product_id=p.id AND rpa.territory_code=upper(?))`);
    binds.push(input.territory);
  }
  if (input.taxonomy.length) {
    where.push(`EXISTS(SELECT 1 FROM edition_taxonomy_nodes et JOIN storefront_taxonomy_nodes tn ON tn.id=et.taxonomy_node_id WHERE et.edition_id=e.id AND tn.path IN (${input.taxonomy.map(() => "?").join(",")}))`);
    binds.push(...input.taxonomy);
  }
  if (input.languages.length) {
    where.push(`EXISTS(SELECT 1 FROM edition_languages el WHERE el.edition_id=e.id AND lower(el.language_code) IN (${input.languages.map(() => "?").join(",")}))`);
    binds.push(...input.languages.map((x) => x.toLowerCase()));
  }
  if (input.categories.length) {
    where.push(`EXISTS(SELECT 1 FROM edition_categories ec JOIN categories c ON c.id=ec.category_id WHERE ec.edition_id=e.id AND c.name IN (${input.categories.map(() => "?").join(",")}))`);
    binds.push(...input.categories);
  }
  if (input.formats.length) {
    where.push(`lower(p.format) IN (${input.formats.map(() => "?").join(",")})`);
    binds.push(...input.formats);
  }
  if (input.publishers.length) {
    where.push(`COALESCE(pub.name,'') IN (${input.publishers.map(() => "?").join(",")})`);
    binds.push(...input.publishers);
  }
  if (input.series.length) {
    where.push(`EXISTS(SELECT 1 FROM series_memberships sm JOIN series s ON s.id=sm.series_id WHERE sm.edition_id=e.id AND s.name IN (${input.series.map(() => "?").join(",")}))`);
    binds.push(...input.series);
  }
  if (input.contributorIds.length) {
    where.push(`EXISTS(SELECT 1 FROM edition_contributors ec WHERE ec.edition_id=e.id AND ec.contributor_id IN (${input.contributorIds.map(() => "?").join(",")}))`);
    binds.push(...input.contributorIds);
  }
  if (input.seriesIds.length) {
    where.push(`EXISTS(SELECT 1 FROM series_memberships sm WHERE sm.edition_id=e.id AND sm.series_id IN (${input.seriesIds.map(() => "?").join(",")}))`);
    binds.push(...input.seriesIds);
  }
  if (input.publisherIds.length) {
    where.push(`e.publisher_id IN (${input.publisherIds.map(() => "?").join(",")})`);
    binds.push(...input.publisherIds);
  }
  if (input.imprintIds.length) {
    where.push(`e.imprint_id IN (${input.imprintIds.map(() => "?").join(",")})`);
    binds.push(...input.imprintIds);
  }
  if (input.currency) {
    where.push("d.currency=?");
    binds.push(input.currency);
  }
  if (input.minPrice !== undefined) {
    where.push("d.price_minor>=?");
    binds.push(Math.round(input.minPrice));
  }
  if (input.maxPrice !== undefined) {
    where.push("d.price_minor<=?");
    binds.push(Math.round(input.maxPrice));
  }
  if (input.subscription !== undefined) {
    if (input.subscription) {
      where.push(`EXISTS(SELECT 1 FROM product_channel_availability pca WHERE pca.product_id=p.id AND pca.territory_code=upper(?) AND pca.sales_channel='subscription')`);
      binds.push(input.territory);
    } else {
      where.push(`NOT EXISTS(SELECT 1 FROM product_channel_availability pca WHERE pca.product_id=p.id AND pca.territory_code=upper(?) AND pca.sales_channel='subscription')`);
      binds.push(input.territory);
    }
  }
  if (input.library !== undefined) {
    if (input.library) {
      where.push(`EXISTS(SELECT 1 FROM product_channel_availability pca WHERE pca.product_id=p.id AND pca.territory_code=upper(?) AND pca.sales_channel='library')`);
      binds.push(input.territory);
    } else {
      where.push(`NOT EXISTS(SELECT 1 FROM product_channel_availability pca WHERE pca.product_id=p.id AND pca.territory_code=upper(?) AND pca.sales_channel='library')`);
      binds.push(input.territory);
    }
  }
  if (input.minRating !== undefined) {
    where.push("d.average_rating>=?");
    binds.push(input.minRating);
  }
  if (input.minReviews !== undefined) {
    where.push("d.review_count>=?");
    binds.push(Math.round(input.minReviews));
  }
  if (input.publishedAfter) {
    where.push("date(e.publication_date)>=date(?)");
    binds.push(input.publishedAfter);
  }
  if (input.publishedBefore) {
    where.push("date(e.publication_date)<=date(?)");
    binds.push(input.publishedBefore);
  }
  if (input.preorder !== undefined) {
    where.push(input.preorder ? "(e.release_status='preorder' OR e.preorder_date>datetime('now'))" : "e.release_status<>'preorder'");
  }
  if (input.sort === "coming_soon") {
    where.push("(e.release_date>datetime('now') OR e.release_status='preorder')");
  } else if (input.sort === "released") {
    where.push("COALESCE(e.release_date,e.publication_date)<=datetime('now')");
  } else if (input.sort === "published") {
    where.push("e.publication_date IS NOT NULL AND e.publication_date<=datetime('now')");
  }
  if (input.newRelease !== undefined) {
    if (input.newRelease) {
      where.push("COALESCE(e.release_date,e.publication_date)>=? AND COALESCE(e.release_date,e.publication_date)<=datetime('now')");
      binds.push(new Date(Date.now() - 90 * DAY).toISOString());
    }
  }
  if (input.deals !== undefined) {
    const activeDeal = `EXISTS(SELECT 1 FROM offers deal_offer JOIN promotions deal_promo ON deal_promo.offer_id=deal_offer.id
      WHERE deal_offer.product_id=p.id AND deal_offer.active=1
      AND (deal_offer.starts_at IS NULL OR deal_offer.starts_at<=datetime('now'))
      AND (deal_offer.ends_at IS NULL OR deal_offer.ends_at>datetime('now'))
      AND deal_promo.active=1 AND deal_promo.starts_at<=datetime('now') AND deal_promo.ends_at>datetime('now'))`;
    where.push(input.deals ? activeDeal : `NOT ${activeDeal}`);
  }
  return { where, binds };
}

function d1Sort(input: SearchInput, hasFts: boolean) {
  switch (input.sort) {
    case "popular":
    case "bestselling": return "d.fore_bestseller_score DESC,d.external_book_id ASC";
    case "trending": return "d.fore_trending_score DESC,d.fore_bestseller_score DESC,d.external_book_id ASC";
    case "most_read": return "d.fore_read_score DESC,d.external_book_id ASC";
    case "most_wishlisted": return "d.fore_wishlist_score DESC,d.external_book_id ASC";
    case "noteworthy": return "d.fore_noteworthy_score DESC,d.fore_trending_score DESC,d.external_book_id ASC";
    case "released": return "COALESCE(e.release_date,e.publication_date,'0001-01-01') DESC,d.external_book_id ASC";
    case "published": return "COALESCE(e.publication_date,'0001-01-01') DESC,d.external_book_id ASC";
    case "added": return "COALESCE(d.product_created_at,d.first_ingested_at) DESC,d.external_book_id DESC";
    case "updated": return "COALESCE(d.product_updated_at,d.updated_at) DESC,d.external_book_id DESC";
    case "coming_soon": return "COALESCE(e.release_date,e.preorder_date,'9999-12-31') ASC,d.title COLLATE NOCASE ASC";
    case "price_asc": return "d.price_minor ASC,d.title COLLATE NOCASE ASC";
    case "price_desc": return "d.price_minor DESC,d.title COLLATE NOCASE ASC";
    case "rating":
    case "top_rated": return "d.fore_rating_score DESC,d.review_count DESC,d.external_book_id ASC";
    case "title": return "d.title COLLATE NOCASE ASC";
    default: return hasFts ? "exact_rank ASC,text_rank ASC,d.merchandising_boost DESC,d.fore_trending_score DESC,d.fore_bestseller_score DESC" : "d.fore_trending_score DESC,d.fore_bestseller_score DESC,d.external_book_id ASC";
  }
}

function candidateParts(input: SearchInput, expression: string) {
  const filters = buildSqlFilters(input);
  const useEnglish = input.languages.length === 1 && input.languages[0] === "en";
  const ftsTable = useEnglish ? "catalog_search_fts_en" : "catalog_search_fts";
  const query = normalizeQuery(input.query);
  if (expression) {
    return {
      prefix: `WITH matched AS (SELECT product_id,bm25(${ftsTable},0,14,11,12,10,8,4,14,4,3,1) text_rank FROM ${ftsTable} WHERE ${ftsTable} MATCH ?)` ,
      from: `matched m JOIN catalog_search_documents d ON d.product_id=m.product_id JOIN products p ON p.id=d.product_id JOIN editions e ON e.id=p.edition_id LEFT JOIN publishers pub ON pub.id=e.publisher_id`,
      where: filters.where,
      binds: [expression, ...filters.binds],
      rank: `CASE WHEN d.external_book_id=? OR replace(d.isbn13,'-','')=? OR lower(d.title)=? THEN 0 ELSE 1 END exact_rank,m.text_rank`,
      rankBinds: [query, query.replace(/-/g, ""), query],
      hasFts: true,
    };
  }
  return {
    prefix: "",
    from: `catalog_search_documents d JOIN products p ON p.id=d.product_id JOIN editions e ON e.id=p.edition_id LEFT JOIN publishers pub ON pub.id=e.publisher_id`,
    where: filters.where,
    binds: filters.binds,
    rank: "0 exact_rank,0 text_rank",
    rankBinds: [] as unknown[],
    hasFts: false,
  };
}

function withoutFacet(input: SearchInput, facet: "categories" | "languages" | "formats" | "publishers" | "series" | "price") {
  const copy: SearchInput = {
    ...input,
    categories: [...input.categories],
    languages: [...input.languages],
    formats: [...input.formats],
    publishers: [...input.publishers],
    series: [...input.series],
  };
  if (facet === "categories") copy.categories = [];
  if (facet === "languages") copy.languages = [];
  if (facet === "formats") copy.formats = [];
  if (facet === "publishers") copy.publishers = [];
  if (facet === "series") copy.series = [];
  if (facet === "price") { copy.minPrice = undefined; copy.maxPrice = undefined; }
  return copy;
}

function d1FacetCandidate(input: SearchInput, expression: string, facet: "categories" | "languages" | "formats" | "publishers" | "series" | "price") {
  const part = candidateParts(withoutFacet(input, facet), expression);
  const clause = part.where.join(" AND ");
  const cte = `${part.prefix}${part.prefix ? "," : "WITH "}candidate AS (SELECT d.product_id,e.id edition_id,p.format,pub.name publisher_name,d.currency,d.price_minor,d.availability FROM ${part.from} WHERE ${clause})`;
  return { cte, binds: part.binds };
}

async function d1Facets(db: CatalogDB, input: SearchInput, expression: string): Promise<SearchFacets> {
  // Disjunctive facets intentionally omit their own active filter so shoppers can switch/add
  // facet values without first clearing the current selection. Other filters remain applied.
  const categoryCandidate = d1FacetCandidate(input, expression, "categories");
  const languageCandidate = d1FacetCandidate(input, expression, "languages");
  const formatCandidate = d1FacetCandidate(input, expression, "formats");
  const publisherCandidate = d1FacetCandidate(input, expression, "publishers");
  const seriesCandidate = d1FacetCandidate(input, expression, "series");
  const priceCandidate = d1FacetCandidate(input, expression, "price");
  const base = candidateParts(input, expression);
  const baseClause = base.where.join(" AND ");
  const baseCte = `${base.prefix}${base.prefix ? "," : "WITH "}candidate AS (SELECT d.product_id,e.id edition_id,p.format,pub.name publisher_name,d.currency,d.price_minor,d.availability FROM ${base.from} WHERE ${baseClause})`;
  const [categories, languages, formats, publishers, series, availability, price] = await Promise.all([
    db.prepare(`${categoryCandidate.cte} SELECT c.name value,COUNT(DISTINCT x.product_id) count FROM candidate x JOIN edition_categories ec ON ec.edition_id=x.edition_id JOIN categories c ON c.id=ec.category_id GROUP BY c.name ORDER BY count DESC,c.name LIMIT 40`).bind(...categoryCandidate.binds).all<any>(),
    db.prepare(`${languageCandidate.cte} SELECT el.language_code value,COUNT(DISTINCT x.product_id) count FROM candidate x JOIN edition_languages el ON el.edition_id=x.edition_id AND el.kind='content' GROUP BY el.language_code ORDER BY count DESC,el.language_code LIMIT 30`).bind(...languageCandidate.binds).all<any>(),
    db.prepare(`${formatCandidate.cte} SELECT format value,COUNT(*) count FROM candidate GROUP BY format ORDER BY count DESC,value LIMIT 20`).bind(...formatCandidate.binds).all<any>(),
    db.prepare(`${publisherCandidate.cte} SELECT publisher_name value,COUNT(*) count FROM candidate WHERE publisher_name IS NOT NULL AND publisher_name<>'' GROUP BY publisher_name ORDER BY count DESC,publisher_name LIMIT 30`).bind(...publisherCandidate.binds).all<any>(),
    db.prepare(`${seriesCandidate.cte} SELECT s.name value,COUNT(DISTINCT x.product_id) count FROM candidate x JOIN series_memberships sm ON sm.edition_id=x.edition_id JOIN series s ON s.id=sm.series_id GROUP BY s.name ORDER BY count DESC,s.name LIMIT 30`).bind(...seriesCandidate.binds).all<any>(),
    db.prepare(`${baseCte} SELECT availability value,COUNT(*) count FROM candidate GROUP BY availability ORDER BY count DESC,value LIMIT 10`).bind(...base.binds).all<any>(),
    db.prepare(`${priceCandidate.cte} SELECT MIN(price_minor) min_price,MAX(price_minor) max_price,MAX(currency) currency FROM candidate`).bind(...priceCandidate.binds).first<any>(),
  ]);
  const values = (rows: any[]) => rows.map((r) => ({ value: String(r.value), count: Number(r.count || 0) })).filter((r) => r.value);
  return {
    categories: values(categories.results),
    languages: values(languages.results),
    formats: values(formats.results),
    publishers: values(publishers.results),
    series: values(series.results),
    availability: values(availability.results),
    price: price && price.min_price !== null ? { currency: String(price.currency || input.currency || "USD"), min: Number(price.min_price), max: Number(price.max_price) } : null,
  };
}

function levenshtein(a: string, b: string) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(
        current[j - 1] + 1,
        previous[j] + 1,
        previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    for (let j = 0; j <= b.length; j++) previous[j] = current[j];
  }
  return previous[b.length];
}

async function typoCorrection(db: CatalogDB, query: string) {
  const tokens = queryTokens(query);
  let changed = false;
  const corrected: string[] = [];
  for (const token of tokens) {
    if (token.length < 5 || /^\d+$/.test(token)) { corrected.push(token); continue; }
    const exact = await db.prepare("SELECT term FROM catalog_search_vocab WHERE term=? LIMIT 1").bind(token).first<any>();
    if (exact) { corrected.push(token); continue; }
    const first = token[0];
    const upper = String.fromCodePoint(first.codePointAt(0)! + 1);
    const candidates = await db.prepare("SELECT term,doc FROM catalog_search_vocab WHERE term>=? AND term<? ORDER BY doc DESC LIMIT 400").bind(first, upper).all<any>();
    const maxDistance = token.length >= 9 ? 2 : 1;
    let best: { term: string; distance: number; doc: number } | null = null;
    for (const row of candidates.results) {
      const term = String(row.term);
      if (Math.abs(term.length - token.length) > maxDistance) continue;
      const distance = levenshtein(token, term);
      if (distance > maxDistance) continue;
      const candidate = { term, distance, doc: Number(row.doc || 0) };
      if (!best || distance < best.distance || (distance === best.distance && candidate.doc > best.doc)) best = candidate;
    }
    if (best) { corrected.push(best.term); changed ||= best.term !== token; }
    else corrected.push(token);
  }
  return changed ? corrected.join(" ") : null;
}

async function searchD1(env: SearchEnv, input: SearchInput) {
  const started = Date.now();
  let correctedQuery: string | undefined;
  let expression = await ftsExpression(env.DB, input);
  let part = candidateParts(input, expression);
  const runIds = async () => {
    const clause = part.where.join(" AND ");
    const sql = `${part.prefix} SELECT d.product_id,${part.rank} FROM ${part.from} WHERE ${clause} ORDER BY ${d1Sort(input, part.hasFts)} LIMIT ? OFFSET ?`;
    const orderedBinds = part.hasFts
      ? [part.binds[0], ...part.rankBinds, ...part.binds.slice(1), input.limit, (input.page - 1) * input.limit]
      : [...part.rankBinds, ...part.binds, input.limit, (input.page - 1) * input.limit];
    return env.DB.prepare(sql).bind(...orderedBinds).all<any>();
  };
  let rows = await runIds();
  if (!rows.results.length && input.query && input.page === 1) {
    const correction = await typoCorrection(env.DB, input.query);
    if (correction) {
      correctedQuery = correction;
      expression = await ftsExpression(env.DB, input, correction);
      part = candidateParts(input, expression);
      rows = await runIds();
    }
  }
  const clause = part.where.join(" AND ");
  const count = await env.DB.prepare(`${part.prefix} SELECT COUNT(*) count FROM ${part.from} WHERE ${clause}`).bind(...part.binds).first<any>();
  const ids = rows.results.map((r: any) => String(r.product_id));
  const [books, facets] = await Promise.all([canonicalBooksByProductIds(env.DB, ids), d1Facets(env.DB, input, expression)]);
  return { books, count: Number(count?.count || 0), facets, correctedQuery, duration: Date.now() - started };
}

function meiliBase(env: SearchEnv) {
  return String(env.FORE_SEARCH_URL || "").replace(/\/+$/, "");
}
async function meiliRequest(env: SearchEnv, path: string, init: RequestInit = {}, admin = false, allow404 = false) {
  const key = admin ? env.FORE_SEARCH_ADMIN_KEY : env.FORE_SEARCH_SEARCH_KEY || env.FORE_SEARCH_ADMIN_KEY;
  if (!meiliConfigured(env) || !key) throw new Error("Meilisearch is not configured.");
  const response = await fetch(meiliBase(env) + path, {
    ...init,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}`, ...(init.headers || {}) },
    signal: AbortSignal.timeout(8000),
  });
  if (allow404 && response.status === 404) return null;
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Search service ${response.status}: ${String((payload as any).message || response.statusText).slice(0, 300)}`);
  return payload as any;
}
async function awaitMeiliTask(env: SearchEnv, uid: number) {
  for (let i = 0; i < 30; i++) {
    const task = await meiliRequest(env, `/tasks/${uid}`, {}, true);
    if (task.status === "succeeded") return task;
    if (task.status === "failed" || task.status === "canceled") throw new Error(task.error?.message || "Search indexing task failed.");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Search index configuration timed out.");
}
async function configureMeili(env: SearchEnv) {
  if (!env.FORE_SEARCH_ADMIN_KEY) return;
  const state = await env.DB.prepare("SELECT * FROM search_index_state WHERE id=1").first<any>();
  const indexUid = searchIndex(env);
  if (Number(state?.settings_version || 0) === SEARCH_SETTINGS_VERSION && state?.index_uid === indexUid && !state?.last_error) return;
  const existing = await meiliRequest(env, `/indexes/${encodeURIComponent(indexUid)}`, {}, true, true);
  if (!existing) {
    const created = await meiliRequest(env, "/indexes", { method: "POST", body: JSON.stringify({ uid: indexUid, primaryKey: "id" }) }, true);
    if (created?.taskUid !== undefined) await awaitMeiliTask(env, created.taskUid);
  }
  const synonymRows = await env.DB.prepare("SELECT term,synonyms_json FROM search_synonyms WHERE enabled=1").all<any>();
  const synonymObject: Record<string, string[]> = {};
  for (const row of synonymRows.results) synonymObject[String(row.term)] = parseJsonArray(row.synonyms_json);
  const settings = {
    displayedAttributes: ["id","externalBookId","publicProductId","title","subtitle","authors","contributorIds","series","seriesIds","publisher","publisherId","imprint","imprintId","categories","taxonomyPaths","languages","format","currency","priceMinor","averageRating","reviewCount","releaseTimestamp","publicationTimestamp","preorderTimestamp","comingSoonTimestamp","firstIngestedTimestamp","updatedTimestamp","preorder","deal","subscriptionEligible","availability"],
    searchableAttributes: ["title","subtitle","authors","contributors","series","isbn13","externalBookId","publisher","categories","subjects","taxonomyPaths","keywords","description"],
    filterableAttributes: ["sourceName","storefrontStatus","suppressed","categories","taxonomyPaths","languages","format","publisher","publisherId","imprintId","series","seriesIds","contributorIds","currency","priceMinor","subscriptionEligible","libraryEligible","averageRating","reviewCount","releaseTimestamp","publicationTimestamp","preorderTimestamp","preorder","deal","availability","territories"],
    sortableAttributes: ["popularityScore","salesVelocity","readScore","wishlistScore","ratingScore","noteworthyScore","releaseTimestamp","publicationTimestamp","preorderTimestamp","comingSoonTimestamp","firstIngestedTimestamp","updatedTimestamp","priceMinor","averageRating","reviewCount","titleSort","merchandisingBoost"],
    rankingRules: ["sort","words","typo","proximity","attributeRank","wordPosition","merchandisingBoost:desc","salesVelocity:desc","popularityScore:desc","exactness"],
    typoTolerance: { enabled: true, minWordSizeForTypos: { oneTypo: 5, twoTypos: 9 }, disableOnAttributes: ["isbn13","externalBookId"] },
    synonyms: synonymObject,
    pagination: { maxTotalHits: 100000 },
    faceting: { maxValuesPerFacet: 100, sortFacetValuesBy: { "*": "count" } },
  };
  const task = await meiliRequest(env, `/indexes/${encodeURIComponent(indexUid)}/settings`, { method: "PATCH", body: JSON.stringify(settings) }, true);
  if (task?.taskUid !== undefined) await awaitMeiliTask(env, task.taskUid);
  await env.DB.prepare("UPDATE search_index_state SET backend='meilisearch',index_uid=?,settings_version=?,last_error='' WHERE id=1").bind(indexUid, SEARCH_SETTINGS_VERSION).run();
}

function meiliQuote(value: string) {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}
type MeiliFacetOmit = "categories" | "languages" | "formats" | "publishers" | "series" | "price" | null;
function meiliFilters(input: SearchInput, omit: MeiliFacetOmit = null) {
  const f: string[] = [`storefrontStatus = ${meiliQuote("active")}`, "suppressed = false", `territories = ${meiliQuote(input.territory)}`];
  if (input.availability) f.push(`availability = ${meiliQuote(input.availability)}`);
  if (input.taxonomy.length) f.push(`taxonomyPaths IN [${input.taxonomy.map(meiliQuote).join(",")}]`);
  if (omit !== "languages" && input.languages.length) f.push(`languages IN [${input.languages.map(meiliQuote).join(",")}]`);
  if (omit !== "categories" && input.categories.length) f.push(`categories IN [${input.categories.map(meiliQuote).join(",")}]`);
  if (omit !== "formats" && input.formats.length) f.push(`format IN [${input.formats.map(meiliQuote).join(",")}]`);
  if (omit !== "publishers" && input.publishers.length) f.push(`publisher IN [${input.publishers.map(meiliQuote).join(",")}]`);
  if (omit !== "series" && input.series.length) f.push(`series IN [${input.series.map(meiliQuote).join(",")}]`);
  if (input.contributorIds.length) f.push(`contributorIds IN [${input.contributorIds.map(meiliQuote).join(",")}]`);
  if (input.seriesIds.length) f.push(`seriesIds IN [${input.seriesIds.map(meiliQuote).join(",")}]`);
  if (input.publisherIds.length) f.push(`publisherId IN [${input.publisherIds.map(meiliQuote).join(",")}]`);
  if (input.imprintIds.length) f.push(`imprintId IN [${input.imprintIds.map(meiliQuote).join(",")}]`);
  if (input.currency) f.push(`currency = ${meiliQuote(input.currency)}`);
  if (omit !== "price" && input.minPrice !== undefined) f.push(`priceMinor >= ${Math.round(input.minPrice)}`);
  if (omit !== "price" && input.maxPrice !== undefined) f.push(`priceMinor <= ${Math.round(input.maxPrice)}`);
  if (input.subscription !== undefined) f.push(`subscriptionEligible = ${input.subscription}`);
  if (input.library !== undefined) f.push(`libraryEligible = ${input.library}`);
  if (input.minRating !== undefined) f.push(`averageRating >= ${input.minRating}`);
  if (input.minReviews !== undefined) f.push(`reviewCount >= ${Math.round(input.minReviews)}`);
  if (input.publishedAfter) f.push(`publicationTimestamp >= ${Math.floor(Date.parse(`${input.publishedAfter}T00:00:00Z`) / 1000)}`);
  if (input.publishedBefore) f.push(`publicationTimestamp <= ${Math.floor(Date.parse(`${input.publishedBefore}T23:59:59Z`) / 1000)}`);
  if (input.preorder !== undefined) f.push(`preorder = ${input.preorder}`);
  const nowTs = Math.floor(Date.now()/1000);
  if (input.sort === "coming_soon") f.push(`(releaseTimestamp > ${nowTs} OR preorder = true)`);
  else if (input.sort === "released") f.push(`releaseTimestamp <= ${nowTs}`);
  else if (input.sort === "published") f.push(`publicationTimestamp > 0 AND publicationTimestamp <= ${nowTs}`);
  if (input.newRelease) f.push(`releaseTimestamp >= ${Math.floor((Date.now() - 90 * DAY) / 1000)} AND releaseTimestamp <= ${Math.floor(Date.now()/1000)}`);
  if (input.deals !== undefined) f.push(`deal = ${input.deals}`);
  return f;
}

function meiliSort(sort: string) {
  switch (sort) {
    case "popular":
    case "bestselling": return ["popularityScore:desc"];
    case "trending": return ["salesVelocity:desc","popularityScore:desc"];
    case "most_read": return ["readScore:desc"];
    case "most_wishlisted": return ["wishlistScore:desc"];
    case "noteworthy": return ["noteworthyScore:desc","salesVelocity:desc"];
    case "released": return ["releaseTimestamp:desc"];
    case "published": return ["publicationTimestamp:desc"];
    case "added": return ["firstIngestedTimestamp:desc"];
    case "updated": return ["updatedTimestamp:desc"];
    case "coming_soon": return ["comingSoonTimestamp:asc","titleSort:asc"];
    case "price_asc": return ["priceMinor:asc","titleSort:asc"];
    case "price_desc": return ["priceMinor:desc","titleSort:asc"];
    case "rating":
    case "top_rated": return ["ratingScore:desc","reviewCount:desc"];
    case "title": return ["titleSort:asc"];
    default: return [];
  }
}
function facetValues(payload: any, name: string, max = 40): FacetValue[] {
  return Object.entries(payload?.facetDistribution?.[name] || {})
    .map(([value, count]) => ({ value, count: Number(count) }))
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value))
    .slice(0, max);
}

async function meiliDisjunctiveFacets(env: SearchEnv, input: SearchInput, q: string, availabilityPayload: any): Promise<SearchFacets> {
  const indexUid = searchIndex(env);
  const specs: { facet: string; omit: Exclude<MeiliFacetOmit, null> }[] = [
    { facet: "categories", omit: "categories" },
    { facet: "languages", omit: "languages" },
    { facet: "format", omit: "formats" },
    { facet: "publisher", omit: "publishers" },
    { facet: "series", omit: "series" },
    { facet: "priceMinor", omit: "price" },
  ];
  const queries = specs.map((spec) => ({
    indexUid,
    q,
    limit: 0,
    filter: meiliFilters(input, spec.omit),
    facets: [spec.facet],
    matchingStrategy: "frequency",
  }));
  const payload = await meiliRequest(env, "/multi-search", { method: "POST", body: JSON.stringify({ queries }) });
  const results = Array.isArray(payload?.results) ? payload.results : [];
  const priceStats = results[5]?.facetStats?.priceMinor;
  return {
    categories: facetValues(results[0], "categories"),
    languages: facetValues(results[1], "languages", 30),
    formats: facetValues(results[2], "format", 20),
    publishers: facetValues(results[3], "publisher", 30),
    series: facetValues(results[4], "series", 30),
    availability: facetValues(availabilityPayload, "availability", 10),
    price: priceStats ? { currency: input.currency || "USD", min: Number(priceStats.min || 0), max: Number(priceStats.max || 0) } : null,
  };
}

async function retailEligibleIdSet(db: CatalogDB, productIds: string[], territory: string) {
  if (!productIds.length) return new Set<string>();
  const unique = [...new Set(productIds)].slice(0, 500);
  const placeholders = unique.map(() => "?").join(",");
  const rows = await db.prepare(`SELECT DISTINCT product_id FROM retail_product_availability WHERE territory_code=upper(?) AND product_id IN (${placeholders})`).bind(territory, ...unique).all<any>();
  return new Set(rows.results.map((row) => String(row.product_id)));
}

async function searchMeili(env: SearchEnv, input: SearchInput) {
  const started = Date.now();
  const q = meiliQueryText(input.query, input.topic);
  const body: any = {
    q,
    page: input.page,
    hitsPerPage: input.limit,
    filter: meiliFilters(input),
    sort: meiliSort(input.sort),
    facets: ["availability"],
    attributesToRetrieve: ["id"],
    matchingStrategy: "frequency",
    showRankingScore: false,
  };
  if (env.FORE_SEARCH_EMBEDDER && q) body.hybrid = { embedder: env.FORE_SEARCH_EMBEDDER, semanticRatio: 0.25 };
  const [payload, facets] = await Promise.all([
    meiliRequest(env, `/indexes/${encodeURIComponent(searchIndex(env))}/search`, { method: "POST", body: JSON.stringify(body) }),
    meiliDisjunctiveFacets(env, input, q, { facetDistribution: {} }),
  ]);
  // Availability has no public UI selector today, so its counts can safely come from the main
  // query while the shopper-facing facets use self-filter-excluding counts from multi-search.
  facets.availability = facetValues(payload, "availability", 10);
  const ids = (payload.hits || []).map((h: any) => String(h.id));
  // Never trust an external search index as the rights authority. If its cached territorial
  // metadata is stale, fail over to D1 rather than exposing an unavailable product.
  const eligible = await retailEligibleIdSet(env.DB, ids, input.territory);
  if (ids.some((id) => !eligible.has(id))) throw new Error("Search index rights projection is stale.");
  const books = await canonicalBooksByProductIds(env.DB, ids);
  return {
    books,
    count: Number(payload.totalHits ?? payload.estimatedTotalHits ?? books.length),
    facets,
    duration: Number(payload.processingTimeMs ?? Date.now() - started),
  };
}

async function contextualizeChannelEligibility(db: CatalogDB, books: CatalogBook[], territory: string) {
  const productIds = books.map((book) => String(book.productId || "")).filter(Boolean);
  if (!productIds.length) return books;
  const unique = [...new Set(productIds)].slice(0, 200);
  const rows = await db.prepare(`SELECT product_id,sales_channel FROM product_channel_availability
    WHERE territory_code=upper(?) AND sales_channel IN ('subscription','library')
      AND product_id IN (${unique.map(() => "?").join(",")})`).bind(territory,...unique).all<any>();
  const allowed = new Set(rows.results.map((row) => `${String(row.product_id)}:${String(row.sales_channel)}`));
  return books.map((book) => {
    const id = String(book.productId || "");
    return {
      ...book,
      subscriptionEligible: allowed.has(`${id}:subscription`),
      libraryEligible: allowed.has(`${id}:library`),
    };
  });
}

async function logQuery(db: CatalogDB, input: SearchInput, userId: string | null, data: { count: number; backend: string; duration: number; correctedQuery?: string; productIds: string[] }) {
  const hasSearchIntent = !!input.query || !!input.topic || input.categories.length > 0 || input.languages.length > 0 || input.formats.length > 0 || input.publishers.length > 0 || input.series.length > 0 || input.contributorIds.length > 0 || input.seriesIds.length > 0 || input.publisherIds.length > 0 || input.imprintIds.length > 0
    || input.minPrice !== undefined || input.maxPrice !== undefined || input.subscription !== undefined || input.library !== undefined
    || input.minRating !== undefined || input.minReviews !== undefined || !!input.publishedAfter || !!input.publishedBefore
    || input.preorder !== undefined || input.newRelease !== undefined || input.deals !== undefined || (input.availability !== undefined && input.availability !== "available");
  if (!hasSearchIntent) return null;
  const id = crypto.randomUUID();
  const filters = { categories: input.categories, languages: input.languages, formats: input.formats, publishers: input.publishers, series: input.series, contributorIds: input.contributorIds, seriesIds: input.seriesIds, publisherIds: input.publisherIds, imprintIds: input.imprintIds, currency: input.currency, minPrice: input.minPrice, maxPrice: input.maxPrice, subscription: input.subscription, library: input.library, minRating: input.minRating, minReviews: input.minReviews, publishedAfter: input.publishedAfter, publishedBefore: input.publishedBefore, preorder: input.preorder, newRelease: input.newRelease, deals: input.deals, availability: input.availability, territory: input.territory };
  const impressions = data.productIds.map((productId, index) => ({ productId, position: (input.page - 1) * input.limit + index + 1 }));
  await db.prepare("INSERT INTO search_query_events(id,user_id,query,normalized_query,filters_json,sort,result_count,backend,duration_ms,corrected_query,result_impressions_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)")
    .bind(id, userId, input.query, normalizeQuery(input.query), JSON.stringify({ ...filters, page: input.page, limit: input.limit }), input.sort, data.count, data.backend, Math.max(0, Math.round(data.duration)), data.correctedQuery || null, JSON.stringify(impressions), new Date().toISOString()).run();
  return id;
}

export async function searchCatalog(env: SearchEnv, input: SearchInput, userId: string | null): Promise<SearchResult> {
  const personalizeWindow=!!input.query&&input.sort==="relevance"&&await personalizedSearchEnabled(env.DB,userId);
  const start=(input.page-1)*input.limit,windowLimit=Math.min(200,Math.max(input.limit*5,start+input.limit));
  const searchInputForBackend=personalizeWindow&&start<200?{...input,page:1,limit:windowLimit}:input;
  let backend = preferredBackend(env);
  // Subscription/library eligibility is date- and territory-sensitive legal state; D1 is the
  // authoritative projection until those channels have independent external indexes.
  if (input.subscription !== undefined || input.library !== undefined) backend = "d1";
  let result: Awaited<ReturnType<typeof searchD1>> | Awaited<ReturnType<typeof searchMeili>>;
  if (backend === "meilisearch") {
    try {
      result = await searchMeili(env, searchInputForBackend);
    } catch (error) {
      console.warn("Meilisearch query failed; using D1 FTS5 fallback", error);
      backend = "d1";
      result = await searchD1(env, searchInputForBackend);
      await env.DB.prepare("UPDATE search_index_state SET last_error=? WHERE id=1").bind(error instanceof Error ? error.message.slice(0,500) : String(error).slice(0,500)).run();
    }
  } else result = await searchD1(env, searchInputForBackend);
  const backendName = backend === "meilisearch" ? "meilisearch" : "d1-fts5";
  const personalized = input.sort === "relevance" && input.query ? await personalizeSearchBooks(env.DB, userId, result.books) : { books: result.books, applied: false };
  const pageBooks=personalizeWindow&&start<200?personalized.books.slice(start,start+input.limit):personalized.books;
  const visibleBooks=await contextualizeChannelEligibility(env.DB,pageBooks,input.territory);
  const queryId = await logQuery(env.DB, input, userId, { count: result.count, backend: backendName, duration: result.duration, correctedQuery: "correctedQuery" in result ? result.correctedQuery : undefined, productIds: visibleBooks.map((book) => String(book.productId || "")).filter(Boolean) });
  return { books: visibleBooks, count: result.count, facets: result.facets, queryId, backend: backendName, processingTimeMs: result.duration, correctedQuery: "correctedQuery" in result ? result.correctedQuery : undefined, limit: input.limit, personalizationApplied: personalized.applied };
}

async function searchDocuments(db: CatalogDB, productIds: string[]): Promise<SearchDocument[]> {
  if (!productIds.length) return [];
  const placeholders = productIds.map(() => "?").join(",");
  const rows = await db.prepare(`SELECT d.*,p.public_id product_public_id,p.source_name,p.storefront_status,p.format product_format,e.id edition_id,e.release_status,e.preorder_date,e.publication_date,e.publisher_id,e.imprint_id,pub.name publisher_name,imp.name imprint_name,
    (SELECT json_group_array(c.name) FROM edition_contributors ec JOIN contributors c ON c.id=ec.contributor_id WHERE ec.edition_id=e.id AND ec.role='author') authors_json,
    (SELECT json_group_array(c.name) FROM edition_contributors ec JOIN contributors c ON c.id=ec.contributor_id WHERE ec.edition_id=e.id) contributors_json,
    (SELECT json_group_array(ec.contributor_id) FROM edition_contributors ec WHERE ec.edition_id=e.id) contributor_ids_json,
    (SELECT json_group_array(s.name) FROM series_memberships sm JOIN series s ON s.id=sm.series_id WHERE sm.edition_id=e.id) series_json,
    (SELECT json_group_array(sm.series_id) FROM series_memberships sm WHERE sm.edition_id=e.id) series_ids_json,
    (SELECT json_group_array(c.name) FROM edition_categories ec JOIN categories c ON c.id=ec.category_id WHERE ec.edition_id=e.id) category_json,
    (SELECT json_group_array(s.name) FROM edition_subjects es JOIN subjects s ON s.id=es.subject_id WHERE es.edition_id=e.id) subject_json,
    (SELECT json_group_array(n.path) FROM edition_taxonomy_nodes et JOIN storefront_taxonomy_nodes n ON n.id=et.taxonomy_node_id WHERE et.edition_id=e.id) taxonomy_json,
    (SELECT json_group_array(el.language_code) FROM edition_languages el WHERE el.edition_id=e.id AND el.kind='content') language_json,
    (SELECT json_group_array(k.value) FROM edition_keywords ek JOIN keywords k ON k.id=ek.keyword_id WHERE ek.edition_id=e.id) keyword_json,
    (SELECT json_group_array(DISTINCT rpa.territory_code) FROM retail_product_availability rpa WHERE rpa.product_id=p.id) territories_json,
    COALESCE((SELECT SUM(m.boost) FROM search_merchandising_rules m WHERE m.product_id=p.id AND m.active=1 AND (m.starts_at IS NULL OR m.starts_at<=datetime('now')) AND (m.ends_at IS NULL OR m.ends_at>datetime('now'))),0) active_boost,
    CASE WHEN EXISTS(SELECT 1 FROM offers deal_offer JOIN promotions deal_promo ON deal_promo.offer_id=deal_offer.id WHERE deal_offer.product_id=p.id AND deal_offer.active=1 AND (deal_offer.starts_at IS NULL OR deal_offer.starts_at<=datetime('now')) AND (deal_offer.ends_at IS NULL OR deal_offer.ends_at>datetime('now')) AND deal_promo.active=1 AND deal_promo.starts_at<=datetime('now') AND deal_promo.ends_at>datetime('now')) THEN 1 ELSE 0 END active_deal
    FROM catalog_search_documents d JOIN products p ON p.id=d.product_id JOIN editions e ON e.id=p.edition_id LEFT JOIN publishers pub ON pub.id=e.publisher_id LEFT JOIN imprints imp ON imp.id=e.imprint_id
    WHERE d.product_id IN (${placeholders})`).bind(...productIds).all<any>();
  return rows.results.map((r: any) => {
    const release = timestamp(r.release_date || r.publication_date);
    const publication = timestamp(r.publication_date);
    const preorderAt = timestamp(r.preorder_date);
    const comingSoonAt = timestamp(r.release_date || r.preorder_date) || 4_102_444_800;
    const preorder = r.release_status === "preorder" || (r.preorder_date && Date.parse(r.preorder_date) > Date.now());
    return {
      id: String(r.product_id), externalBookId: String(r.external_book_id), publicProductId: String(r.product_public_id || ""), title: String(r.title), subtitle: String(r.subtitle || ""),
      authors: uniq(parseJsonArray(r.authors_json), 40), contributors: uniq(parseJsonArray(r.contributors_json), 60), contributorIds: uniq(parseJsonArray(r.contributor_ids_json), 60), series: uniq(parseJsonArray(r.series_json), 20), seriesIds: uniq(parseJsonArray(r.series_ids_json), 20),
      publisher: String(r.publisher_name || r.publisher_text || ""), publisherId: String(r.publisher_id || ""), imprint: String(r.imprint_name || r.imprint_text || ""), imprintId: String(r.imprint_id || ""), isbn13: String(r.isbn13 || "").replace(/[^0-9Xx]/g, ""),
      categories: uniq(parseJsonArray(r.category_json), 100), subjects: uniq(parseJsonArray(r.subject_json), 150), languages: uniq(parseJsonArray(r.language_json), 20).map((x) => x.toLowerCase()), keywords: uniq(parseJsonArray(r.keyword_json), 60), description: String(r.description || "").slice(0,12000),
      format: String(r.product_format || r.format || "ebook").toLowerCase(), currency: String(r.currency || "USD"), priceMinor: Number(r.price_minor || 0), subscriptionEligible: !!r.subscription_eligible, libraryEligible: !!r.library_eligible,
      averageRating: Number(r.average_rating || 0), reviewCount: Number(r.review_count || 0), releaseTimestamp: release, publicationTimestamp: publication, preorderTimestamp: preorderAt, comingSoonTimestamp: comingSoonAt, firstIngestedTimestamp: timestamp(r.product_created_at || r.first_ingested_at), updatedTimestamp: timestamp(r.product_updated_at || r.updated_at), taxonomyPaths: uniq(parseJsonArray(r.taxonomy_json), 100), preorder: !!preorder, deal: !!r.active_deal,
      popularityScore: Number(r.fore_bestseller_score || 0), salesVelocity: Number(r.fore_trending_score || 0), readScore: Number(r.fore_read_score || 0), wishlistScore: Number(r.fore_wishlist_score || 0), ratingScore: Number(r.fore_rating_score || 0), noteworthyScore: Number(r.fore_noteworthy_score || 0), availability: String(r.availability || "available"), territories: uniq(parseJsonArray(r.territories_json), 80),
      merchandisingBoost: Number(r.merchandising_boost || 0) + Number(r.active_boost || 0), sourceName: String(r.source_name), storefrontStatus: String(r.storefront_status), suppressed: !!r.suppressed, titleSort: String(r.title || "").toLocaleLowerCase(),
    } satisfies SearchDocument;
  });
}

export async function syncSearchIndex(env: SearchEnv, limit = 100) {
  if (!meiliConfigured(env) || !env.FORE_SEARCH_ADMIN_KEY) return { backend: "d1-fts5", synced: 0, pending: 0 };
  const safeLimit = Math.max(1, Math.min(500, Math.floor(limit)));
  try {
    await configureMeili(env);
    const pending = await env.DB.prepare("SELECT product_id,operation FROM search_index_outbox ORDER BY queued_at LIMIT ?").bind(safeLimit).all<any>();
    if (!pending.results.length) return { backend: "meilisearch", synced: 0, pending: 0 };
    const upsertIds = pending.results.filter((x: any) => x.operation === "upsert").map((x: any) => String(x.product_id));
    const deleteIds = pending.results.filter((x: any) => x.operation === "delete").map((x: any) => String(x.product_id));
    const docs = (await searchDocuments(env.DB, upsertIds)).filter((x) => !x.suppressed && x.sourceName !== "upload" && x.storefrontStatus === "active");
    const missingOrPrivate = upsertIds.filter((id) => !docs.some((d) => d.id === id));
    let accepted = 0;
    if (docs.length) {
      const task = await meiliRequest(env, `/indexes/${encodeURIComponent(searchIndex(env))}/documents?primaryKey=id`, { method: "POST", body: JSON.stringify(docs) }, true);
      if (task?.taskUid !== undefined) await awaitMeiliTask(env, task.taskUid);
      accepted += docs.length;
    }
    for (const id of [...deleteIds, ...missingOrPrivate]) {
      const task = await meiliRequest(env, `/indexes/${encodeURIComponent(searchIndex(env))}/documents/${encodeURIComponent(id)}`, { method: "DELETE" }, true, true);
      if (task?.taskUid !== undefined) await awaitMeiliTask(env, task.taskUid);
      accepted++;
    }
    if (pending.results.length) {
      const ids = pending.results.map((x: any) => String(x.product_id));
      await env.DB.prepare(`DELETE FROM search_index_outbox WHERE product_id IN (${ids.map(() => "?").join(",")})`).bind(...ids).run();
    }
    const remaining = await env.DB.prepare("SELECT COUNT(*) count FROM search_index_outbox").first<any>();
    await env.DB.prepare("UPDATE search_index_state SET backend='meilisearch',last_synced_at=?,last_error='',documents_indexed=documents_indexed+? WHERE id=1").bind(new Date().toISOString(), accepted).run();
    return { backend: "meilisearch", synced: accepted, pending: Number(remaining?.count || 0) };
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0,500) : String(error).slice(0,500);
    await env.DB.prepare("UPDATE search_index_state SET last_error=? WHERE id=1").bind(message).run();
    const rows = await env.DB.prepare("SELECT product_id FROM search_index_outbox ORDER BY queued_at LIMIT ?").bind(safeLimit).all<any>();
    for (const row of rows.results) await env.DB.prepare("UPDATE search_index_outbox SET attempts=attempts+1,last_error=? WHERE product_id=?").bind(message, row.product_id).run();
    throw error;
  }
}

export async function rebuildSearchIndex(env: SearchEnv, limit = 500) {
  if (!env.FORE_SEARCH_ADMIN_KEY || !meiliConfigured(env)) throw new ApiError(503, "External search indexing is not configured.");
  await env.DB.prepare("INSERT INTO search_index_outbox(product_id,operation,queued_at,attempts,last_error) SELECT product_id,'upsert',datetime('now'),0,'' FROM catalog_search_documents WHERE suppressed=0 ON CONFLICT(product_id) DO UPDATE SET operation='upsert',queued_at=excluded.queued_at,attempts=0,last_error='' ").run();
  return syncSearchIndex(env, limit);
}

export async function refreshSearchQualitySignals(db: CatalogDB, externalBookId: string) {
  await db.prepare(`UPDATE catalog_search_documents SET
    average_rating=COALESCE((SELECT AVG(r.rating_steps)/2.0 FROM reviews r WHERE r.book_id=? AND r.visibility='public' AND r.moderation='visible' AND r.rating_steps IS NOT NULL),0),
    review_count=COALESCE((SELECT COUNT(*) FROM reviews r WHERE r.book_id=? AND r.visibility='public' AND r.moderation='visible' AND r.rating_steps IS NOT NULL),0),
    updated_at=? WHERE external_book_id=?`).bind(externalBookId, externalBookId, new Date().toISOString(), externalBookId).run();
}

export async function searchSuggestions(env: SearchEnv, query: string, territory = "US") {
  const q = cleanText(query, 100);
  if (q.length < 2) return [];
  const externalQuery = isbnLike(q) ? compactIdentifier(q) : q;
  if (preferredBackend(env) === "meilisearch") {
    try {
      const payload = await meiliRequest(env, `/indexes/${encodeURIComponent(searchIndex(env))}/search`, { method: "POST", body: JSON.stringify({ q: externalQuery, limit: 8, filter: [`storefrontStatus = ${meiliQuote("active")}`,"suppressed = false",`territories = ${meiliQuote(territory)}`], attributesToRetrieve: ["id","externalBookId","publicProductId","title","authors","series","publisher"], matchingStrategy: "frequency" }) });
      const hits = payload.hits || [];
      const eligible = await retailEligibleIdSet(env.DB, hits.map((h: any) => String(h.id)), territory);
      return hits.filter((h: any) => eligible.has(String(h.id))).map((h: any) => ({ type: "book", productId: String(h.id), bookId: String(h.publicProductId || h.externalBookId), label: String(h.title), sublabel: (h.authors || []).join(", ") || (h.series || []).join(", ") || h.publisher || "" }));
    } catch (error) { console.warn("Search suggestions fell back to D1", error); }
  }
  const input: SearchInput = { query: q, taxonomy: [], categories: [], languages: [], formats: [], publishers: [], series: [], contributorIds: [], seriesIds: [], publisherIds: [], imprintIds: [], currency: "USD", territory, sort: "relevance", page: 1, limit: 8, availability: "available" };
  const expression = await ftsExpression(env.DB, input);
  const part = candidateParts(input, expression);
  const rows = await env.DB.prepare(`${part.prefix} SELECT d.product_id,d.external_book_id,p.public_id public_product_id,d.title,d.contributors_text FROM ${part.from} WHERE ${part.where.join(" AND ")} ORDER BY m.text_rank ASC,d.fore_trending_score DESC,d.fore_bestseller_score DESC LIMIT 8`).bind(...part.binds).all<any>();
  return rows.results.map((r: any) => ({ type: "book", productId: String(r.product_id), bookId: String(r.public_product_id || r.external_book_id), label: String(r.title), sublabel: String(r.contributors_text || "") }));
}

export async function recordSearchClick(db: CatalogDB, input: { queryId: string; productId: string; position: number }) {
  const impression = await db.prepare(`SELECT 1 ok FROM search_query_events q
    WHERE q.id=? AND datetime(q.created_at)>=datetime('now','-1 day')
      AND EXISTS(SELECT 1 FROM json_each(q.result_impressions_json) j
        WHERE json_extract(j.value,'$.productId')=? AND CAST(json_extract(j.value,'$.position') AS INTEGER)=?)`).bind(input.queryId, input.productId, input.position).first<any>();
  if (!impression) throw new ApiError(404, "Search impression expired or is invalid.");
  await db.prepare("INSERT OR IGNORE INTO search_click_events(query_id,product_id,position,created_at) VALUES(?,?,?,?)").bind(input.queryId, input.productId, input.position, new Date().toISOString()).run();
  return { saved: true };
}

export async function searchStatus(env: SearchEnv) {
  const [state, pending] = await Promise.all([
    env.DB.prepare("SELECT * FROM search_index_state WHERE id=1").first<any>(),
    env.DB.prepare("SELECT COUNT(*) count FROM search_index_outbox").first<any>(),
  ]);
  return { configuredBackend: preferredBackend(env) === "meilisearch" ? "meilisearch" : "d1-fts5", index: searchIndex(env), pending: Number(pending?.count || 0), lastSyncedAt: state?.last_synced_at || null, lastError: state?.last_error || "", settingsVersion: Number(state?.settings_version || 0) };
}
