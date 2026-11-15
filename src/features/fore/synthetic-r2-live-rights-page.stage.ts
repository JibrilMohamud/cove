import type { CatalogBook } from "./client";
import { isPrimaryD1Overload } from "../../lib/primary-d1-overload";
import { type CatalogDB, type PrimaryStorefrontAuthorityRow } from "./catalog-model.server";
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
const PAGE_COUNT = 24;

export type SyntheticDisplayRow = {
  productId: string;
  editionId: string;
  title: string;
  subtitle: string;
  authors: Array<{ name: string }>;
  subjects: string[];
  bookshelves: string[];
  languages: string[];
  imageUrl?: string;
  publisher?: string;
};

type Snapshot = {
  schema: "cove.synthetic-display-v1";
  territory: "US";
  currency: "USD";
  expiresAt: number;
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
]);

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
      (a) => a && typeof a === "object" && Object.keys(a).length === 1 && shortText(a.name, 240),
    ) &&
    strings(v.subjects, 30) &&
    strings(v.bookshelves, 30) &&
    strings(v.languages, 12) &&
    (v.imageUrl === undefined || permittedImage(v.imageUrl)) &&
    (v.publisher === undefined || shortText(v.publisher, 240))
  );
}

function validSnapshot(raw: unknown, now: number): raw is Snapshot {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
  const v = raw as Partial<Snapshot>;
  return (
    Object.keys(v).every((key) =>
      ["schema", "territory", "currency", "expiresAt", "items"].includes(key),
    ) &&
    v.schema === "cove.synthetic-display-v1" &&
    v.territory === "US" &&
    v.currency === "USD" &&
    Number.isSafeInteger(v.expiresAt) &&
    (v.expiresAt as number) > now &&
    (v.expiresAt as number) <= now + TTL_MS &&
    Array.isArray(v.items) &&
    v.items.length === ITEM_COUNT &&
    v.items.every(validRow) &&
    new Set(v.items.map((item) => item.productId)).size === ITEM_COUNT
  );
}

export function buildSyntheticDisplayObject(books: CatalogBook[], now = Date.now()): string {
  if (books.length !== ITEM_COUNT) throw new Error("Need exactly 96 ranked display candidates");
  const items = books.map((book): SyntheticDisplayRow => {
    const image = IMAGE_TYPES.map((type) => book.formats[type]).find(permittedImage);
    return {
      productId: String(book.productId || ""),
      editionId: String(book.editionId || ""),
      title: book.title,
      subtitle: book.subtitle || "",
      authors: book.authors.map(({ name }) => ({ name })),
      subjects: book.subjects,
      bookshelves: book.bookshelves,
      languages: book.languages,
      ...(image ? { imageUrl: image } : {}),
      ...(book.publisher ? { publisher: book.publisher } : {}),
    };
  });
  const state: Snapshot = {
    schema: "cove.synthetic-display-v1",
    territory: "US",
    currency: "USD",
    expiresAt: now + TTL_MS,
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
  const result = await env.DB.prepare(
    `SELECT p.id product_id,e.id edition_id,e.title,e.subtitle,e.language
     FROM catalog_search_documents d INDEXED BY idx_search_popular_stable
     JOIN products p ON p.id=d.product_id
     JOIN editions e ON e.id=p.edition_id
     ORDER BY d.fore_bestseller_score DESC,d.external_book_id ASC,d.product_id ASC
     LIMIT 96`,
  ).all<{
    product_id: string;
    edition_id: string;
    title: string;
    subtitle: string | null;
    language: string;
  }>();
  if (
    result.results.length !== ITEM_COUNT ||
    result.results.some((row) => !row.product_id.startsWith("perf-synth-")) ||
    result.results.some((row) => !row.edition_id.startsWith("perf-synth-"))
  )
    return false;
  const books = result.results.map((row): CatalogBook => ({
    id: row.product_id,
    productId: row.product_id,
    editionId: row.edition_id,
    title: row.title,
    subtitle: row.subtitle || "",
    authors: [{ name: "Synthetic author" }],
    subjects: [],
    bookshelves: [],
    languages: [row.language || "en"],
    formats: {},
    download_count: 0,
  }));
  const body = buildSyntheticDisplayObject(books, now());
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
};

export async function authorizeOfferBearingSyntheticPage(
  db: CatalogDB,
  ids: string[],
): Promise<SyntheticExtendedAuthorityRow[]> {
  if (
    ids.length !== ITEM_COUNT ||
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
         ORDER BY o.created_at DESC LIMIT 1) offer_json
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
  const current = await authorizeOfferBearingSyntheticPage(
    env.DB,
    snapshot.items.map((item) => item.productId),
  );
  if (
    current.length !== PAGE_COUNT + 1 ||
    new Set(current.map((row) => row.product_id)).size !== PAGE_COUNT + 1
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
      (row.download_count !== null &&
        (!Number.isSafeInteger(row.download_count) || row.download_count < 0))
    )
      return null;
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
      subjects: display.subjects,
      bookshelves: display.bookshelves,
      languages: display.languages,
      formats: display.imageUrl
        ? { [display.imageUrl.endsWith(".png") ? "image/png" : "image/jpeg"]: display.imageUrl }
        : {},
      download_count: row.download_count ?? 0,
      publisher: display.publisher,
      offer,
      // Edition display flags are live-primary metadata, NOT entitlement
      // grants. No protected EPUB URL is cached or delivered by this probe.
    });
  }
  return { books: books.slice(0, PAGE_COUNT), hasMore: true };
}
