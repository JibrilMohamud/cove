/* eslint-disable prettier/prettier -- Keep bounded public projection and strict first-paint invariant adjacent for audit. */
import { z } from "zod/v3";
import { ApiError, now } from "./service";
import { selectedUiCatalog } from "./ui-catalog.server";
import { dispatchPrivateMarketUpsert } from "../../storefront-strangler/publication-owner-routing.server";

export type StorefrontDB = {
  prepare(sql: string): {
    bind(...values: unknown[]): ReturnType<StorefrontDB["prepare"]>;
    first<T = any>(): Promise<T | null>;
    all<T = any>(): Promise<{ results: T[] }>;
    run(): Promise<any>;
  };
  batch(statements: any[]): Promise<unknown>;
};

export type StorefrontContext = {
  storefrontCountry: string;
  rightsCountry: string;
  networkCountry: string | null;
  locale: string;
  language: string;
  currency: string;
  direction: "ltr" | "rtl";
  taxInclusive: boolean;
  recommendationRegion: string;
  merchandisingRegion: string;
  checkoutEnabled: boolean;
  source: { country: string; locale: string; currency: string };
  paymentMethods: {
    paymentMethod: string;
    provider: string;
    currency: string | null;
    availability: string;
    priority: number;
  }[];
  messages: Record<string, string>;
  uiMessages: Record<string, string>;
  requestedCountry?: string | null;
  // Only present for the explicit anonymous homepage combined metadata read.
  // Never used to authorize a sale, download, or content delivery.
  availableMarkets?: Awaited<ReturnType<typeof storefrontMarkets>>;
};

const countrySchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{2}$/);
const localeSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,2}$/)
  .max(35);
const currencySchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{3}$/);

type PaymentMethodRow = {
  payment_method: string;
  provider: string;
  currency: string | null;
  availability: string;
  priority: number;
};
type TranslationRow = { message_key: string; message_value: string };

const blockedNetworkCodes = new Set(["XX", "T1", "ZZ"]);
const cookie = (request: Request, key: string) => {
  const raw = request.headers.get("cookie") || "";
  for (const pair of raw.split(";")) {
    const [k, ...rest] = pair.trim().split("=");
    if (k === key) {
      try {
        return decodeURIComponent(rest.join("="));
      } catch {
        return rest.join("=");
      }
    }
  }
  return "";
};

export function networkCountry(request: Request, fallback: string) {
  const cf = String(
    request.headers.get("x-cove-client-country") || request.headers.get("cf-ipcountry") || "",
  )
    .trim()
    .toUpperCase();
  if (/^[A-Z]{2}$/.test(cf) && !blockedNetworkCodes.has(cf))
    return { country: cf, source: "network" };
  const safe = /^[A-Z]{2}$/.test(String(fallback || "").toUpperCase())
    ? String(fallback).toUpperCase()
    : "US";
  return { country: safe, source: "default" };
}

function parseAcceptLanguage(value: string) {
  return value
    .split(",")
    .map((part, index) => {
      const [tag, ...params] = part.trim().split(";");
      let q = 1;
      for (const p of params) if (p.trim().startsWith("q=")) q = Number(p.trim().slice(2)) || 0;
      return { tag, q, index };
    })
    .filter((x) => x.tag && x.tag !== "*")
    .sort((a, b) => b.q - a.q || a.index - b.index)
    .map((x) => x.tag);
}

async function market(db: StorefrontDB, country: string) {
  return db
    .prepare("SELECT * FROM storefront_markets WHERE country_code=? AND market_status='active'")
    .bind(country)
    .first<any>();
}

async function preference(db: StorefrontDB, userId: string | null) {
  if (!userId) return null;
  return db
    .prepare("SELECT * FROM storefront_user_preferences WHERE user_id=?")
    .bind(userId)
    .first<any>();
}

/** Resolve the same active market and supported locales with one D1 request.
 * All returned configuration is fresh; this is not a territorial-rights cache.
 * Keep empty locales distinct from a missing market so fallback behavior stays
 * identical to the former independent market/locale reads.
 */
async function marketWithSupportedLocales(
  db: StorefrontDB,
  country: string,
  includeMarkets = false,
  anonymousLocales?: string[],
) {
  // Add an independent presentation-only market list to the same D1 response
  // for anonymous homepage bootstrap. All markets are fresh for THIS request.
  // Rights still come from the separate primary-D1 legal availability query.
  const marketProjection = includeMarkets
    ? `,(SELECT json_group_array(json_object(
          'countryCode', country_code,
          'displayName', display_name,
          'defaultLocale', default_locale,
          'defaultCurrency', default_currency,
          'taxInclusive', tax_inclusive_default,
          'checkoutEnabled', checkout_enabled,
          'locales', locales
        )) FROM (
          SELECT sm.country_code,sm.display_name,sm.default_locale,
            sm.default_currency,sm.tax_inclusive_default,sm.checkout_enabled,
            (SELECT GROUP_CONCAT(ml2.locale,',')
              FROM storefront_market_locales ml2
              WHERE ml2.country_code=sm.country_code AND ml2.active=1) locales
          FROM storefront_markets sm
          WHERE sm.market_status='active' ORDER BY sm.display_name
        )) available_markets_json,
        (SELECT json_group_array(json_object(
          'path', p.path,
          'page_type', p.page_type,
          'title', p.title,
          'heading', p.heading,
          'eyebrow', p.eyebrow,
          'description', p.description,
          'seo_title', p.seo_title,
          'seo_description', p.seo_description,
          'noindex', p.noindex,
          'query_json', p.query_json,
          'territory_code', p.territory_code,
          'language_code', p.language_code
        )) FROM (
          SELECT * FROM storefront_pages
          WHERE path='/' AND status='published'
            AND (starts_at IS NULL OR starts_at<=datetime('now'))
            AND (ends_at IS NULL OR ends_at>datetime('now'))
          ORDER BY rowid LIMIT 65
        ) p) homepage_presentation_json`
    : "";
  // Cookie-free homepage requests have no currency override or account
  // preference. Negotiate their locale and read its translations/payment
  // methods in this same primary snapshot, avoiding the dependent D1 batch.
  // Other callers retain the full preference-aware resolver below.
  const anonymousPrelude = anonymousLocales ? `WITH RECURSIVE
    active_market AS MATERIALIZED (
      SELECT * FROM storefront_markets WHERE country_code=? AND market_status='active'
    ), active_locales AS MATERIALIZED (
      SELECT l.*,ml.priority FROM active_market m
      JOIN storefront_market_locales ml ON ml.country_code=m.country_code AND ml.active=1
      JOIN storefront_locales l ON l.locale=ml.locale AND l.status='active'
    ), requested_locales AS MATERIALIZED (
      SELECT CAST(j.key AS INTEGER) preference,lower(replace(trim(j.value),'_','-')) tag
      FROM active_market m,json_each(json_insert(?,'$[#]',m.default_locale)) j
    ), chosen_locale AS MATERIALIZED (
      SELECT l.* FROM active_locales l ORDER BY
        COALESCE((SELECT MIN(r.preference*2+CASE WHEN lower(l.locale)=r.tag THEN 0 ELSE 1 END)
          FROM requested_locales r WHERE lower(l.locale)=r.tag
            OR lower(l.language_code)=CASE WHEN instr(r.tag,'-')>0
              THEN substr(r.tag,1,instr(r.tag,'-')-1) ELSE r.tag END),2147483647),
        l.priority,l.locale LIMIT 1
    ), locale_chain(locale,depth,seen) AS (
      SELECT locale,0,','||lower(locale)||',' FROM chosen_locale
      UNION ALL
      SELECT l.fallback_locale,c.depth+1,c.seen||lower(l.fallback_locale)||','
      FROM locale_chain c JOIN storefront_locales l ON l.locale=c.locale AND l.status='active'
      WHERE l.fallback_locale IS NOT NULL AND c.depth<4
        AND instr(c.seen,','||lower(l.fallback_locale)||',')=0
    ), ordered_locales AS (
      SELECT locale,depth precedence FROM locale_chain
      UNION ALL SELECT 'en-US',99
      WHERE NOT EXISTS(SELECT 1 FROM locale_chain WHERE lower(locale)='en-us')
    )` : "";
  const anonymousProjection = anonymousLocales ? `,
    (SELECT json_group_array(json_object('payment_method',payment_method,'provider',provider,
      'currency',currency,'availability',availability,'priority',priority)) FROM (
        SELECT * FROM storefront_payment_methods WHERE country_code=m.country_code
          AND availability='available' AND (currency IS NULL OR currency=upper(m.default_currency))
        ORDER BY priority,payment_method
    )) payment_methods_json,
    (SELECT json_group_array(json_object('message_key',message_key,'message_value',message_value)) FROM (
      SELECT t.message_key,t.message_value FROM ordered_locales o
      JOIN ui_translation_bundles b ON b.id=(SELECT id FROM ui_translation_bundles
        WHERE locale=o.locale AND status='active' ORDER BY version DESC LIMIT 1)
      JOIN ui_translation_messages t ON t.bundle_id=b.id ORDER BY o.precedence DESC
    )) translation_messages_json` : "";
  const rows = (
    await db
      .prepare(
        `${anonymousPrelude}
          SELECT m.*,l.locale active_locale,l.language_code active_language_code,
          l.direction active_direction,${anonymousLocales ? "l" : "ml"}.priority active_priority
          ${marketProjection}${anonymousProjection}
          ${anonymousLocales ? "FROM active_market m LEFT JOIN chosen_locale l ON 1=1" : `FROM storefront_markets m
          LEFT JOIN storefront_market_locales ml
            ON ml.country_code=m.country_code AND ml.active=1
          LEFT JOIN storefront_locales l
            ON l.locale=ml.locale AND l.status='active'
          WHERE m.country_code=? AND m.market_status='active'
          ORDER BY ml.priority,l.locale`}`,
      )
      .bind(...(anonymousLocales ? [country, JSON.stringify(anonymousLocales)] : [country]))
      .all<any>()
  ).results;
  const availableMarkets: Awaited<ReturnType<typeof storefrontMarkets>> | undefined =
    includeMarkets && rows[0]
      ? (JSON.parse(String(rows[0].available_markets_json || "[]")) as any[]).map((row) => ({
          countryCode: String(row.countryCode),
          displayName: String(row.displayName),
          defaultLocale: String(row.defaultLocale),
          defaultCurrency: String(row.defaultCurrency),
          taxInclusive: !!row.taxInclusive,
          checkoutEnabled: !!row.checkoutEnabled,
          locales: String(row.locales || "")
            .split(",")
            .filter(Boolean),
        }))
      : undefined;
  // A 65th row signals overflow; the consumer must use its live D1 page
  // lookup rather than omit a territory/language entry.
  const homepageRows = includeMarkets && rows[0]
    ? (JSON.parse(String(rows[0].homepage_presentation_json || "[]")) as Record<string, unknown>[])
    : null;
  return {
    selectedMarket: rows[0] || null,
    availableMarkets,
    homepageRows,
    anonymousDetails: anonymousLocales && rows[0] ? {
      paymentMethods: { results: JSON.parse(String(rows[0].payment_methods_json || "[]")) as PaymentMethodRow[] },
      translationRows: { results: JSON.parse(String(rows[0].translation_messages_json || "[]")) as TranslationRow[] },
    } : null,
    localeRows: rows
      .filter((row) => row.active_locale)
      .map((row) => ({
        locale: row.active_locale,
        language_code: row.active_language_code,
        direction: row.active_direction,
        priority: row.active_priority,
      })),
  };
}

function chooseSupportedLocale(rows: any[], requested: string[]) {
  if (!rows.length) return null;
  const exact = new Map(rows.map((r) => [String(r.locale).toLowerCase(), r]));
  for (const raw of requested) {
    const normalized = raw.trim().replace(/_/g, "-").toLowerCase();
    if (exact.has(normalized)) return exact.get(normalized);
    const lang = normalized.split("-")[0];
    const sameLanguage = rows.find((r) => String(r.language_code).toLowerCase() === lang);
    if (sameLanguage) return sameLanguage;
  }
  return rows[0];
}

function messageStatement(db: StorefrontDB, locale: string) {
  // One recursive SQL read, now bundled with payment metadata through
  // db.batch. Follow up to five configured locale fallbacks,
  // detect cycles, then merge English first and the requested locale last.
  return db
    .prepare(
      `WITH RECURSIVE locale_chain(locale,depth,seen) AS (
          SELECT ? AS locale,0 AS depth,','||lower(?)||',' AS seen
          UNION ALL
          SELECT l.fallback_locale,c.depth+1,c.seen||lower(l.fallback_locale)||','
          FROM locale_chain c JOIN storefront_locales l ON l.locale=c.locale AND l.status='active'
          WHERE l.fallback_locale IS NOT NULL AND c.depth<4
            AND instr(c.seen,','||lower(l.fallback_locale)||',')=0
        ), ordered_locales AS (
          SELECT locale,depth AS precedence FROM locale_chain
          UNION ALL SELECT 'en-US',99
          WHERE NOT EXISTS(SELECT 1 FROM locale_chain WHERE lower(locale)='en-us')
        )
        SELECT m.message_key,m.message_value
        FROM ordered_locales o
        JOIN ui_translation_bundles b ON b.id=(
          SELECT id FROM ui_translation_bundles
          WHERE locale=o.locale AND status='active'
          ORDER BY version DESC LIMIT 1
        )
        JOIN ui_translation_messages m ON m.bundle_id=b.id
        ORDER BY o.precedence DESC`,
    )
    .bind(locale, locale);
}

function mergeMessages(rows: { message_key: string; message_value: string }[]) {
  const messages: Record<string, string> = {};
  for (const row of rows) messages[String(row.message_key)] = String(row.message_value);
  return messages;
}

export async function resolveStorefrontContext(
  db: StorefrontDB,
  request: Request,
  userId: string | null,
  fallbackCountry = "US",
  includeMarkets = false,
  onHomePageRows?: (rows: Record<string, unknown>[] | null) => void,
): Promise<StorefrontContext> {
  const network = networkCountry(request, fallbackCountry);
  const pref = await preference(db, userId);
  const prefLocale = String(pref?.locale || cookie(request, "fore-locale") || "").trim();
  const requestedLocales = [
    ...(prefLocale ? [prefLocale] : []),
    ...parseAcceptLanguage(request.headers.get("accept-language") || ""),
  ];
  const anonymousLocales = includeMarkets && !userId && !request.headers.has("cookie")
    ? requestedLocales : undefined;
  const cookieCountry = cookie(request, "fore-storefront-country").toUpperCase();
  const requestedCountry = /^[A-Z]{2}$/.test(String(pref?.country_code || ""))
    ? String(pref.country_code)
    : /^[A-Z]{2}$/.test(cookieCountry)
      ? cookieCountry
      : null;

  // Country selection is a merchandising/localization preference. Legal availability remains anchored to
  // the network market unless a future verified account-country adapter records country_source=billing/account.
  let effectiveCountry = requestedCountry || network.country;
  let countrySource = requestedCountry ? pref?.country_source || "user" : network.source;
  if (
    requestedCountry &&
    requestedCountry !== network.country &&
    !["billing", "account"].includes(String(pref?.country_source || ""))
  ) {
    effectiveCountry = network.country;
    countrySource = network.source;
  }
  let { selectedMarket, localeRows, availableMarkets, homepageRows, anonymousDetails } = await marketWithSupportedLocales(
    db,
    effectiveCountry,
    includeMarkets,
    anonymousLocales,
  );
  if (!selectedMarket) {
    effectiveCountry = network.country;
    countrySource = network.source;
    ({ selectedMarket, localeRows, availableMarkets, homepageRows, anonymousDetails } = await marketWithSupportedLocales(
      db,
      effectiveCountry,
      includeMarkets,
      anonymousLocales,
    ));
  }
  if (!selectedMarket) {
    effectiveCountry = "US";
    countrySource = "default";
    ({ selectedMarket, localeRows, availableMarkets, homepageRows, anonymousDetails } = await marketWithSupportedLocales(
      db,
      "US",
      includeMarkets,
      anonymousLocales,
    ));
  }
  if (!selectedMarket) throw new ApiError(503, "No active Cove storefront market is configured.");

  requestedLocales.push(String(selectedMarket.default_locale));
  const loc = chooseSupportedLocale(localeRows, requestedLocales);
  if (!loc) throw new ApiError(503, "This storefront has no active locale configured.");

  const requestedCurrency = String(
    pref?.currency || cookie(request, "fore-currency") || "",
  ).toUpperCase();
  let currency = String(selectedMarket.default_currency).toUpperCase(),
    currencySource = "market";
  if (/^[A-Z]{3}$/.test(requestedCurrency)) {
    const allowed = await db
      .prepare(
        "SELECT 1 ok FROM storefront_currency_options WHERE country_code=? AND currency=? AND active=1",
      )
      .bind(effectiveCountry, requestedCurrency)
      .first<any>();
    if (allowed) {
      currency = requestedCurrency;
      currencySource = "preference";
    }
  }

  // Both queries depend on resolved locale/currency, but not on each
  // other. D1.batch sends them in ONE database service round trip instead
  // of two independent session requests; SQL executes sequentially under
  // one consistent D1 session. This read-only batch cannot grant rights.
  const [paymentMethods, translationRows] = anonymousDetails
    ? [anonymousDetails.paymentMethods, anonymousDetails.translationRows]
    : (await db.batch([
    db
      .prepare(
        `SELECT payment_method,provider,currency,availability,priority FROM storefront_payment_methods
    WHERE country_code=? AND availability='available' AND (currency IS NULL OR currency=?) ORDER BY priority,payment_method`,
      )
      .bind(effectiveCountry, currency),
    messageStatement(db, String(loc.locale)),
  ])) as [
    {
      results: {
        payment_method: string;
        provider: string;
        currency: string | null;
        availability: string;
        priority: number;
      }[];
    },
    { results: { message_key: string; message_value: string }[] },
  ];
  const messages = mergeMessages(translationRows.results);
  const methods = paymentMethods.results;
  if (includeMarkets) onHomePageRows?.(homepageRows);
  return {
    storefrontCountry: effectiveCountry,
    rightsCountry:
      ["billing", "account"].includes(String(pref?.country_source || "")) &&
      effectiveCountry === requestedCountry
        ? effectiveCountry
        : network.country,
    networkCountry: network.source === "network" ? network.country : null,
    locale: String(loc.locale),
    language: String(loc.language_code),
    currency,
    direction: String(loc.direction) === "rtl" ? "rtl" : "ltr",
    taxInclusive: !!selectedMarket.tax_inclusive_default,
    recommendationRegion: String(selectedMarket.recommendation_region || "global"),
    merchandisingRegion: String(selectedMarket.merchandising_region || "global"),
    checkoutEnabled: !!selectedMarket.checkout_enabled,
    source: {
      country: countrySource,
      locale: prefLocale ? "preference" : "negotiated",
      currency: currencySource,
    },
    paymentMethods: methods.map((m) => ({
      paymentMethod: String(m.payment_method),
      provider: String(m.provider),
      currency: m.currency ? String(m.currency) : null,
      availability: String(m.availability),
      priority: Number(m.priority || 100),
    })),
    messages,
    uiMessages: selectedUiCatalog(String(loc.locale)),
    requestedCountry:
      requestedCountry && requestedCountry !== effectiveCountry ? requestedCountry : null,
    ...(includeMarkets ? { availableMarkets: availableMarkets || [] } : {}),
  };
}

export async function saveStorefrontPreferences(
  db: StorefrontDB,
  userId: string | null,
  raw: unknown,
) {
  const x = z
    .object({
      country: countrySchema.optional(),
      locale: localeSchema.optional(),
      currency: currencySchema.optional(),
    })
    .strict()
    .parse(raw);
  if (!x.country && !x.locale && !x.currency)
    throw new ApiError(400, "Choose a storefront country, locale, or currency to update.");
  if (x.country) {
    const row = await market(db, x.country);
    if (!row) throw new ApiError(400, "That Cove storefront is not currently active.");
  }
  if (x.locale) {
    const row = await db
      .prepare("SELECT 1 ok FROM storefront_locales WHERE locale=? AND status='active'")
      .bind(x.locale)
      .first<any>();
    if (!row) throw new ApiError(400, "That locale is not currently supported.");
  }
  if (userId) {
    const current = await preference(db, userId);
    const country = x.country || current?.country_code || null;
    const locale = x.locale || current?.locale || null;
    const currency = x.currency || current?.currency || null;
    if (country && locale) {
      const allowed = await db
        .prepare(
          "SELECT 1 ok FROM storefront_market_locales WHERE country_code=? AND locale=? AND active=1",
        )
        .bind(country, locale)
        .first<any>();
      if (!allowed)
        throw new ApiError(400, "That locale is not enabled for the selected storefront.");
    }
    if (country && currency) {
      const allowed = await db
        .prepare(
          "SELECT 1 ok FROM storefront_currency_options WHERE country_code=? AND currency=? AND active=1",
        )
        .bind(country, currency)
        .first<any>();
      if (!allowed)
        throw new ApiError(400, "That currency is not enabled for the selected storefront.");
    }
    const countrySource = x.country ? "user" : String(current?.country_source || "user");
    await db
      .prepare(
        `INSERT INTO storefront_user_preferences(user_id,country_code,locale,currency,country_source,updated_at) VALUES(?,?,?,?,?,?)
      ON CONFLICT(user_id) DO UPDATE SET country_code=excluded.country_code,locale=excluded.locale,currency=excluded.currency,country_source=excluded.country_source,updated_at=excluded.updated_at`,
      )
      .bind(userId, country, locale, currency, countrySource, now())
      .run();
  }
  return { saved: true, preferences: x };
}

export function storefrontPreferenceCookies(
  raw: { country?: string; locale?: string; currency?: string },
  secure: boolean,
) {
  const attrs = `Path=/; Max-Age=31536000; SameSite=Lax${secure ? "; Secure" : ""}`;
  const out: string[] = [];
  if (raw.country) out.push(`fore-storefront-country=${encodeURIComponent(raw.country)}; ${attrs}`);
  if (raw.locale) out.push(`fore-locale=${encodeURIComponent(raw.locale)}; ${attrs}`);
  if (raw.currency) out.push(`fore-currency=${encodeURIComponent(raw.currency)}; ${attrs}`);
  return out;
}

export async function storefrontMarkets(db: StorefrontDB) {
  const markets = (
    await db
      .prepare(
        `SELECT m.*,GROUP_CONCAT(ml.locale,',') locales FROM storefront_markets m LEFT JOIN storefront_market_locales ml ON ml.country_code=m.country_code AND ml.active=1
    WHERE m.market_status='active' GROUP BY m.country_code ORDER BY m.display_name`,
      )
      .all<any>()
  ).results;
  return markets.map((m) => ({
    countryCode: String(m.country_code),
    displayName: String(m.display_name),
    defaultLocale: String(m.default_locale),
    defaultCurrency: String(m.default_currency),
    taxInclusive: !!m.tax_inclusive_default,
    checkoutEnabled: !!m.checkout_enabled,
    locales: String(m.locales || "")
      .split(",")
      .filter(Boolean),
  }));
}

export async function recordStorefrontContext(
  db: StorefrontDB,
  context: StorefrontContext,
  userId: string | null,
  sessionFingerprint?: string | null,
) {
  try {
    await db
      .prepare(
        "INSERT INTO storefront_context_events(id,user_id,session_fingerprint,network_country,storefront_country,rights_country,tax_country,locale,currency,source_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
      )
      .bind(
        `sfctx_${crypto.randomUUID()}`,
        userId,
        sessionFingerprint || null,
        context.networkCountry,
        context.storefrontCountry,
        context.rightsCountry,
        null,
        context.locale,
        context.currency,
        JSON.stringify(context.source),
        now(),
      )
      .run();
  } catch {}
}

export async function localizationAdminSnapshot(db: StorefrontDB) {
  const [markets, locales, bundles, methods, localizedNodes] = await Promise.all([
    db.prepare("SELECT * FROM storefront_markets ORDER BY display_name").all<any>(),
    db.prepare("SELECT * FROM storefront_locales ORDER BY language_code,locale").all<any>(),
    db.prepare("SELECT * FROM ui_translation_bundles ORDER BY locale,version DESC").all<any>(),
    db
      .prepare(
        "SELECT * FROM storefront_payment_methods ORDER BY country_code,priority,payment_method",
      )
      .all<any>(),
    db
      .prepare(
        "SELECT l.*,n.path FROM storefront_taxonomy_node_localizations l JOIN storefront_taxonomy_nodes n ON n.id=l.taxonomy_node_id ORDER BY l.locale,n.path LIMIT 2000",
      )
      .all<any>(),
  ]);
  return {
    markets: markets.results,
    locales: locales.results,
    bundles: bundles.results,
    paymentMethods: methods.results,
    taxonomyLocalizations: localizedNodes.results,
  };
}

/** Canonical market management is private-owner-only. No shared D1
 * fallback, including on Vercel or when the owner has not been enrolled. */
export async function upsertMarket(
  db: StorefrontDB, actorUserId: string, raw: unknown,
  identity?: {id:string;authProvider?:string;authSubject?:string;aal?:string}|null,
) {
  const market = z.object({
    countryCode: countrySchema,
    displayName: z.string().min(1).max(120),
    defaultLocale: localeSchema,
    defaultCurrency: currencySchema,
    taxInclusive: z.boolean().default(false),
    status: z.enum(["draft","active","paused","retired"]).default("active"),
    recommendationRegion: z.string().min(1).max(80).default("global"),
    merchandisingRegion: z.string().min(1).max(80).default("global"),
    checkoutEnabled: z.boolean().default(true),
  }).strict().parse(raw);
  if(!identity || identity.id !== actorUserId || !identity.authProvider ||
     !identity.authSubject || !["aal1","aal2"].includes(identity.aal||""))
    throw new ApiError(503,"Market authority requires a verified staff identity.");
  return dispatchPrivateMarketUpsert(db,{
    actor:{userId:actorUserId,authProvider:identity.authProvider,
      authSubject:identity.authSubject,aal:identity.aal as "aal1"|"aal2"},
    market,
  });
}

export async function upsertTaxonomyLocalization(
  db: StorefrontDB,
  actorUserId: string,
  raw: unknown,
) {
  const x = z
      .object({
        taxonomyNodeId: z.string().min(1),
        locale: localeSchema,
        name: z.string().min(1).max(160),
        description: z.string().max(1200).default(""),
        seoTitle: z.string().max(200).default(""),
        seoDescription: z.string().max(400).default(""),
      })
      .parse(raw),
    at = now();
  const [node, locale] = await Promise.all([
    db
      .prepare("SELECT 1 ok FROM storefront_taxonomy_nodes WHERE id=?")
      .bind(x.taxonomyNodeId)
      .first<any>(),
    db
      .prepare("SELECT 1 ok FROM storefront_locales WHERE locale=? AND status='active'")
      .bind(x.locale)
      .first<any>(),
  ]);
  if (!node || !locale) throw new ApiError(400, "Unknown taxonomy node or locale.");
  await db
    .prepare(
      `INSERT INTO storefront_taxonomy_node_localizations(taxonomy_node_id,locale,name,description,seo_title,seo_description,updated_by_user_id,updated_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(taxonomy_node_id,locale) DO UPDATE SET name=excluded.name,description=excluded.description,seo_title=excluded.seo_title,seo_description=excluded.seo_description,updated_by_user_id=excluded.updated_by_user_id,updated_at=excluded.updated_at`,
    )
    .bind(
      x.taxonomyNodeId,
      x.locale,
      x.name,
      x.description,
      x.seoTitle,
      x.seoDescription,
      actorUserId,
      at,
    )
    .run();
  return { saved: true };
}

async function sha256Text(value: string) {
  const bytes = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  );
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function upsertLocale(db: StorefrontDB, actorUserId: string, raw: unknown) {
  const x = z
      .object({
        locale: localeSchema,
        languageCode: z.string().regex(/^[a-zA-Z]{2,3}$/),
        scriptCode: z
          .string()
          .regex(/^[A-Za-z]{4}$/)
          .default("Latn"),
        regionCode: z
          .string()
          .regex(/^[A-Z]{2}$/)
          .nullable()
          .optional(),
        displayName: z.string().min(1).max(120),
        nativeName: z.string().min(1).max(120),
        direction: z.enum(["ltr", "rtl"]),
        fallbackLocale: localeSchema.nullable().optional(),
        status: z.enum(["draft", "active", "retired"]).default("active"),
        requiredCoverageBps: z.number().int().min(0).max(10000).default(9500),
      })
      .parse(raw),
    at = now();
  if (x.fallbackLocale === x.locale)
    throw new ApiError(400, "A locale cannot fall back to itself.");
  if (x.fallbackLocale) {
    const fallback = await db
      .prepare("SELECT 1 ok FROM storefront_locales WHERE locale=?")
      .bind(x.fallbackLocale)
      .first<any>();
    if (!fallback) throw new ApiError(400, "Fallback locale does not exist.");
  }
  await db
    .prepare(
      `INSERT INTO storefront_locales(locale,language_code,script_code,region_code,display_name,native_name,direction,fallback_locale,status,required_translation_coverage_bps,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(locale) DO UPDATE SET language_code=excluded.language_code,script_code=excluded.script_code,region_code=excluded.region_code,display_name=excluded.display_name,native_name=excluded.native_name,direction=excluded.direction,fallback_locale=excluded.fallback_locale,status=excluded.status,required_translation_coverage_bps=excluded.required_translation_coverage_bps,updated_at=excluded.updated_at`,
    )
    .bind(
      x.locale,
      x.languageCode.toLowerCase(),
      x.scriptCode,
      x.regionCode || null,
      x.displayName,
      x.nativeName,
      x.direction,
      x.fallbackLocale || null,
      x.status,
      x.requiredCoverageBps,
      at,
      at,
    )
    .run();
  return { saved: true, locale: x.locale, actorUserId };
}

export async function saveTranslationBundle(db: StorefrontDB, actorUserId: string, raw: unknown) {
  const x = z
      .object({
        locale: localeSchema,
        version: z.number().int().positive().optional(),
        source: z.string().min(1).max(120).default("fore"),
        messages: z
          .record(z.string().max(5000))
          .refine((v) => Object.keys(v).length <= 5000, "Too many translation messages."),
        activate: z.boolean().default(false),
      })
      .parse(raw),
    at = now();
  const locale = await db
    .prepare(
      "SELECT required_translation_coverage_bps,status FROM storefront_locales WHERE locale=?",
    )
    .bind(x.locale)
    .first<any>();
  if (!locale || locale.status === "retired")
    throw new ApiError(400, "The locale is not available for translation.");
  const baseRows = (
    await db
      .prepare(
        `SELECT m.message_key FROM ui_translation_messages m JOIN ui_translation_bundles b ON b.id=m.bundle_id WHERE b.locale='en-US' AND b.status='active'`,
      )
      .all<any>()
  ).results;
  const baseKeys = new Set(baseRows.map((r) => String(r.message_key))),
    keys = Object.keys(x.messages).filter((k) => k.trim()),
    translated = keys.filter(
      (k) => String(x.messages[k] || "").trim() && (!baseKeys.size || baseKeys.has(k)),
    ).length,
    total = baseKeys.size || keys.length,
    coverage = total ? Math.min(10000, Math.floor((translated * 10000) / total)) : 0;
  if (x.activate && coverage < Number(locale.required_translation_coverage_bps || 9500))
    throw new ApiError(
      409,
      `Translation coverage is ${coverage / 100}% but this locale requires ${Number(locale.required_translation_coverage_bps || 9500) / 100}%.`,
    );
  const version =
      x.version ||
      Number(
        (
          await db
            .prepare(
              "SELECT COALESCE(MAX(version),0)+1 next_version FROM ui_translation_bundles WHERE locale=?",
            )
            .bind(x.locale)
            .first<any>()
        )?.next_version || 1,
      ),
    bundleId = `uib_${x.locale.toLowerCase().replace(/[^a-z0-9]+/g, "_")}_v${version}`,
    canonical = JSON.stringify(
      Object.fromEntries(Object.entries(x.messages).sort(([a], [b]) => a.localeCompare(b))),
    ),
    checksum = await sha256Text(canonical),
    status = x.activate ? "active" : "review";
  const statements: any[] = [];
  if (x.activate)
    statements.push(
      db
        .prepare(
          "UPDATE ui_translation_bundles SET status='retired' WHERE locale=? AND status='active' AND id<>?",
        )
        .bind(x.locale, bundleId),
    );
  statements.push(
    db
      .prepare(
        `INSERT INTO ui_translation_bundles(id,locale,version,status,source,message_count,translated_count,coverage_bps,checksum_sha256,created_by_user_id,created_at,activated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(locale,version) DO UPDATE SET status=excluded.status,source=excluded.source,message_count=excluded.message_count,translated_count=excluded.translated_count,coverage_bps=excluded.coverage_bps,checksum_sha256=excluded.checksum_sha256,activated_at=excluded.activated_at`,
      )
      .bind(
        bundleId,
        x.locale,
        version,
        status,
        x.source,
        keys.length,
        translated,
        coverage,
        checksum,
        actorUserId,
        at,
        x.activate ? at : null,
      ),
  );
  statements.push(
    db.prepare("DELETE FROM ui_translation_messages WHERE bundle_id=?").bind(bundleId),
  );
  for (const [key, value] of Object.entries(x.messages))
    statements.push(
      db
        .prepare(
          "INSERT INTO ui_translation_messages(bundle_id,message_key,message_value,description,updated_at) VALUES(?,?,?,'',?)",
        )
        .bind(bundleId, key, String(value), at),
    );
  await db.batch(statements);
  return {
    id: bundleId,
    locale: x.locale,
    version,
    status,
    coverageBps: coverage,
    checksumSha256: checksum,
  };
}

export async function configureMarketOptions(db: StorefrontDB, actorUserId: string, raw: unknown) {
  const x = z
      .object({
        countryCode: countrySchema,
        locales: z.array(localeSchema).min(1).max(20),
        currencies: z.array(currencySchema).min(1).max(10),
        paymentMethods: z
          .array(
            z.object({
              paymentMethod: z.string().regex(/^[a-z0-9_-]{2,80}$/),
              provider: z.string().min(1).max(80).default("stripe"),
              currency: currencySchema.nullable().optional(),
              availability: z.enum(["available", "planned", "disabled"]),
              priority: z.number().int().min(0).max(10000).default(100),
              config: z.record(z.any()).default({}),
            }),
          )
          .max(100)
          .default([]),
      })
      .parse(raw),
    market = await db
      .prepare(
        "SELECT default_locale,default_currency FROM storefront_markets WHERE country_code=?",
      )
      .bind(x.countryCode)
      .first<any>();
  if (!market) throw new ApiError(404, "Storefront market not found.");
  if (
    !x.locales.includes(String(market.default_locale)) ||
    !x.currencies.includes(String(market.default_currency))
  )
    throw new ApiError(400, "Market options must include its default locale and currency.");
  const at = now(),
    statements: any[] = [
      db.prepare("DELETE FROM storefront_market_locales WHERE country_code=?").bind(x.countryCode),
      db
        .prepare("DELETE FROM storefront_currency_options WHERE country_code=?")
        .bind(x.countryCode),
      db.prepare("DELETE FROM storefront_payment_methods WHERE country_code=?").bind(x.countryCode),
    ];
  x.locales.forEach((loc, i) =>
    statements.push(
      db
        .prepare(
          "INSERT INTO storefront_market_locales(country_code,locale,priority,active) VALUES(?,?,?,1)",
        )
        .bind(x.countryCode, loc, i + 1),
    ),
  );
  x.currencies.forEach((cur, i) =>
    statements.push(
      db
        .prepare(
          "INSERT INTO storefront_currency_options(country_code,currency,priority,active) VALUES(?,?,?,1)",
        )
        .bind(x.countryCode, cur, i + 1),
    ),
  );
  x.paymentMethods.forEach((m) =>
    statements.push(
      db
        .prepare(
          "INSERT INTO storefront_payment_methods(country_code,payment_method,provider,currency,availability,priority,config_json,updated_at) VALUES(?,?,?,?,?,?,?,?)",
        )
        .bind(
          x.countryCode,
          m.paymentMethod,
          m.provider,
          m.currency || null,
          m.availability,
          m.priority,
          JSON.stringify(m.config),
          at,
        ),
    ),
  );
  await db.batch(statements);
  return { saved: true, countryCode: x.countryCode, actorUserId };
}
