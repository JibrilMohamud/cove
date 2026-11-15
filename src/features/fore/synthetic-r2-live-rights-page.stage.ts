import type { CatalogBook } from "./client";
import { isPrimaryD1Overload } from "../../lib/primary-d1-overload";
import {
  canonicalBooksByProductIds,
  type CatalogDB,
  type PrimaryStorefrontAuthorityRow,
} from "./catalog-model.server";
import type { PresentationR2Bucket } from "./search-presentation-r2.server";

/**
 * EXPERIMENTAL SYNTHETIC STAGING ONLY. R2 holds public display strings and a
 * 96-item rank proposal, NEVER rights, offer amounts, DRM, EPUB URLs or
 * entitlements. Every displayed item and its CURRENT retail offer must pass
 * one fresh primary-D1 rights/market/offer statement on EVERY request.
 *
 * This is intentionally not a drop-in production catalog replacement:
 * the full commercial DTO/parity and a real synthetic offer fixture must be
 * certified before any customer routing or flag activation is considered.
 */
const SYNTHETIC_DB = "e4cbb0ef-6288-4fa1-9dbb-fb42fe01d4f3";
const STAGE_HOST = "cove-presentation-r2-proof-20261114.cove-jibrilmohamud.workers.dev";
const STAGE_PATH = "/api/fore/__perf/private-r2-live-rights";
const OBJECT_KEY = "public-presentation/synthetic-ranked-books-v1/US/USD/popular.json";
const TTL_MS = 120_000;
const MAX_BYTES = 256 * 1024;
const ITEM_COUNT = 96;
const FAST_CANDIDATE_COUNT = 32;
const PAGE_COUNT = 24;

export type SyntheticDisplayRow = {
  productId: string;
  editionId: string;
  title: string;
  subtitle: string;
  authors: CatalogBook["authors"];
  subjects: string[];
  bookshelves: string[];
  languages: string[];
  imageUrl?: string;
  publisher?: string;
  contributors?: NonNullable<CatalogBook["contributors"]>;
  summaries?: string[];
  publisherId?: string;
  publisherSlug?: string;
  imprint?: string;
  imprintId?: string;
  imprintSlug?: string;
  isbn13?: string;
  publicationDate?: string;
  originalPublicationDate?: string;
  releaseDate?: string;
  preorderDate?: string;
  editionNumber?: string;
  originalLanguage?: string;
  ageRange?: { min?: number; max?: number };
  contentWarnings?: string[];
  pageEstimate?: number;
  wordCount?: number;
  readingTimeMinutes?: number;
  publisherDescription?: string;
  editorialReviews?: string;
  series?: NonNullable<CatalogBook["series"]>;
  externalIdentifiers?: CatalogBook["externalIdentifiers"];
  fileSizeBytes?: number;
  epubVersion?: string;
  layout?: string;
  accessibility?: CatalogBook["accessibility"];
  formatProfile?: CatalogBook["formatProfile"];
  sourceProject?: string;
  sourceUrl?: string;
  sourceLicenseUrl?: string;
  aiDisclosure?: CatalogBook["aiDisclosure"];
};

type Snapshot = {
  schema: "cove.synthetic-display-v1";
  territory: "US";
  currency: "USD";
  expiresAt: number;
  publicMetadataRevision: string;
  items: SyntheticDisplayRow[];
};

export type SyntheticRightsPresentationEnv = {
  DB: CatalogDB;
  COVE_PUBLIC_PRESENTATION_CACHE?: PresentationR2Bucket;
  FORE_GUEST_COMPACT_STAGE?: string;
  FORE_GUEST_R2_DISPLAY_STAGE?: string;
  FORE_GUEST_COMPACT_SYNTHETIC_D1_ID?: string;
  COVE_SYNTHETIC_STAGING_ONLY?: string;
  FORE_BACKEND_TOKEN?: string;
};

// Decimal TEXT avoids lossy JavaScript conversion of SQLite 64-bit revisions.
const validPublicMetadataRevision = (v: unknown): v is string =>
  typeof v === "string" && /^[1-9][0-9]{0,18}$/.test(v);

const PUBLIC_METADATA_REVISION_SQL =
  "SELECT CAST(revision AS TEXT) AS public_metadata_revision FROM cove_synthetic_public_metadata_revision WHERE id=1";

const identifier = (x: unknown): x is string =>
  typeof x === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{1,159}$/.test(x);
function hasControlCharacter(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 32 || code === 127) return true;
  }
  return false;
}
const shortText = (x: unknown, max: number): x is string =>
  typeof x === "string" && x.length <= max && !hasControlCharacter(x);
const strings = (x: unknown, max: number) =>
  Array.isArray(x) && x.length <= max && x.every((v) => shortText(v, 240));
const IMAGE_TYPES = ["image/jpeg", "image/png"];
const ALLOWED_KEYS = new Set([
  "productId",
  "editionId",
  "title",
  "subtitle",
  "authors",
  "subjects",
  "bookshelves",
  "languages",
  "imageUrl",
  "publisher",
  "contributors",
  "summaries",
  "publisherId",
  "publisherSlug",
  "imprint",
  "imprintId",
  "imprintSlug",
  "isbn13",
  "publicationDate",
  "originalPublicationDate",
  "releaseDate",
  "preorderDate",
  "editionNumber",
  "originalLanguage",
  "ageRange",
  "contentWarnings",
  "pageEstimate",
  "wordCount",
  "readingTimeMinutes",
  "publisherDescription",
  "editorialReviews",
  "series",
  "externalIdentifiers",
  "fileSizeBytes",
  "epubVersion",
  "layout",
  "accessibility",
  "formatProfile",
  "sourceProject",
  "sourceUrl",
  "sourceLicenseUrl",
  "aiDisclosure",
]);

const optionalText = (value: unknown, max: number) =>
  value === undefined || value === null || shortText(value, max);
const optionalInt = (value: unknown) =>
  value === undefined ||
  value === null ||
  (Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= 1_000_000_000);
const strictKeys = (value: object, fields: string[]) =>
  Object.keys(value).every((field) => fields.includes(field));
function validContributor(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const c = value as NonNullable<CatalogBook["contributors"]>[number];
  return (
    strictKeys(c, ["id", "slug", "name", "role", "position"]) &&
    shortText(c.name, 240) &&
    optionalText(c.id, 160) &&
    optionalText(c.slug, 160) &&
    optionalText(c.role, 100) &&
    optionalInt(c.position)
  );
}
function validPublicObject(value: unknown, maxChars: number): boolean {
  if (value === undefined) return true;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const serialized = JSON.stringify(value);
  return typeof serialized === "string" && serialized.length <= maxChars;
}
function validPublicIdentifiers(value: unknown): boolean {
  if (value === undefined) return true;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const groups = value as NonNullable<CatalogBook["externalIdentifiers"]>;
  if (!strictKeys(groups, ["product", "edition", "work"])) return false;
  return [groups.product, groups.edition, groups.work].every(
    (group) =>
      group === undefined ||
      (validPublicObject(group, 8000) &&
        Object.keys(group).length <= 50 &&
        Object.entries(group).every(
          ([key, detail]) => shortText(key, 100) && shortText(detail, 512),
        )),
  );
}
function validSeries(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entry = value as NonNullable<CatalogBook["series"]>[number];
  return (
    strictKeys(entry, [
      "id",
      "slug",
      "name",
      "position",
      "label",
      "relationship",
      "readingOrder",
    ]) &&
    identifier(entry.id) &&
    shortText(entry.name, 400) &&
    optionalText(entry.slug, 160) &&
    optionalText(entry.label, 160) &&
    optionalText(entry.relationship, 100) &&
    optionalInt(entry.position) &&
    optionalInt(entry.readingOrder)
  );
}

function permittedImage(x: unknown): x is string {
  return (
    typeof x === "string" &&
    x.length <= 2048 &&
    (x.startsWith("https://") || (x.startsWith("/") && !x.startsWith("//") && !x.includes("\\")))
  );
}

function validRow(x: unknown): x is SyntheticDisplayRow {
  if (!x || typeof x !== "object" || Array.isArray(x)) return false;
  const v = x as Partial<SyntheticDisplayRow>;
  return (
    Object.keys(v).every((key) => ALLOWED_KEYS.has(key)) &&
    identifier(v.productId) &&
    identifier(v.editionId) &&
    shortText(v.title, 400) &&
    v.title.length > 0 &&
    shortText(v.subtitle, 400) &&
    Array.isArray(v.authors) &&
    v.authors.length <= 30 &&
    v.authors.every(
      (a) =>
        a &&
        typeof a === "object" &&
        strictKeys(a, ["name", "id", "slug"]) &&
        shortText(a.name, 240) &&
        optionalText(a.id, 160) &&
        optionalText(a.slug, 160),
    ) &&
    strings(v.subjects, 30) &&
    strings(v.bookshelves, 30) &&
    strings(v.languages, 12) &&
    (v.imageUrl === undefined || permittedImage(v.imageUrl)) &&
    optionalText(v.publisher, 240) &&
    (v.contributors === undefined ||
      (Array.isArray(v.contributors) &&
        v.contributors.length <= 30 &&
        v.contributors.every(validContributor))) &&
    (v.summaries === undefined ||
      (Array.isArray(v.summaries) &&
        v.summaries.length <= 6 &&
        v.summaries.every((summary) => shortText(summary, 4000)))) &&
    optionalText(v.publisherId, 160) &&
    optionalText(v.publisherSlug, 160) &&
    optionalText(v.imprint, 240) &&
    optionalText(v.imprintId, 160) &&
    optionalText(v.imprintSlug, 160) &&
    optionalText(v.isbn13, 32) &&
    optionalText(v.publicationDate, 50) &&
    optionalText(v.originalPublicationDate, 50) &&
    optionalText(v.releaseDate, 50) &&
    optionalText(v.preorderDate, 50) &&
    optionalText(v.editionNumber, 80) &&
    optionalText(v.originalLanguage, 30) &&
    (v.ageRange === undefined ||
      (v.ageRange &&
        typeof v.ageRange === "object" &&
        !Array.isArray(v.ageRange) &&
        strictKeys(v.ageRange, ["min", "max"]) &&
        optionalInt(v.ageRange.min) &&
        optionalInt(v.ageRange.max))) &&
    (v.contentWarnings === undefined ||
      (Array.isArray(v.contentWarnings) &&
        v.contentWarnings.length <= 24 &&
        v.contentWarnings.every((warning) => shortText(warning, 200)))) &&
    optionalInt(v.pageEstimate) &&
    optionalInt(v.wordCount) &&
    optionalInt(v.readingTimeMinutes) &&
    optionalText(v.publisherDescription, 6000) &&
    optionalText(v.editorialReviews, 6000) &&
    (v.series === undefined ||
      (Array.isArray(v.series) && v.series.length <= 24 && v.series.every(validSeries))) &&
    validPublicIdentifiers(v.externalIdentifiers) &&
    optionalInt(v.fileSizeBytes) &&
    optionalText(v.epubVersion, 80) &&
    optionalText(v.layout, 80) &&
    validPublicObject(v.accessibility, 24000) &&
    validPublicObject(v.formatProfile, 16000) &&
    optionalText(v.sourceProject, 200) &&
    optionalText(v.sourceUrl, 2048) &&
    optionalText(v.sourceLicenseUrl, 2048) &&
    validPublicObject(v.aiDisclosure, 8000)
  );
}

function validSnapshot(raw: unknown, now: number): raw is Snapshot {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
  const v = raw as Partial<Snapshot>;
  return (
    Object.keys(v).every((key) =>
      ["schema", "territory", "currency", "expiresAt", "publicMetadataRevision", "items"].includes(key),
    ) &&
    v.schema === "cove.synthetic-display-v1" &&
    v.territory === "US" &&
    v.currency === "USD" &&
    validPublicMetadataRevision(v.publicMetadataRevision) &&
    Number.isSafeInteger(v.expiresAt) &&
    (v.expiresAt as number) > now &&
    (v.expiresAt as number) <= now + TTL_MS &&
    Array.isArray(v.items) &&
    v.items.length === ITEM_COUNT &&
    v.items.every(validRow) &&
    new Set(v.items.map((item) => item.productId)).size === ITEM_COUNT
  );
}

export function buildSyntheticDisplayObject(
  books: CatalogBook[],
  now: number,
  publicMetadataRevision: string,
): string {
  if (!validPublicMetadataRevision(publicMetadataRevision))
    throw new Error("Missing trusted current public metadata revision");
  if (books.length !== ITEM_COUNT) throw new Error("Need exactly 96 ranked display candidates");
  const items = books.map((book): SyntheticDisplayRow => {
    const image = IMAGE_TYPES.map((type) => book.formats[type]).find(permittedImage);
    return {
      productId: String(book.productId || ""),
      editionId: String(book.editionId || ""),
      title: book.title,
      subtitle: book.subtitle || "",
      authors: book.authors.map(({ id, slug, name }) => ({
        ...(id !== undefined ? { id } : {}),
        ...(slug !== undefined ? { slug } : {}),
        name,
      })),
      subjects: book.subjects,
      bookshelves: book.bookshelves,
      languages: book.languages,
      ...(image ? { imageUrl: image } : {}),
      ...(book.publisher ? { publisher: book.publisher } : {}),
      ...(book.contributors !== undefined ? { contributors: book.contributors } : {}),
      ...(book.summaries !== undefined ? { summaries: book.summaries } : {}),
      ...(book.publisherId !== undefined ? { publisherId: book.publisherId } : {}),
      ...(book.publisherSlug !== undefined ? { publisherSlug: book.publisherSlug } : {}),
      ...(book.imprint !== undefined ? { imprint: book.imprint } : {}),
      ...(book.imprintId !== undefined ? { imprintId: book.imprintId } : {}),
      ...(book.imprintSlug !== undefined ? { imprintSlug: book.imprintSlug } : {}),
      ...(book.isbn13 !== undefined ? { isbn13: book.isbn13 } : {}),
      ...(book.publicationDate !== undefined ? { publicationDate: book.publicationDate } : {}),
      ...(book.originalPublicationDate !== undefined
        ? { originalPublicationDate: book.originalPublicationDate }
        : {}),
      ...(book.releaseDate !== undefined ? { releaseDate: book.releaseDate } : {}),
      ...(book.preorderDate !== undefined ? { preorderDate: book.preorderDate } : {}),
      ...(book.editionNumber !== undefined ? { editionNumber: book.editionNumber } : {}),
      ...(book.originalLanguage !== undefined ? { originalLanguage: book.originalLanguage } : {}),
      ...(book.ageRange !== undefined ? { ageRange: book.ageRange } : {}),
      ...(book.contentWarnings !== undefined ? { contentWarnings: book.contentWarnings } : {}),
      ...(book.pageEstimate !== undefined ? { pageEstimate: book.pageEstimate } : {}),
      ...(book.wordCount !== undefined ? { wordCount: book.wordCount } : {}),
      ...(book.readingTimeMinutes !== undefined
        ? { readingTimeMinutes: book.readingTimeMinutes }
        : {}),
      ...(book.publisherDescription !== undefined
        ? { publisherDescription: book.publisherDescription }
        : {}),
      ...(book.editorialReviews !== undefined ? { editorialReviews: book.editorialReviews } : {}),
      ...(book.series !== undefined ? { series: book.series } : {}),
      ...(book.externalIdentifiers !== undefined
        ? { externalIdentifiers: book.externalIdentifiers }
        : {}),
      ...(book.fileSizeBytes !== undefined ? { fileSizeBytes: book.fileSizeBytes } : {}),
      ...(book.epubVersion !== undefined ? { epubVersion: book.epubVersion } : {}),
      ...(book.layout !== undefined ? { layout: book.layout } : {}),
      ...(book.accessibility !== undefined ? { accessibility: book.accessibility } : {}),
      ...(book.formatProfile !== undefined ? { formatProfile: book.formatProfile } : {}),
      ...(book.sourceProject !== undefined ? { sourceProject: book.sourceProject } : {}),
      ...(book.sourceUrl !== undefined ? { sourceUrl: book.sourceUrl } : {}),
      ...(book.sourceLicenseUrl !== undefined ? { sourceLicenseUrl: book.sourceLicenseUrl } : {}),
      ...(book.aiDisclosure !== undefined ? { aiDisclosure: book.aiDisclosure } : {}),
    };
  });
  const state: Snapshot = {
    schema: "cove.synthetic-display-v1",
    territory: "US",
    currency: "USD",
    expiresAt: now + TTL_MS,
    publicMetadataRevision,
    items,
  };
  if (!validSnapshot(state, now)) throw new Error("Unsafe display-only snapshot");
  const body = JSON.stringify(state);
  if (new TextEncoder().encode(body).byteLength > MAX_BYTES)
    throw new Error("Display snapshot exceeds strict bound");
  return body;
}

function constantTimeGate(value: string | null, expected: string | undefined) {
  if (!expected || !/^[a-f0-9]{64}$/.test(expected) || !value || value.length !== 64) return false;
  let difference = 0;
  for (let i = 0; i < 64; i++) difference |= value.charCodeAt(i) ^ expected.charCodeAt(i);
  return difference === 0;
}

function authorizedSyntheticRequest(
  request: Request,
  env: SyntheticRightsPresentationEnv,
): boolean {
  const url = new URL(request.url);
  return (
    url.hostname === STAGE_HOST &&
    url.search === "" &&
    !request.headers.has("cookie") &&
    !request.headers.has("authorization") &&
    !request.headers.has("x-fore-authenticated-user-id") &&
    request.headers.get("x-cove-client-country") === "US" &&
    constantTimeGate(request.headers.get("x-cove-backend-token"), env.FORE_BACKEND_TOKEN) &&
    env.COVE_SYNTHETIC_STAGING_ONLY === SYNTHETIC_DB &&
    env.FORE_GUEST_COMPACT_STAGE === "1" &&
    env.FORE_GUEST_R2_DISPLAY_STAGE === "1" &&
    env.FORE_GUEST_COMPACT_SYNTHETIC_D1_ID === SYNTHETIC_DB &&
    !!env.COVE_PUBLIC_PRESENTATION_CACHE &&
    typeof env.DB?.prepare === "function"
  );
}

export function eligibleSyntheticR2Page(
  request: Request,
  env: SyntheticRightsPresentationEnv,
): boolean {
  return (
    new URL(request.url).pathname === STAGE_PATH &&
    request.method === "GET" &&
    authorizedSyntheticRequest(request, env)
  );
}

/**
 * One explicit, isolated candidate warm-up, never a per-request hydration or
 * background refresh. The source is existing nonauthorizing synthetic public
 * metadata. No real customers, rights, offers, auth or protected data are
 * exported to R2.
 */
export async function seedSyntheticR2Display(
  env: SyntheticRightsPresentationEnv,
  now = () => Date.now(),
): Promise<boolean> {
  if (!env.COVE_PUBLIC_PRESENTATION_CACHE) return false;
  if (
    env.COVE_SYNTHETIC_STAGING_ONLY !== SYNTHETIC_DB ||
    env.FORE_GUEST_COMPACT_SYNTHETIC_D1_ID !== SYNTHETIC_DB ||
    env.FORE_GUEST_COMPACT_STAGE !== "1" ||
    env.FORE_GUEST_R2_DISPLAY_STAGE !== "1"
  )
    return false;
  // Capture the metadata generation before and after canonical R2
  // materialization. If a source license, attribution or public AI disclosure
  // changes during the multi-query seed, NEVER publish a mixed-generation
  // snapshot. This lookup is seed-only, not in the request hot path.
  const before = await env.DB.prepare(PUBLIC_METADATA_REVISION_SQL).first<{
    public_metadata_revision: string | null;
  }>();
  if (!validPublicMetadataRevision(before?.public_metadata_revision)) return false;
  const result = await env.DB.prepare(
    `SELECT p.id product_id,e.id edition_id
     FROM catalog_search_documents d INDEXED BY idx_search_popular_stable
     JOIN products p ON p.id=d.product_id
     JOIN editions e ON e.id=p.edition_id
     ORDER BY d.fore_bestseller_score DESC,d.external_book_id ASC,d.product_id ASC
     LIMIT 96`,
  ).all<{ product_id: string; edition_id: string }>();
  if (
    result.results.length !== ITEM_COUNT ||
    result.results.some((row) => !row.product_id.startsWith("perf-synth-")) ||
    result.results.some((row) => !row.edition_id.startsWith("perf-synth-"))
  )
    return false;
  // Seed once, never on a customer request. Use Cove's EXACT full canonical
  // mapper rather than invented author/summary placeholders. Only the narrow
  // public display allowlist below is serialized to R2; even if the canonical
  // read includes an active offer, EPUB link or DRM it is discarded.
  const books = await canonicalBooksByProductIds(
    env.DB,
    result.results.map((row) => row.product_id),
  );
  if (
    books.length !== ITEM_COUNT ||
    books.some(
      (book, index) =>
        book.productId !== result.results[index].product_id ||
        book.editionId !== result.results[index].edition_id ||
        book.sourceName === "upload" ||
        book.uploaded === true,
    )
  )
    return false;
  const after = await env.DB.prepare(PUBLIC_METADATA_REVISION_SQL).first<{
    public_metadata_revision: string | null;
  }>();
  if (after?.public_metadata_revision !== before.public_metadata_revision) return false;
  const body = buildSyntheticDisplayObject(books, now(), before.public_metadata_revision);
  const bucket = env.COVE_PUBLIC_PRESENTATION_CACHE;
  const old = await bucket.get(OBJECT_KEY);
  const saved = await bucket.put(OBJECT_KEY, body, {
    onlyIf: old ? { etagMatches: old.etag } : { etagDoesNotMatch: "*" },
  });
  return !!saved;
}

export async function handleSyntheticR2LiveRightsStage(
  request: Request,
  env: SyntheticRightsPresentationEnv,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== STAGE_PATH && url.pathname !== STAGE_PATH + "/seed") return null;
  const seed = url.pathname === STAGE_PATH + "/seed";
  if (
    !authorizedSyntheticRequest(request, env) ||
    (seed && (request.method !== "POST" || request.body !== null)) ||
    (!seed && request.method !== "GET")
  )
    return new Response(null, { status: 404, headers: { "cache-control": "no-store" } });
  try {
    if (seed) {
      const written = await seedSyntheticR2Display(env);
      return Response.json(
        { seeded: written, releaseCertified: false },
        { status: written ? 200 : 503, headers: { "cache-control": "no-store" } },
      );
    }
    const result = await syntheticR2PageWithLiveRights(request, env);
    if (!result)
      return new Response(null, {
        status: 503,
        headers: {
          "cache-control": "no-store",
          "x-cove-stage-failure-class": "invalid-snapshot-or-authority-witness",
        },
      });
    return Response.json(
      {
        results: result.books,
        hasMore: result.hasMore,
        mode: "r2-live-retail",
        releaseCertified: false,
      },
      {
        status: 200,
        headers: {
          "cache-control": "no-store",
          "x-cove-persistence": "d1-live-retail-r2-display-synthetic",
        },
      },
    );
  } catch (error) {
    // Only a low-cardinality failure class leaves the explicitly guarded
    // synthetic host. Never leak SQL, exceptions, identities or credentials.
    // Production has no route/binding that can enable this diagnostic.
    return new Response(null, {
      status: 503,
      headers: {
        "cache-control": "no-store",
        "x-cove-stage-failure-class": isPrimaryD1Overload(error)
          ? "d1-7429-resource-window"
          : "primary-or-stage-failure",
      },
    });
  }
}

function currentOffer(row: PrimaryStorefrontAuthorityRow): CatalogBook["offer"] | null {
  try {
    const offer = JSON.parse(row.offer_json || "null") as CatalogBook["offer"] | null;
    return offer &&
      shortText(offer.type, 64) &&
      offer.type.length > 0 &&
      offer.currency === "USD" &&
      Number.isSafeInteger(offer.amountMinor) &&
      (offer.amountMinor as number) >= 0
      ? offer
      : null;
  } catch {
    return null;
  }
}

/**
 * Canonical catalog JSON values are read fresh from primary D1, not from R2.
 * Refuse malformed, oversized or unexpected identifier maps instead of
 * treating corrupt metadata as public approval. No asset origin, secret key,
 * customer, entitlement or commercial right is ever included in this parser.
 */
/**
 * Synthetic-only live retail SELECT. The former prototype selected 25
 * territorial candidates BEFORE checking current offers. If one of those
 * candidates lost its offer, it returned a 503 instead of using candidate 26.
 *
 * Include the offer's current active USD retail state INSIDE the primary-D1
 * candidate selection; retain one current-statement snapshot for ordering and
 * pricing. R2 supplies neither eligibility nor price. No production handler
 * calls this function.
 */
type SyntheticExtendedAuthorityRow = PrimaryStorefrontAuthorityRow & {
  work_id: string;
  work_public_id: string | null;
  source_name: string;
  source_external_id: string;
  release_status: string;
  drm_status: string | null;
  downloadable: number;
  subscription_eligible: number;
  library_eligible: number;
  download_count: number | null;
  epub_storage_status: string | null;
  has_epub_object: number;
  has_epub_source: number;
  public_metadata_revision: string | null;
};

export async function authorizeOfferBearingSyntheticPage(
  db: CatalogDB,
  ids: string[],
): Promise<SyntheticExtendedAuthorityRow[]> {
  if (
    (ids.length !== FAST_CANDIDATE_COUNT && ids.length !== ITEM_COUNT) ||
    ids.some((id) => !identifier(id)) ||
    new Set(ids).size !== ids.length
  )
    throw new Error("Invalid synthetic retail candidates");
  const result = await db
    .prepare(
      `WITH market(currency) AS MATERIALIZED (
        SELECT COALESCE(
          (SELECT default_currency FROM storefront_markets
           WHERE country_code=? AND market_status='active'),
          (SELECT default_currency FROM storefront_markets
           WHERE country_code='US' AND market_status='active'))
      ), metadata_revision AS MATERIALIZED (
        SELECT CAST(revision AS TEXT) current_revision
        FROM cove_synthetic_public_metadata_revision WHERE id=1
      ), candidates AS MATERIALIZED (
        SELECT value product_id,CAST(key AS INTEGER) position FROM json_each(?)
      ), authorized AS MATERIALIZED (
        SELECT p.id product_id,p.public_id product_public_id,p.edition_id,
          e.public_id edition_public_id,p.source_name,p.source_external_id,
          e.work_id,w.public_id work_public_id,e.release_status,e.drm_status,
          e.downloadable,e.subscription_eligible,e.library_eligible,
          d.download_count,c.position,d.currency
        FROM candidates c CROSS JOIN products p ON p.id=c.product_id
        JOIN editions e ON e.id=p.edition_id
        JOIN works w ON w.id=e.work_id
        JOIN catalog_search_documents d ON d.product_id=p.id
        WHERE p.storefront_status='active' AND p.source_name<>'upload'
          AND e.release_status IN ('available','preorder')
          AND d.suppressed=0 AND d.availability='available'
          AND d.currency=? AND ?=(SELECT currency FROM market)
          AND EXISTS (SELECT 1 FROM retail_product_availability_rows rpa
            WHERE rpa.product_id=p.id AND rpa.territory_code=?)
          AND EXISTS (SELECT 1 FROM offers offer_exists
            WHERE offer_exists.product_id=p.id
              AND offer_exists.sales_channel='retail'
              AND offer_exists.currency=d.currency
              AND offer_exists.active=1
              AND (offer_exists.starts_at IS NULL
                OR offer_exists.starts_at<=datetime('now'))
              AND (offer_exists.ends_at IS NULL
                OR offer_exists.ends_at>datetime('now')))
        ORDER BY c.position LIMIT 25
      )
      SELECT a.product_id,a.product_public_id,a.edition_id,a.edition_public_id,
        a.source_name,a.source_external_id,a.work_id,a.work_public_id,
        a.release_status,a.drm_status,a.downloadable,
        a.subscription_eligible,a.library_eligible,a.download_count,
        (SELECT json_object('type',o.offer_type,'currency',o.currency,
          'amountMinor',o.amount_minor)
         FROM offers o WHERE o.product_id=a.product_id
           AND o.sales_channel='retail' AND o.currency=a.currency AND o.active=1
           AND (o.starts_at IS NULL OR o.starts_at<=datetime('now'))
           AND (o.ends_at IS NULL OR o.ends_at>datetime('now'))
         ORDER BY o.created_at DESC LIMIT 1) offer_json,
        (SELECT gc.epub_status FROM gutenberg_source_cache gc
         WHERE a.source_name='gutenberg' AND gc.id=a.source_external_id
         LIMIT 1) epub_storage_status,
        EXISTS (SELECT 1 FROM digital_assets da JOIN asset_versions av
          ON av.id=da.current_version_id WHERE da.edition_id=a.edition_id
          AND da.kind='epub' AND av.object_key IS NOT NULL
          AND av.object_key<>'') has_epub_object,
        EXISTS (SELECT 1 FROM digital_assets da JOIN asset_versions av
          ON av.id=da.current_version_id WHERE da.edition_id=a.edition_id
          AND da.kind='epub' AND av.source_url IS NOT NULL
          AND av.source_url<>'') has_epub_source,
        (SELECT current_revision FROM metadata_revision) public_metadata_revision
      FROM authorized a ORDER BY a.position`,
    )
    .bind("US", JSON.stringify(ids), "USD", "USD", "US")
    .all<SyntheticExtendedAuthorityRow>();
  return result.results;
}

export async function syntheticR2PageWithLiveRights(
  request: Request,
  env: SyntheticRightsPresentationEnv,
  now = () => Date.now(),
): Promise<{ books: CatalogBook[]; hasMore: true } | null> {
  if (!eligibleSyntheticR2Page(request, env)) return null;
  let snapshot: Snapshot;
  try {
    const object = await env.COVE_PUBLIC_PRESENTATION_CACHE!.get(OBJECT_KEY);
    if (!object || (object.size !== undefined && object.size > MAX_BYTES)) return null;
    const text = await object.text();
    if (new TextEncoder().encode(text).byteLength > MAX_BYTES) return null;
    const decoded: unknown = JSON.parse(text);
    if (!validSnapshot(decoded, now())) return null;
    snapshot = decoded;
  } catch {
    // R2 failure cannot result in any cached positive rights decision.
    return null;
  }

  // D1 exceptions deliberately propagate: a primary outage cannot be rescued
  // by presentation content, and cannot ever be considered authorization.
  const rankedIds = snapshot.items.map((item) => item.productId);
  // Most pages need at most 25 fresh live witnesses. D1 scans every input
  // candidate in the authorized materialized CTE: 96 candidates cost ~1,437
  // rows read on the isolated fixture; 32 cost ~549. On withdrawal/sparse
  // rights, recheck all 96 in ONE NEW primary-D1 statement and use ONLY its
  // results. Never combine an old positive decision with a newer fallback.
  let current = await authorizeOfferBearingSyntheticPage(
    env.DB,
    rankedIds.slice(0, FAST_CANDIDATE_COUNT),
  );
  if (current.length < PAGE_COUNT + 1)
    current = await authorizeOfferBearingSyntheticPage(env.DB, rankedIds);
  if (
    current.length !== PAGE_COUNT + 1 ||
    new Set(current.map((row) => row.product_id)).size !== PAGE_COUNT + 1 ||
    current.some(
      (row) =>
        !validPublicMetadataRevision(row.public_metadata_revision) ||
        row.public_metadata_revision !== snapshot.publicMetadataRevision,
    )
  )
    return null;
  const byId = new Map(snapshot.items.map((item) => [item.productId, item]));
  const rank = new Map(snapshot.items.map((item, index) => [item.productId, index]));
  for (let i = 1; i < current.length; i++)
    if ((rank.get(current[i - 1].product_id) ?? 999) >= (rank.get(current[i].product_id) ?? -1))
      return null;
  const books: CatalogBook[] = [];
  for (const row of current) {
    const display = byId.get(row.product_id);
    const offer = currentOffer(row);
    // An edition, offer, primary-state or work identity mismatch always
    // denies the page. These flags come from CURRENT D1, not from R2.
    if (
      !display ||
      display.editionId !== row.edition_id ||
      !offer ||
      !identifier(row.work_id) ||
      (row.work_public_id !== null && !identifier(row.work_public_id)) ||
      !shortText(row.source_name, 80) ||
      !shortText(row.source_external_id, 160) ||
      !["available", "preorder"].includes(row.release_status) ||
      (row.drm_status !== null && !shortText(row.drm_status, 80)) ||
      ![0, 1].includes(row.downloadable) ||
      ![0, 1].includes(row.subscription_eligible) ||
      ![0, 1].includes(row.library_eligible) ||
      ![0, 1].includes(row.has_epub_object) ||
      ![0, 1].includes(row.has_epub_source) ||
      (row.epub_storage_status !== null && !shortText(row.epub_storage_status, 80)) ||
      (row.download_count !== null &&
        (!Number.isSafeInteger(row.download_count) || row.download_count < 0))
    )
      return null;
    // EXACT canonicalRowBook reading-availability semantics, but with
    // only current primary-D1 asset-existence booleans. Never return,
    // serialize or cache a private object key or signed EPUB origin.
    const sourceAvailable = row.has_epub_source === 1;
    const objectStored = row.has_epub_object === 1;
    const readingState =
      !objectStored && ["failed", "unavailable"].includes(row.epub_storage_status || "")
        ? "unavailable"
        : objectStored
          ? "stored"
          : sourceAvailable &&
              row.source_name === "gutenberg" &&
              !/^(pgca|pgau|pgeu)_/.test(row.source_external_id)
            ? "on-demand"
            : "processing";
    const formats: CatalogBook["formats"] = display.imageUrl
      ? { [display.imageUrl.endsWith(".png") ? "image/png" : "image/jpeg"]: display.imageUrl }
      : {};
    if (readingState !== "unavailable" && (objectStored || sourceAvailable))
      formats["application/epub+zip"] =
        `/api/fore/books/${encodeURIComponent(row.product_public_id || row.source_external_id)}/epub`;
    books.push({
      id: row.product_public_id || row.product_id,
      productId: row.product_id,
      editionId: row.edition_id,
      publicProductId: row.product_public_id || undefined,
      publicEditionId: row.edition_public_id || undefined,
      workId: row.work_id,
      publicWorkId: row.work_public_id || undefined,
      sourceName: row.source_name,
      sourceExternalId: row.source_external_id,
      externalIdentifiers: display.externalIdentifiers || {
        product: {},
        edition: {},
        work: {},
      },
      sourceProject: display.sourceProject,
      sourceUrl: display.sourceUrl,
      sourceLicenseUrl: display.sourceLicenseUrl,
      copyright: row.source_name === "gutenberg" ? false : undefined,
      uploaded: row.source_name === "upload",
      releaseStatus: row.release_status,
      drmStatus: row.drm_status || "none",
      downloadable: row.downloadable === 1,
      subscriptionEligible: row.subscription_eligible === 1,
      libraryEligible: row.library_eligible === 1,
      title: display.title,
      subtitle: display.subtitle,
      authors: display.authors,
      contributors: display.contributors,
      summaries: display.summaries,
      subjects: display.subjects,
      bookshelves: display.bookshelves,
      languages: display.languages,
      formats,
      readingAvailability: { state: readingState },
      fileSizeBytes: display.fileSizeBytes,
      epubVersion: display.epubVersion,
      layout: display.layout || "reflowable",
      accessibility: display.accessibility,
      formatProfile: display.formatProfile,
      aiDisclosure: display.aiDisclosure,
      download_count: row.download_count ?? 0,
      publisher: display.publisher,
      publisherId: display.publisherId,
      publisherSlug: display.publisherSlug,
      imprint: display.imprint,
      imprintId: display.imprintId,
      imprintSlug: display.imprintSlug,
      isbn13: display.isbn13,
      publicationDate: display.publicationDate,
      originalPublicationDate: display.originalPublicationDate,
      releaseDate: display.releaseDate,
      preorderDate: display.preorderDate,
      editionNumber: display.editionNumber,
      originalLanguage: display.originalLanguage,
      ageRange: display.ageRange,
      contentWarnings: display.contentWarnings,
      pageEstimate: display.pageEstimate,
      wordCount: display.wordCount,
      readingTimeMinutes: display.readingTimeMinutes,
      publisherDescription: display.publisherDescription,
      editorialReviews: display.editorialReviews,
      series: display.series,
      offer,
      // Public reader-route presence is from fresh primary asset existence,
      // NOT an entitlement. Protected asset keys, CDN/source URLs and
      // offline licenses are not cached or returned by this probe.
    });
  }
  return { books: books.slice(0, PAGE_COUNT), hasMore: true };
}
