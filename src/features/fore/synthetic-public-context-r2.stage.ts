import type { StorefrontContext } from "./localization.server";
import type { PresentationR2Bucket } from "./search-presentation-r2.server";

/**
 * Synthetic-only experiment: a private R2 copy of PUBLIC merchandising and
 * localization metadata, never positive-rights, legal-owner, payment,
 * entitlement, checkout or download evidence.
 *
 * A separate live primary-D1 active-market fence MUST accompany the
 * right-scoped catalog statement on every request that uses this metadata.
 * Do not enable in real production, even for anonymous users, until the
 * invalidation and positive-rights model is independently certified.
 */
export type StageContextEnv = {
  FORE_ENVIRONMENT?: string;
  FORE_GUEST_COMPACT_STAGE?: string;
  FORE_GUEST_CONTEXT_R2_STAGE?: string;
  FORE_GUEST_COMPACT_SYNTHETIC_D1_ID?: string;
  COVE_PUBLIC_PRESENTATION_CACHE?: PresentationR2Bucket;
};

const SYNTHETIC_D1 = "e4cbb0ef-6288-4fa1-9dbb-fb42fe01d4f3";
const OBJECT_KEY = "public-presentation/synthetic-market-context-v1/US/en-US.json";
const TTL_MS = 120_000;
const MAX_BYTES = 180_000;

type Snapshot = {
  schema: "cove.synthetic-public-context.v1";
  expiresAt: number;
  context: StorefrontContext;
};

export function eligibleStageContextRequest(
  env: StageContextEnv,
  request: Request,
  principal: string | null,
): boolean {
  const url = new URL(request.url);
  return (
    env.FORE_ENVIRONMENT !== "production" &&
    env.FORE_GUEST_COMPACT_STAGE === "1" &&
    env.FORE_GUEST_CONTEXT_R2_STAGE === "1" &&
    env.FORE_GUEST_COMPACT_SYNTHETIC_D1_ID === SYNTHETIC_D1 &&
    !!env.COVE_PUBLIC_PRESENTATION_CACHE &&
    principal === null &&
    request.method === "GET" &&
    url.pathname === "/api/fore/catalog" &&
    url.searchParams.get("sort") === "popular" &&
    (url.searchParams.get("page") === "1" || !url.searchParams.has("page")) &&
    url.searchParams.get("currency") === "USD" &&
    !url.searchParams.has("search") &&
    !request.headers.has("cookie") &&
    !request.headers.has("authorization") &&
    !request.headers.has("accept-language") &&
    !request.headers.has("x-fore-authenticated-user-id") &&
    request.headers.get("x-cove-client-country") === "US"
  );
}

function publicContextShape(raw: unknown): raw is StorefrontContext {
  if (!raw || typeof raw !== "object") return false;
  const data = raw as Partial<StorefrontContext>;
  return (
    data.storefrontCountry === "US" &&
    data.rightsCountry === "US" &&
    data.networkCountry === "US" &&
    data.locale === "en-US" &&
    data.language === "en" &&
    data.currency === "USD" &&
    data.direction === "ltr" &&
    Array.isArray(data.paymentMethods) &&
    data.paymentMethods.length <= 24 &&
    Array.isArray(data.availableMarkets) &&
    data.availableMarkets.length <= 120 &&
    data.availableMarkets.some((m) => m.countryCode === "US" && m.defaultCurrency === "USD") &&
    data.messages !== null &&
    typeof data.messages === "object" &&
    data.uiMessages !== null &&
    typeof data.uiMessages === "object" &&
    data.source?.country === "network" &&
    data.source?.locale === "negotiated" &&
    data.source?.currency === "market" &&
    typeof data.checkoutEnabled === "boolean"
  );
}

function freshSnapshot(raw: unknown, now: number): StorefrontContext | null {
  if (!raw || typeof raw !== "object") return null;
  const state = raw as Partial<Snapshot>;
  if (
    state.schema !== "cove.synthetic-public-context.v1" ||
    !Number.isSafeInteger(state.expiresAt) ||
    (state.expiresAt as number) <= now ||
    (state.expiresAt as number) > now + TTL_MS ||
    !publicContextShape(state.context)
  )
    return null;
  return state.context;
}

export async function resolveStagePublicContext(
  env: StageContextEnv,
  request: Request,
  principal: string | null,
  resolveLive: () => Promise<StorefrontContext>,
  now = () => Date.now(),
): Promise<StorefrontContext> {
  if (!eligibleStageContextRequest(env, request, principal)) return resolveLive();
  const bucket = env.COVE_PUBLIC_PRESENTATION_CACHE!;
  let previous: Awaited<ReturnType<PresentationR2Bucket["get"]>> = null;
  try {
    previous = await bucket.get(OBJECT_KEY);
    if (previous && (previous.size === undefined || previous.size <= MAX_BYTES)) {
      const raw = await previous.text();
      if (raw.length <= MAX_BYTES) {
        const hit = freshSnapshot(JSON.parse(raw) as unknown, now());
        if (hit) return hit;
      }
    }
  } catch {
    // A missing or corrupt presentation object is NOT permission to skip the
    // live context check. Never serve stale rights or report raw credentials.
    previous = null;
  }
  const live = await resolveLive();
  if (!publicContextShape(live)) return live;
  try {
    const payload: Snapshot = {
      schema: "cove.synthetic-public-context.v1",
      expiresAt: now() + TTL_MS,
      context: live,
    };
    const bytes = JSON.stringify(payload);
    if (bytes.length <= MAX_BYTES)
      await bucket.put(OBJECT_KEY, bytes, {
        onlyIf: previous ? { etagMatches: previous.etag } : { etagDoesNotMatch: "*" },
      });
  } catch {
    // Best-effort independent presentation storage; the authoritative D1
    // request already completed, so retaining live metadata is safe.
    console.warn("Synthetic public-context R2 refresh unavailable");
  }
  return live;
}
