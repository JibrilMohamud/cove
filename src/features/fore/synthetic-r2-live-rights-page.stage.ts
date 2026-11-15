import type { CatalogBook } from "./client";
import {
  authorizeStorefrontPresentationIds,
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
const shortText = (x: unknown, max: number): x is string =>
  typeof x === "string" && x.length <= max && !/[\u0000-\u001f\u007f]/.test(x);
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

export function eligibleSyntheticR2Page(
  request: Request,
  env: SyntheticRightsPresentationEnv,
): boolean {
  const url = new URL(request.url);
  return (
    url.hostname === STAGE_HOST &&
    url.pathname === STAGE_PATH &&
    request.method === "GET" &&
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
  const current = await authorizeStorefrontPresentationIds(
    env.DB,
    snapshot.items.map((item) => item.productId),
    "US",
    "USD",
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
    // Changes to product edition or offers must not borrow old display data.
    if (!display || display.editionId !== row.edition_id || !offer) return null;
    books.push({
      id: row.product_public_id || row.product_id,
      productId: row.product_id,
      editionId: row.edition_id,
      publicProductId: row.product_public_id || undefined,
      publicEditionId: row.edition_public_id || undefined,
      title: display.title,
      subtitle: display.subtitle,
      authors: display.authors,
      subjects: display.subjects,
      bookshelves: display.bookshelves,
      languages: display.languages,
      formats: display.imageUrl
        ? { [display.imageUrl.endsWith(".png") ? "image/png" : "image/jpeg"]: display.imageUrl }
        : {},
      download_count: 0,
      publisher: display.publisher,
      offer,
      // NO cached subscription grants, DRM, downloadable flags or EPUB URLs.
    });
  }
  return { books: books.slice(0, PAGE_COUNT), hasMore: true };
}
