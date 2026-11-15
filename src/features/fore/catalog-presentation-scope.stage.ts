import type { SearchInput } from "./search.server";

/**
 * Stage-only key for a future COMPLETE, immutable public search presentation
 * index. This does not fetch books, assert a current rights grant, or supply
 * an exact count. Never reuse this projection for user-personalized searches.
 *
 * parseSearchInput is the production request parser. Every query axis is
 * explicitly accounted for; new search fields must fail loudly until audited.
 */
const SCHEMA = "cove.public-catalog-query-projection.v1";
const SORTS = new Set([
  "relevance",
  "popular",
  "bestselling",
  "trending",
  "most_read",
  "most_wishlisted",
  "noteworthy",
  "released",
  "published",
  "added",
  "updated",
  "coming_soon",
  "price_asc",
  "price_desc",
  "rating",
  "top_rated",
  "title",
]);
const LIST_FIELDS = [
  "taxonomy",
  "categories",
  "languages",
  "formats",
  "publishers",
  "series",
  "contributorIds",
  "seriesIds",
  "publisherIds",
  "imprintIds",
] as const;
const SINGLE_FIELDS = [
  "query",
  "topic",
  "currency",
  "minPrice",
  "maxPrice",
  "subscription",
  "library",
  "minRating",
  "minReviews",
  "publishedAfter",
  "publishedBefore",
  "preorder",
  "newRelease",
  "deals",
  "availability",
  "territory",
  "sort",
  "page",
  "limit",
] as const;
const INPUT_FIELDS = new Set<string>([...LIST_FIELDS, ...SINGLE_FIELDS]);

function normalizedList(values: unknown): string[] {
  if (!Array.isArray(values) || values.length > 20)
    throw new Error("Unreviewed catalog projection list");
  if (
    !values.every(
      (value) => typeof value === "string" && value.length > 0 && value.length <= 300,
    )
  )
    throw new Error("Invalid catalog projection list element");
  return [...new Set(values)].sort();
}

function normalizedNumber(
  value: number | undefined,
  maximum: number,
): number | null {
  if (value === undefined) return null;
  if (!Number.isFinite(value) || value < 0 || value > maximum)
    throw new Error("Invalid catalog projection numeric filter");
  return value;
}

function normalizedBoolean(value: boolean | undefined): boolean | null {
  if (value === undefined) return null;
  if (typeof value !== "boolean")
    throw new Error("Invalid catalog projection boolean filter");
  return value;
}

function normalizedDate(value: string | undefined): string | null {
  if (value === undefined) return null;
  if (!/^\\d{4}-\\d{2}-\\d{2}$/.test(value))
    throw new Error("Invalid catalog projection publication date");
  return value;
}

export async function catalogPresentationScope(
  input: SearchInput,
  manifestGeneration: string,
  userId: string | null,
): Promise<{ key: string; manifestGeneration: string; normalizedPageSize: number }> {
  if (userId !== null) throw new Error("Private users may not share public catalog projections");
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("Invalid search input for catalog projection");
  if (Object.keys(input).some((key) => !INPUT_FIELDS.has(key)))
    throw new Error("Unreviewed catalog input must not reuse a public projection");
  if (!/^[a-f0-9]{64}$/.test(manifestGeneration))
    throw new Error("Unversioned public catalog projection");
  if (
    !Number.isSafeInteger(input.page) ||
    input.page < 1 ||
    input.page > 500 ||
    !Number.isSafeInteger(input.limit) ||
    input.limit < 1 ||
    input.limit > 60
  )
    throw new Error("Invalid public catalog pagination");
  if (!SORTS.has(input.sort) || !/^[A-Z]{2}$/.test(input.territory))
    throw new Error("Unreviewed catalog territory or sort");
  const currency = input.currency ?? "USD";
  if (!/^[A-Z]{3}$/.test(currency))
    throw new Error("Invalid public catalog currency");
  if (
    typeof input.query !== "string" ||
    input.query.length > 160 ||
    (input.topic !== undefined &&
      (typeof input.topic !== "string" || input.topic.length > 100))
  )
    throw new Error("Invalid public search terms");
  const facets = Object.fromEntries(LIST_FIELDS.map((key) => [key, normalizedList(input[key])]));
  const normalized = {
    schema: SCHEMA,
    generation: manifestGeneration,
    // page is deliberately omitted: a signed continuation spans pages.
    // limit is NOT omitted: changing page size changes cursor semantics.
    query: input.query,
    topic: input.topic ?? null,
    ...facets,
    currency,
    minPrice: normalizedNumber(input.minPrice, 1_000_000_000),
    maxPrice: normalizedNumber(input.maxPrice, 1_000_000_000),
    subscription: normalizedBoolean(input.subscription),
    library: normalizedBoolean(input.library),
    minRating: normalizedNumber(input.minRating, 5),
    minReviews: normalizedNumber(input.minReviews, 10_000_000),
    publishedAfter: normalizedDate(input.publishedAfter),
    publishedBefore: normalizedDate(input.publishedBefore),
    preorder: normalizedBoolean(input.preorder),
    newRelease: normalizedBoolean(input.newRelease),
    deals: normalizedBoolean(input.deals),
    availability: input.availability ?? "available",
    territory: input.territory,
    sort: input.sort,
    limit: input.limit,
  };
  if (
    typeof normalized.availability !== "string" ||
    normalized.availability.length > 30
  )
    throw new Error("Invalid catalog availability filter");
  const encoded = new TextEncoder().encode(JSON.stringify(normalized));
  if (encoded.byteLength > 8192)
    throw new Error("Oversized catalog projection scope");
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", encoded));
  return {
    key:
      "catalog-projection:v1:" +
      Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join(""),
    manifestGeneration,
    normalizedPageSize: input.limit,
  };
}
