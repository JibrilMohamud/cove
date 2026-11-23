/**
 * Independent R2 storage for public display-only facets.
 *
 * An R2 cache hit never authorizes a book. Product IDs, offers, withdrawals,
 * checkout and protected delivery still require fresh primary-D1 proof.
 * This store contains only market-scoped aggregate labels and counts.
 *
 * A single object holds both the current lease and the completed projection.
 * Conditional puts are evaluated atomically by R2, so two cold colos cannot
 * both acquire the same still-active lease or overwrite a newer owner.
 */
export type PresentationR2Bucket = {
  get(key: string): Promise<{ etag: string; size?: number; text(): Promise<string> } | null>;
  put(
    key: string,
    value: string,
    options: { onlyIf: { etagMatches?: string; etagDoesNotMatch?: string } },
  ): Promise<{ etag: string } | null>;
};

const OBJECT_PREFIX = "public-presentation/search-facets-v2/";
const PRESENTATION_TTL_MS = 600_000;
const LEASE_MS = 45_000;
const MAX_BYTES = 65_536;

export type PublicFacetProjection = {
  categories: Array<{ value: string; count: number }>;
  languages: Array<{ value: string; count: number }>;
  formats: Array<{ value: string; count: number }>;
  publishers: Array<{ value: string; count: number }>;
  series: Array<{ value: string; count: number }>;
  availability: Array<{ value: string; count: number }>;
  price: { currency: string; min: number; max: number } | null;
};

function objectKey(cacheKey: string) {
  if (!/^search-facets:v2:[a-f0-9]{64}$/.test(cacheKey))
    throw new Error("Invalid public presentation cache key");
  return OBJECT_PREFIX + cacheKey.slice("search-facets:v2:".length);
}

export function validPublicFacetProjection(value: unknown): value is PublicFacetProjection {
  if (!value || typeof value !== "object") return false;
  const facets = value as Record<string, unknown>;
  for (const name of [
    "categories",
    "languages",
    "formats",
    "publishers",
    "series",
    "availability",
  ]) {
    const items = facets[name];
    if (
      !Array.isArray(items) ||
      items.length > 100 ||
      !items.every(
        (item) =>
          item &&
          typeof item === "object" &&
          typeof item.value === "string" &&
          item.value.length <= 300 &&
          Number.isSafeInteger(item.count) &&
          item.count >= 0,
      )
    )
      return false;
  }
  const price = facets.price;
  return (
    price === null ||
    (price !== undefined &&
      typeof price === "object" &&
      typeof (price as { currency?: unknown }).currency === "string" &&
      /^[A-Z]{3}$/.test((price as { currency: string }).currency) &&
      Number.isSafeInteger((price as { min?: unknown }).min) &&
      Number.isSafeInteger((price as { max?: unknown }).max))
  );
}

type LeaseState = { version: 1; kind: "lease"; expiresAt: number };
type ReadyState = {
  version: 1;
  kind: "ready";
  expiresAt: number;
  facets: PublicFacetProjection;
};
type StoredState = LeaseState | ReadyState;

async function decoded(
  object: { size?: number; text(): Promise<string> } | null,
): Promise<StoredState | null> {
  if (!object || (object.size !== undefined && object.size > MAX_BYTES)) return null;
  try {
    const raw = await object.text();
    if (raw.length > MAX_BYTES) return null;
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object") return null;
    const state = value as Partial<StoredState>;
    if (
      state.version !== 1 ||
      !Number.isSafeInteger(state.expiresAt) ||
      (state.kind !== "lease" && state.kind !== "ready")
    )
      return null;
    if (state.kind === "ready" && !validPublicFacetProjection(state.facets)) return null;
    return state as StoredState;
  } catch {
    return null;
  }
}

export async function readPublicFacetProjection(
  bucket: PresentationR2Bucket,
  key: string,
  nowMs = Date.now(),
): Promise<PublicFacetProjection | null> {
  const state = await decoded(await bucket.get(objectKey(key)));
  if (state?.kind !== "ready" || state.expiresAt <= nowMs) return null;
  // Reject implausibly distant timestamps rather than treating a corrupt
  // object as a permanent public cache. Rights are never decided from it.
  if (state.expiresAt > nowMs + PRESENTATION_TTL_MS) return null;
  return state.facets;
}

/**
 * One writer per active facet lease; never performs or retains a D1 write.
 * The caller computes public facets on an independent presentation replica
 * and checks primary D1 availability before starting an expensive scan.
 */
export async function refreshPublicFacetProjection(
  bucket: PresentationR2Bucket,
  key: string,
  compute: () => Promise<PublicFacetProjection>,
  now = () => Date.now(),
): Promise<boolean> {
  const name = objectKey(key);
  const earlier = await bucket.get(name);
  const start = now();
  const existing = await decoded(earlier);
  if (existing && existing.expiresAt > start) return false;

  const lease = await bucket.put(
    name,
    JSON.stringify({ version: 1, kind: "lease", expiresAt: start + LEASE_MS }),
    { onlyIf: earlier ? { etagMatches: earlier.etag } : { etagDoesNotMatch: "*" } },
  );
  if (!lease) return false;

  let completed = false;
  try {
    const facets = await compute();
    if (!validPublicFacetProjection(facets)) throw new Error("Invalid public facet projection");
    const ready = JSON.stringify({
      version: 1,
      kind: "ready",
      expiresAt: now() + PRESENTATION_TTL_MS,
      facets,
    });
    if (ready.length > MAX_BYTES) throw new Error("Public facet projection too large");
    const saved = await bucket.put(name, ready, { onlyIf: { etagMatches: lease.etag } });
    completed = !!saved;
    return completed;
  } finally {
    if (!completed) {
      // A stale lease owner cannot replace another colo's newer lease/result.
      await bucket
        .put(name, JSON.stringify({ version: 1, kind: "lease", expiresAt: now() - 1 }), {
          onlyIf: { etagMatches: lease.etag },
        })
        .catch(() => null);
    }
  }
}
