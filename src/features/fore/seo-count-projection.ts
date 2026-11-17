/**
 * An opt-in, read-only sitemap COUNT projection contract. This module has no
 * database/cache/network access and grants NO permission to list, sell or
 * deliver any book.
 *
 * Do not wire it into production before a sole canonical owner guarantees
 * atomic publication-generation invalidation for EVERY catalog, legal,
 * status, taxonomy and contributor mutation. A cached clock/TTL or eventual
 * invalidation is NOT a substitute for the primary-D1 fence.
 */
export const SEO_COUNT_PROJECTION_SCHEMA = "cove.seo.counts.v1";
export const SEO_COUNT_MAX_AGE_MS = 60_000;
export const SEO_COUNT_KINDS = [
  "books",
  "works",
  "editions",
  "authors",
  "categories",
] as const;

export type SeoCountKind = (typeof SEO_COUNT_KINDS)[number];
export type SeoCounts = Record<SeoCountKind, number>;

/**
 * The projection and the primary-D1 fence MUST originate from an atomic,
 * ordered authority read; the fence must not come from a lagging replica,
 * an edge cache, or a different authority.
 */
export type SeoCountProjectionEvidence = {
  snapshot: unknown;
  fence: unknown;
};

export type SeoCountEvidenceLoader = () => Promise<SeoCountProjectionEvidence>;

function record(input: unknown): input is Record<string, unknown> {
  return !!input && typeof input === "object" && !Array.isArray(input);
}

function exactKeys(value: Record<string, unknown>, required: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === required.length && keys.every((key) => required.includes(key));
}

const GENERATIONS = [
  "ownerVersion",
  "catalogGeneration",
  "rightsGeneration",
  "withdrawalGeneration",
  "taxonomyGeneration",
  "contributorGeneration",
] as const;

const SNAPSHOT_FIELDS = [
  "schema",
  ...GENERATIONS,
  "createdAtMs",
  "expiresAtMs",
  "counts",
] as const;

const FENCE_FIELDS = [
  ...GENERATIONS,
  "ownerEnabled",
  "exclusiveWriter",
  "primaryD1",
  "dirty",
  "pendingWithdrawals",
  "pendingWrites",
] as const;

function generation(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
}

/**
 * Strictly reject missing, expired, malformed, cross-version, dirty, or
 * withdrawal-pending evidence. Never fall back to a stale snapshot.
 * Call once on EACH sitemap request; never persist a positive result in
 * Worker-global state or a CDN cache.
 */
export function verifiedSeoCounts(
  evidence: SeoCountProjectionEvidence,
  nowMs: number,
): Readonly<SeoCounts> | null {
  if (!record(evidence) || !record(evidence.snapshot) || !record(evidence.fence)) return null;
  const snapshot = evidence.snapshot;
  const fence = evidence.fence;
  if (!exactKeys(snapshot, SNAPSHOT_FIELDS) || !exactKeys(fence, FENCE_FIELDS)) return null;
  if (snapshot.schema !== SEO_COUNT_PROJECTION_SCHEMA) return null;

  if (
    fence.ownerEnabled !== true ||
    fence.exclusiveWriter !== true ||
    fence.primaryD1 !== true ||
    fence.dirty !== false ||
    fence.pendingWithdrawals !== 0 ||
    fence.pendingWrites !== 0
  ) return null;

  if (
    !Number.isSafeInteger(nowMs) ||
    !Number.isSafeInteger(snapshot.createdAtMs) ||
    !Number.isSafeInteger(snapshot.expiresAtMs) ||
    (snapshot.createdAtMs as number) > nowMs ||
    (snapshot.expiresAtMs as number) <= nowMs ||
    nowMs - (snapshot.createdAtMs as number) > SEO_COUNT_MAX_AGE_MS ||
    (snapshot.expiresAtMs as number) - (snapshot.createdAtMs as number) > SEO_COUNT_MAX_AGE_MS
  ) return null;

  // Match ALL mutation classes, not just rights. A changed publication
  // status, contributor link or taxonomy can also change sitemap cardinality.
  for (const key of GENERATIONS) {
    if (!generation(snapshot[key]) || !generation(fence[key]) || snapshot[key] !== fence[key])
      return null;
  }

  if (!record(snapshot.counts) || !exactKeys(snapshot.counts, SEO_COUNT_KINDS)) return null;
  for (const key of SEO_COUNT_KINDS) {
    const value = snapshot.counts[key];
    if (!Number.isSafeInteger(value) || (value as number) < 0) return null;
  }
  return Object.freeze({ ...(snapshot.counts as SeoCounts) });
}

/**
 * During opt-in operation all catalog-backed sitemap documents must remain
 * no-store. A formerly valid CDN response could otherwise advertise a
 * withdrawn title after the canonical generation changes.
 */
export function noncacheableSeoDocument(response: Response, head: boolean): Response {
  const headers = new Headers(response.headers);
  headers.set("cache-control", "no-store");
  headers.delete("CDN-Cache-Control");
  headers.delete("Vercel-CDN-Cache-Control");
  headers.delete("Cloudflare-CDN-Cache-Control");
  return new Response(head ? null : response.body, { status: response.status, headers });
}

export function unavailableSeoDocument(): Response {
  return new Response("Sitemap temporarily unavailable", {
    status: 503,
    headers: {
      "cache-control": "no-store",
      "content-type": "text/plain; charset=utf-8",
    },
  });
}
