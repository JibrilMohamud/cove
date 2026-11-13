import type { CatalogBook } from "./client";

// Explicit public presentation allowlist. Canonical product/edition/work IDs,
// sourceName/sourceExternalId, offers, rights/channel flags, DRM, download
// status and protected EPUB links NEVER enter this cache.
const fields = [
  "title",
  "subtitle",
  "authors",
  "contributors",
  "summaries",
  "subjects",
  "bookshelves",
  "languages",
  "publisher",
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
  "fileSizeBytes",
  "epubVersion",
  "layout",
  "publisherDescription",
  "editorialReviews",
  "series",
  "accessibility",
  "formatProfile",
  "aiDisclosure",
  "externalIdentifiers",
  "sourceProject",
  "sourceUrl",
  "sourceLicenseUrl",
] as const satisfies readonly (keyof CatalogBook)[];
type Display = Pick<CatalogBook, (typeof fields)[number]> & { formats: Record<string, string> };
type Entry = { body: string; until: number; bytes: number };
type Cache = { entries: Map<string, Entry>; bytes: number };
const completed = new WeakMap<object, Cache>();
const MAX_ENTRIES = 128;
const MAX_BYTES = 1024 * 1024;
const MAX_ENTRY_BYTES = 64 * 1024;
export const PUBLIC_DISPLAY_TTL_MS = 30_000;
const key = (product: string, edition: string) => JSON.stringify([product, edition]);

function current(scope: object, now: number): Cache | undefined {
  const cache = completed.get(scope);
  if (cache)
    for (const [id, entry] of cache.entries)
      if (entry.until <= now) {
        cache.entries.delete(id);
        cache.bytes -= entry.bytes;
      }
  return cache;
}

export function hasCompletedPublicDisplay(scope: object, now = Date.now()): boolean {
  return (current(scope, now)?.entries.size || 0) > 0;
}

export function readCompletedPublicDisplay(
  scope: object,
  product: string,
  edition: string,
  now = Date.now(),
): Display | null {
  const entry = current(scope, now)?.entries.get(key(product, edition));
  // Only immutable serialized DATA is retained. No response, statement,
  // Promise or other request-owned I/O is ever shared between visitors.
  return entry ? (JSON.parse(entry.body) as Display) : null;
}

export function rememberCompletedPublicDisplay(
  scope: object,
  book: CatalogBook,
  until: number,
  now = Date.now(),
): void {
  if (
    !book.productId ||
    !book.editionId ||
    book.uploaded ||
    book.sourceName === "upload" ||
    until <= now ||
    until > now + PUBLIC_DISPLAY_TTL_MS
  )
    return;
  const display = Object.fromEntries(fields.map((field) => [field, book[field]]));
  const formats = Object.fromEntries(
    Object.entries(book.formats).filter(([kind]) => kind === "image/jpeg" || kind === "image/png"),
  );
  const body = JSON.stringify({ ...display, formats });
  const bytes = new TextEncoder().encode(body).length;
  if (bytes > MAX_ENTRY_BYTES) return;
  let cache = current(scope, now);
  if (!cache) {
    cache = { entries: new Map(), bytes: 0 };
    completed.set(scope, cache);
  }
  const id = key(book.productId, book.editionId);
  const old = cache.entries.get(id);
  if (old) {
    cache.entries.delete(id);
    cache.bytes -= old.bytes;
  }
  while (cache.entries.size >= MAX_ENTRIES || cache.bytes + bytes > MAX_BYTES) {
    const first = cache.entries.entries().next().value;
    if (!first) break;
    cache.entries.delete(first[0]);
    cache.bytes -= first[1].bytes;
  }
  cache.entries.set(id, { body, until, bytes });
  cache.bytes += bytes;
}
