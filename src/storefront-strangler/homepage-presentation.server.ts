import {
  chooseSupportedLocale,
  parseAcceptLanguage,
  resolveAnonymousHomepageContext,
  type StorefrontContext,
  type StorefrontDB,
} from "./localization-optimized.server";
import { selectedUiCatalog } from "../features/fore/ui-catalog.server";
import {
  canonicalFirstPaintBooksByProductIds,
  authorizeStorefrontPresentationIds,
  type CatalogDB,
  type FirstPaintD1QueryMetrics,
} from "../features/fore/catalog-model.server";
import type { CatalogBook } from "../features/fore/client";
import {
  privateCandidateKey,
  produceCandidateSnapshot,
  validateCandidateSnapshot,
  type PrivatePresentationStore,
} from "./prepared-catalog.server";

const SCHEMA = "cove.home.presentation.v2";
const MAX_BYTES = 512 * 1024;
type PublicContext = Omit<StorefrontContext, "uiMessages">;
type Snapshot = {
  schema: typeof SCHEMA;
  candidates: ReturnType<typeof validateCandidateSnapshot>;
  contexts: PublicContext[];
  displayBooks: CatalogBook[];
};
type WritableStore = PrivatePresentationStore & {
  put(
    key: string,
    body: string,
    options: { httpMetadata: { contentType: string } },
  ): Promise<unknown>;
};

export function homepagePresentationKey(country: string) {
  // Keep v1 and v2 readers independent during deployment and rollback.
  return privateCandidateKey(country).replace("/v1/", "/v2/");
}

/** Only the isolated discovery producer calls this. No rights or access
 * decisions are copied into a serving authority. Publication is one atomic
 * R2 object replacement after every required locale has been produced. */
export async function produceHomepagePresentation(
  discovery: StorefrontDB,
  country: string,
  store: WritableStore,
  now = Date.now(),
) {
  let candidateBody = "";
  await produceCandidateSnapshot(
    discovery,
    country,
    {
      async put(_key, body) {
        candidateBody = body;
      },
    },
    now,
  );
  const candidates = validateCandidateSnapshot(JSON.parse(candidateBody), country, now);
  const displayBooks: CatalogBook[] = [];
  for (let offset = 0; offset < candidates.productIds.length; offset += 64) {
    const books = await canonicalFirstPaintBooksByProductIds(
      discovery,
      candidates.productIds.slice(offset, offset + 64),
    );
    for (const b of books)
      displayBooks.push({
        id: b.id,
        productId: b.productId,
        editionId: b.editionId,
        publicProductId: b.publicProductId,
        publicEditionId: b.publicEditionId,
        sourceExternalId: b.sourceExternalId,
        title: b.title.slice(0, 512),
        authors: b.authors.slice(0, 8).map((a) => ({ ...a, name: a.name.slice(0, 256) })),
        subjects: b.subjects.slice(0, 4).map((x) => x.slice(0, 256)),
        bookshelves: b.bookshelves.slice(0, 4).map((x) => x.slice(0, 256)),
        languages: b.languages.slice(0, 4),
        download_count: b.download_count,
        formats: Object.fromEntries(
          Object.entries(b.formats).filter(
            ([kind, url]) => ["image/jpeg", "image/png"].includes(kind) && url.length <= 2048,
          ),
        ),
      });
  }
  const resolve = (locale = "") =>
    resolveAnonymousHomepageContext(
      discovery,
      new Request("https://presentation.invalid/", {
        headers: {
          "x-cove-client-country": country,
          "accept-language": locale,
        },
      }),
    );
  const first = await resolve();
  const locales = first.availableMarkets?.find(
    (m) => m.countryCode === first.storefrontCountry,
  )?.locales;
  if (!locales?.length || locales.length > 16)
    throw Error("Unbounded presentation locale configuration");
  const contexts: PublicContext[] = [];
  for (const locale of [...new Set([first.locale, ...locales])]) {
    const context = locale === first.locale ? first : await resolve(locale);
    if (contexts.some((c) => c.locale === context.locale)) continue;
    // UI strings are code-owned and rebuilt at read time, keeping snapshots small.
    const { uiMessages: _uiMessages, ...publicContext } = context;
    contexts.push(publicContext);
    const end = context.homepagePageRow?.ends_at;
    if (end) {
      const expires = Date.parse(
        String(end).replace(" ", "T") + (/(?:Z|[+-]\d{2}:\d{2})$/i.test(String(end)) ? "" : "Z"),
      );
      if (!Number.isFinite(expires)) throw Error("Invalid presentation page expiry");
      candidates.expiresAt = Math.min(candidates.expiresAt, expires);
    }
  }
  const snapshot: Snapshot = { schema: SCHEMA, candidates, contexts, displayBooks };
  const body = JSON.stringify(snapshot);
  if (new TextEncoder().encode(body).length > MAX_BYTES || candidates.expiresAt <= now)
    throw Error("Unusable presentation snapshot");
  await store.put(homepagePresentationKey(country), body, {
    httpMetadata: { contentType: "application/json" },
  });
  return {
    country,
    locales: contexts.length,
    candidates: candidates.productIds.length,
    expiresAt: candidates.expiresAt,
  };
}

/** No pending I/O or authorization results are shared between requests.
 * Missing, stale, cross-market or malformed presentation never launches a
 * catalog-wide fallback. The caller must still query live primary rights. */
export async function readHomepagePresentation(
  store: PrivatePresentationStore,
  request: Request,
  country: string,
  now = Date.now(),
) {
  const object = await store.get(homepagePresentationKey(country));
  if (!object || !Number.isFinite(object.size) || object.size < 2 || object.size > MAX_BYTES)
    throw Error("Presentation unavailable");
  const raw = JSON.parse(await object.text()) as Snapshot;
  if (
    raw.schema !== SCHEMA ||
    !Array.isArray(raw.contexts) ||
    !raw.contexts.length ||
    raw.contexts.length > 16
  )
    throw Error("Invalid presentation schema");
  const candidates = validateCandidateSnapshot(raw.candidates, country, now);
  if (
    !Array.isArray(raw.displayBooks) ||
    raw.displayBooks.length > 128 ||
    new Set(raw.displayBooks.map((b) => b?.productId)).size !== raw.displayBooks.length ||
    raw.displayBooks.some(
      (b) =>
        !b ||
        !candidates.productIds.includes(b.productId || "") ||
        typeof b.title !== "string" ||
        !Array.isArray(b.authors) ||
        !Array.isArray(b.subjects) ||
        !Array.isArray(b.bookshelves) ||
        !b.formats,
    )
  )
    throw Error("Invalid display metadata");
  const unique = new Set<string>();
  for (const c of raw.contexts) {
    if (
      !c ||
      c.rightsCountry !== country ||
      c.currency !== candidates.currency ||
      !/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,2}$/.test(c.locale) ||
      !/^[a-z]{2,3}$/i.test(c.language) ||
      !["ltr", "rtl"].includes(c.direction) ||
      !Array.isArray(c.availableMarkets) ||
      !c.messages ||
      !c.source ||
      unique.has(c.locale)
    )
      throw Error("Invalid presentation context");
    unique.add(c.locale);
  }
  const locale = chooseSupportedLocale(
    raw.contexts.map((c) => ({
      locale: c.locale,
      language_code: c.language,
    })),
    parseAcceptLanguage((request.headers.get("accept-language") || "").slice(0, 512)),
  );
  const context = raw.contexts.find((c) => c.locale === locale?.locale)!;
  return {
    candidates,
    displayBooks: raw.displayBooks,
    context: { ...context, uiMessages: selectedUiCatalog(context.locale) },
  };
}

export async function authorizeHomepagePresentation(
  primary: CatalogDB,
  presentation: Awaited<ReturnType<typeof readHomepagePresentation>>,
  metrics?: FirstPaintD1QueryMetrics,
) {
  const rows = await authorizeStorefrontPresentationIds(
    primary,
    presentation.candidates.productIds,
    presentation.candidates.country,
    presentation.candidates.currency,
    metrics,
  );
  return assembleAuthorizedHomepagePresentation(presentation,rows);
}

/** The only builder for primary- or *fully fenced* owner-authorized rows.
 * The caller of this pure builder must have performed a fresh authorization
 * decision; untrusted candidate metadata cannot supply offers or grants. */
export function assembleAuthorizedHomepagePresentation(
  presentation: Awaited<ReturnType<typeof readHomepagePresentation>>,
  rows: Awaited<ReturnType<typeof authorizeStorefrontPresentationIds>>,
) {
  const { candidates, displayBooks } = presentation;
  const metadata = new Map(displayBooks.map((b) => [b.productId, b]));
  const books: CatalogBook[] = [];
  for (const row of rows) {
    const b = metadata.get(row.product_id);
    if (!b || b.editionId !== row.edition_id) continue;
    // Only explicitly selected presentation fields leave the snapshot. A
    // malicious/stale cached offer or channel flag cannot become authority.
    books.push({
      id: row.product_public_id || row.product_id,
      productId: row.product_id,
      publicProductId: row.product_public_id || undefined,
      editionId: row.edition_id,
      publicEditionId: row.edition_public_id || undefined,
      sourceExternalId: b.sourceExternalId,
      title: b.title,
      authors: b.authors,
      subjects: b.subjects,
      bookshelves: b.bookshelves,
      languages: b.languages,
      formats: Object.fromEntries(
        Object.entries(b.formats).filter(
          ([kind, url]) =>
            ["image/jpeg", "image/png"].includes(kind) &&
            typeof url === "string" &&
            url.length <= 2048,
        ),
      ),
      download_count: b.download_count,
      offer: row.offer_json ? JSON.parse(row.offer_json) : undefined,
    });
  }
  return {
    results: books.slice(0, 24),
    count: Math.min(books.length, 24),
    next:
      books.length > 24
        ? `/api/fore/catalog?search=&sort=popular&page=2&currency=${candidates.currency}`
        : null,
    preview: true as const,
    search: { queryId: null, backend: "d1-fts5" as const, processingTimeMs: 0, pageSize: 24 },
  };
}
