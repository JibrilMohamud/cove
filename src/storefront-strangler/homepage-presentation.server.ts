import {
  chooseSupportedLocale,
  parseAcceptLanguage,
  resolveAnonymousHomepageContext,
  type StorefrontContext,
  type StorefrontDB,
} from "./localization-optimized.server";
import { selectedUiCatalog } from "../features/fore/ui-catalog.server";
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
        String(end).replace(" ", "T") + (String(end).includes("Z") ? "" : "Z"),
      );
      if (!Number.isFinite(expires)) throw Error("Invalid presentation page expiry");
      candidates.expiresAt = Math.min(candidates.expiresAt, expires);
    }
  }
  const snapshot: Snapshot = { schema: SCHEMA, candidates, contexts };
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
  return { candidates, context: { ...context, uiMessages: selectedUiCatalog(context.locale) } };
}
