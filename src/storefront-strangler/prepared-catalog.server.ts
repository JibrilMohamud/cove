import {
  canonicalAuthorizedPreparedFirstPaintBooks,
  type CatalogDB,
  type FirstPaintD1QueryMetrics,
} from "../features/fore/catalog-model.server";

export type PrivatePresentationStore = {
  get(key: string): Promise<{ size: number; text(): Promise<string> } | null>;
};
// These are fixed, intentionally low-cardinality staging diagnostics only.
export class PreparedCatalogUnavailable extends Error {
  constructor(
    readonly code: "snapshot_read" | "snapshot_absent" | "snapshot_invalid" | "primary_rights",
  ) {
    super("Prepared catalog unavailable");
  }
}

const MODEL_VERSION = "cove.home.candidates.v1";
const MODEL_PREFIX = "private/presentation/v1/home/";
const MAX_BYTES = 16_384;
const MAX_CANDIDATES = 128;
// Candidate freshness tolerates cron propagation; rights remain primary-D1 live.
const MAX_AGE_MS = 20 * 60_000;

type CandidateSnapshot = {
  schema: typeof MODEL_VERSION;
  country: string;
  currency: string;
  createdAt: number;
  expiresAt: number;
  productIds: string[];
};

const countryCode = (country: string) => /^[A-Z]{2}$/.test(country);
const currencyCode = (currency: string) => /^[A-Z]{3}$/.test(currency);
const productId = (id: string) => /^[A-Za-z0-9][A-Za-z0-9_-]{1,159}$/.test(id);

export function privateCandidateKey(country: string) {
  if (!countryCode(country)) throw Error("Invalid trusted market country.");
  return `${MODEL_PREFIX}${country}.json`;
}

/** Strictly informational; nothing in this object can authorize delivery. */
export function validateCandidateSnapshot(
  raw: unknown,
  country: string,
  now = Date.now(),
): CandidateSnapshot {
  if (!raw || typeof raw !== "object") throw Error("Missing candidate projection.");
  const doc = raw as Partial<CandidateSnapshot>;
  if (
    doc.schema !== MODEL_VERSION ||
    !countryCode(country) ||
    doc.country !== country ||
    !currencyCode(doc.currency || "") ||
    !Number.isSafeInteger(doc.createdAt) ||
    !Number.isSafeInteger(doc.expiresAt) ||
    doc.createdAt! > now + 5_000 ||
    now - doc.createdAt! > MAX_AGE_MS ||
    doc.expiresAt! <= now ||
    doc.expiresAt! > doc.createdAt! + MAX_AGE_MS ||
    !Array.isArray(doc.productIds) ||
    doc.productIds.length > MAX_CANDIDATES ||
    !doc.productIds.every((id) => typeof id === "string" && productId(id)) ||
    new Set(doc.productIds).size !== doc.productIds.length
  )
    throw Error("Invalid or expired private candidate projection.");
  return doc as CandidateSnapshot;
}

/** Producer side. Runs outside the critical request in a future isolated job.
 * It reads catalog order/market metadata, never rights or entitlement grants.
 */
export async function produceCandidateSnapshot(
  db: CatalogDB,
  country: string,
  store: {
    put(
      key: string,
      value: string,
      opts: { httpMetadata: { contentType: string } },
    ): Promise<unknown>;
  },
  now = Date.now(),
) {
  if (!countryCode(country)) throw Error("Invalid candidate market.");
  const selected = await db
    .prepare(
      `SELECT COALESCE(
        (SELECT default_currency FROM storefront_markets
         WHERE country_code=? AND market_status='active'),
        (SELECT default_currency FROM storefront_markets
         WHERE country_code='US' AND market_status='active')
      ) currency`,
    )
    .bind(country)
    .first<{ currency: string }>();
  const currency = String(selected?.currency || "");
  if (!currencyCode(currency)) throw Error("Active currency is unavailable.");
  // Territorial eligibility here is only a producer-side ranking hint.
  // Every served ID is reauthorized against current PRIMARY-D1 retail rights.
  // It avoids losing sparse-market books outside the globally ranked top 128.
  const result = await db
    .prepare(
      `SELECT d.product_id FROM catalog_search_documents d INDEXED BY idx_search_popular_stable
       JOIN products p ON p.id=d.product_id JOIN editions e ON e.id=p.edition_id
       WHERE d.currency=? AND d.availability='available' AND d.suppressed=0
         AND p.storefront_status='active' AND p.source_name<>'upload'
         AND e.release_status IN ('available','preorder')
         AND EXISTS (
           SELECT 1 FROM retail_product_availability_rows rpa
           WHERE rpa.product_id=p.id AND rpa.territory_code=?
         )
       ORDER BY d.fore_bestseller_score DESC,d.external_book_id ASC,d.product_id ASC LIMIT ?`,
    )
    .bind(currency, country, MAX_CANDIDATES)
    .all<{ product_id: string }>();
  const snapshot: CandidateSnapshot = {
    schema: MODEL_VERSION,
    country,
    currency,
    createdAt: now,
    expiresAt: now + MAX_AGE_MS,
    productIds: result.results.map((row) => String(row.product_id)),
  };
  validateCandidateSnapshot(snapshot, country, now);
  const body = JSON.stringify(snapshot);
  if (new TextEncoder().encode(body).length > MAX_BYTES)
    throw Error("Candidate projection exceeds size limit.");
  await store.put(privateCandidateKey(country), body, {
    httpMetadata: { contentType: "application/json" },
  });
  return { country, candidates: snapshot.productIds.length, expiresAt: snapshot.expiresAt };
}

/** A private R2 read reduces ranking work on primary but NEVER bypasses it.
 * Missing/old/corrupt data fails closed. No automatic heavy-query fallback.
 */
export async function servePreparedCatalog(
  db: CatalogDB,
  store: PrivatePresentationStore,
  country: string,
  now = Date.now(),
  diagnostics?: FirstPaintD1QueryMetrics,
) {
  let object: Awaited<ReturnType<PrivatePresentationStore["get"]>>;
  try {
    object = await store.get(privateCandidateKey(country));
  } catch {
    throw new PreparedCatalogUnavailable("snapshot_read");
  }
  if (!object) throw new PreparedCatalogUnavailable("snapshot_absent");
  if (!Number.isFinite(object.size) || object.size > MAX_BYTES || object.size < 2)
    throw new PreparedCatalogUnavailable("snapshot_invalid");
  let doc: CandidateSnapshot;
  try {
    doc = validateCandidateSnapshot(JSON.parse(await object.text()), country, now);
  } catch {
    throw new PreparedCatalogUnavailable("snapshot_invalid");
  }
  return authorizePreparedCatalog(db, doc, diagnostics);
}

export async function authorizePreparedCatalog(
  db: CatalogDB,
  doc: ReturnType<typeof validateCandidateSnapshot>,
  diagnostics?: FirstPaintD1QueryMetrics,
) {
  let authorized: Awaited<ReturnType<typeof canonicalAuthorizedPreparedFirstPaintBooks>>;
  try {
    authorized = await canonicalAuthorizedPreparedFirstPaintBooks(
      db,
      doc.productIds,
      doc.country,
      doc.currency,
      24,
      diagnostics,
    );
  } catch {
    throw new PreparedCatalogUnavailable("primary_rights");
  }
  const { books, hasMore } = authorized;
  // Unknown channel eligibility is never represented as granted.
  for (const book of books) {
    delete book.subscriptionEligible;
    delete book.libraryEligible;
  }
  return {
    results: books,
    count: books.length,
    next: hasMore ? "/api/fore/catalog?search=&sort=popular&page=2&currency=" + doc.currency : null,
    preview: true as const,
    search: {
      queryId: null,
      backend: "d1-fts5" as const,
      processingTimeMs: 0,
      pageSize: 24,
    },
  };
}
