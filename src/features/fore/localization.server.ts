import { z } from "zod";
import { ApiError, now } from "./service";

export type StorefrontDB = {
  prepare(sql: string): { bind(...values: unknown[]): any; first<T = any>(): Promise<T | null>; all<T = any>(): Promise<{ results: T[] }>; run(): Promise<any> };
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
  paymentMethods: { paymentMethod: string; provider: string; currency: string | null; availability: string; priority: number }[];
  messages: Record<string, string>;
  requestedCountry?: string | null;
};

const countrySchema = z.string().trim().toUpperCase().regex(/^[A-Z]{2}$/);
const localeSchema = z.string().trim().regex(/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,2}$/).max(35);
const currencySchema = z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/);

const blockedNetworkCodes = new Set(["XX", "T1", "ZZ"]);
const cookie = (request: Request, key: string) => {
  const raw = request.headers.get("cookie") || "";
  for (const pair of raw.split(";")) {
    const [k, ...rest] = pair.trim().split("=");
    if (k === key) {
      try { return decodeURIComponent(rest.join("=")); } catch { return rest.join("="); }
    }
  }
  return "";
};

function networkCountry(request: Request, fallback: string) {
  const cf = String(
    request.headers.get("x-cove-client-country") ||
      request.headers.get("cf-ipcountry") ||
      "",
  ).trim().toUpperCase();
  if (/^[A-Z]{2}$/.test(cf) && !blockedNetworkCodes.has(cf)) return { country: cf, source: "network" };
  const safe = /^[A-Z]{2}$/.test(String(fallback || "").toUpperCase()) ? String(fallback).toUpperCase() : "US";
  return { country: safe, source: "default" };
}

function parseAcceptLanguage(value: string) {
  return value.split(",").map((part, index) => {
    const [tag, ...params] = part.trim().split(";");
    let q = 1;
    for (const p of params) if (p.trim().startsWith("q=")) q = Number(p.trim().slice(2)) || 0;
    return { tag, q, index };
  }).filter((x) => x.tag && x.tag !== "*").sort((a, b) => b.q - a.q || a.index - b.index).map((x) => x.tag);
}

async function market(db: StorefrontDB, country: string) {
  return db.prepare("SELECT * FROM storefront_markets WHERE country_code=? AND market_status='active'").bind(country).first<any>();
}

async function preference(db: StorefrontDB, userId: string | null) {
  if (!userId) return null;
  return db.prepare("SELECT * FROM storefront_user_preferences WHERE user_id=?").bind(userId).first<any>();
}

async function supportedLocale(db: StorefrontDB, country: string, requested: string[]) {
  const rows = (await db.prepare(`SELECT l.*,ml.priority FROM storefront_market_locales ml JOIN storefront_locales l ON l.locale=ml.locale
    WHERE ml.country_code=? AND ml.active=1 AND l.status='active' ORDER BY ml.priority,l.locale`).bind(country).all<any>()).results;
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

async function loadMessages(db: StorefrontDB, locale: string) {
  const result: Record<string, string> = {};
  const visited = new Set<string>();
  let cursor: string | null = locale;
  // Apply fallback first, locale last, so the most specific active bundle wins.
  const chain: string[] = [];
  while (cursor && !visited.has(cursor) && chain.length < 5) {
    visited.add(cursor); chain.push(cursor);
    const row = await db.prepare("SELECT fallback_locale FROM storefront_locales WHERE locale=? AND status='active'").bind(cursor).first<any>();
    cursor = row?.fallback_locale ? String(row.fallback_locale) : null;
  }
  if (!chain.some((x) => x.toLowerCase() === "en-us")) chain.push("en-US");
  for (const loc of chain.reverse()) {
    const bundle = await db.prepare("SELECT id FROM ui_translation_bundles WHERE locale=? AND status='active' ORDER BY version DESC LIMIT 1").bind(loc).first<any>();
    if (!bundle) continue;
    const rows = (await db.prepare("SELECT message_key,message_value FROM ui_translation_messages WHERE bundle_id=?").bind(bundle.id).all<any>()).results;
    for (const row of rows) result[String(row.message_key)] = String(row.message_value);
  }
  return result;
}

export async function resolveStorefrontContext(db: StorefrontDB, request: Request, userId: string | null, fallbackCountry = "US"): Promise<StorefrontContext> {
  const network = networkCountry(request, fallbackCountry);
  const pref = await preference(db, userId);
  const cookieCountry = cookie(request, "fore-storefront-country").toUpperCase();
  const requestedCountry = /^[A-Z]{2}$/.test(String(pref?.country_code || "")) ? String(pref.country_code) : (/^[A-Z]{2}$/.test(cookieCountry) ? cookieCountry : null);

  // Country selection is a merchandising/localization preference. Legal availability remains anchored to
  // the network market unless a future verified account-country adapter records country_source=billing/account.
  let effectiveCountry = requestedCountry || network.country;
  let countrySource = requestedCountry ? (pref?.country_source || "user") : network.source;
  if (requestedCountry && requestedCountry !== network.country && !["billing", "account"].includes(String(pref?.country_source || ""))) {
    effectiveCountry = network.country;
    countrySource = network.source;
  }
  let selectedMarket = await market(db, effectiveCountry);
  if (!selectedMarket) {
    effectiveCountry = network.country;
    countrySource = network.source;
    selectedMarket = await market(db, effectiveCountry);
  }
  if (!selectedMarket) {
    effectiveCountry = "US";
    countrySource = "default";
    selectedMarket = await market(db, "US");
  }
  if (!selectedMarket) throw new ApiError(503, "No active Cove storefront market is configured.");

  const requestedLocales: string[] = [];
  const prefLocale = String(pref?.locale || cookie(request, "fore-locale") || "").trim();
  if (prefLocale) requestedLocales.push(prefLocale);
  requestedLocales.push(...parseAcceptLanguage(request.headers.get("accept-language") || ""));
  requestedLocales.push(String(selectedMarket.default_locale));
  const loc = await supportedLocale(db, effectiveCountry, requestedLocales);
  if (!loc) throw new ApiError(503, "This storefront has no active locale configured.");

  const requestedCurrency = String(pref?.currency || cookie(request, "fore-currency") || "").toUpperCase();
  let currency = String(selectedMarket.default_currency).toUpperCase(), currencySource = "market";
  if (/^[A-Z]{3}$/.test(requestedCurrency)) {
    const allowed = await db.prepare("SELECT 1 ok FROM storefront_currency_options WHERE country_code=? AND currency=? AND active=1").bind(effectiveCountry, requestedCurrency).first<any>();
    if (allowed) { currency = requestedCurrency; currencySource = "preference"; }
  }

  const methods = (await db.prepare(`SELECT payment_method,provider,currency,availability,priority FROM storefront_payment_methods
    WHERE country_code=? AND availability='available' AND (currency IS NULL OR currency=?) ORDER BY priority,payment_method`).bind(effectiveCountry, currency).all<any>()).results;
  const messages = await loadMessages(db, String(loc.locale));
  return {
    storefrontCountry: effectiveCountry,
    rightsCountry: (["billing", "account"].includes(String(pref?.country_source || "")) && effectiveCountry === requestedCountry) ? effectiveCountry : network.country,
    networkCountry: network.source === "network" ? network.country : null,
    locale: String(loc.locale),
    language: String(loc.language_code),
    currency,
    direction: String(loc.direction) === "rtl" ? "rtl" : "ltr",
    taxInclusive: !!selectedMarket.tax_inclusive_default,
    recommendationRegion: String(selectedMarket.recommendation_region || "global"),
    merchandisingRegion: String(selectedMarket.merchandising_region || "global"),
    checkoutEnabled: !!selectedMarket.checkout_enabled,
    source: { country: countrySource, locale: prefLocale ? "preference" : "negotiated", currency: currencySource },
    paymentMethods: methods.map((m) => ({ paymentMethod: String(m.payment_method), provider: String(m.provider), currency: m.currency ? String(m.currency) : null, availability: String(m.availability), priority: Number(m.priority || 100) })),
    messages,
    requestedCountry: requestedCountry && requestedCountry !== effectiveCountry ? requestedCountry : null,
  };
}

export async function saveStorefrontPreferences(db: StorefrontDB, userId: string | null, raw: unknown) {
  const x = z.object({
    country: countrySchema.optional(), locale: localeSchema.optional(), currency: currencySchema.optional(),
  }).strict().parse(raw);
  if (!x.country && !x.locale && !x.currency) throw new ApiError(400, "Choose a storefront country, locale, or currency to update.");
  if (x.country) {
    const row = await market(db, x.country);
    if (!row) throw new ApiError(400, "That Cove storefront is not currently active.");
  }
  if (x.locale) {
    const row = await db.prepare("SELECT 1 ok FROM storefront_locales WHERE locale=? AND status='active'").bind(x.locale).first<any>();
    if (!row) throw new ApiError(400, "That locale is not currently supported.");
  }
  if (userId) {
    const current = await preference(db, userId);
    const country = x.country || current?.country_code || null;
    const locale = x.locale || current?.locale || null;
    const currency = x.currency || current?.currency || null;
    if (country && locale) {
      const allowed = await db.prepare("SELECT 1 ok FROM storefront_market_locales WHERE country_code=? AND locale=? AND active=1").bind(country, locale).first<any>();
      if (!allowed) throw new ApiError(400, "That locale is not enabled for the selected storefront.");
    }
    if (country && currency) {
      const allowed = await db.prepare("SELECT 1 ok FROM storefront_currency_options WHERE country_code=? AND currency=? AND active=1").bind(country, currency).first<any>();
      if (!allowed) throw new ApiError(400, "That currency is not enabled for the selected storefront.");
    }
    const countrySource = x.country ? "user" : String(current?.country_source || "user");
    await db.prepare(`INSERT INTO storefront_user_preferences(user_id,country_code,locale,currency,country_source,updated_at) VALUES(?,?,?,?,?,?)
      ON CONFLICT(user_id) DO UPDATE SET country_code=excluded.country_code,locale=excluded.locale,currency=excluded.currency,country_source=excluded.country_source,updated_at=excluded.updated_at`)
      .bind(userId,country,locale,currency,countrySource,now()).run();
  }
  return { saved: true, preferences: x };
}

export function storefrontPreferenceCookies(raw: { country?: string; locale?: string; currency?: string }, secure: boolean) {
  const attrs = `Path=/; Max-Age=31536000; SameSite=Lax${secure ? "; Secure" : ""}`;
  const out: string[] = [];
  if (raw.country) out.push(`fore-storefront-country=${encodeURIComponent(raw.country)}; ${attrs}`);
  if (raw.locale) out.push(`fore-locale=${encodeURIComponent(raw.locale)}; ${attrs}`);
  if (raw.currency) out.push(`fore-currency=${encodeURIComponent(raw.currency)}; ${attrs}`);
  return out;
}

export async function storefrontMarkets(db: StorefrontDB) {
  const markets = (await db.prepare(`SELECT m.*,GROUP_CONCAT(ml.locale,',') locales FROM storefront_markets m LEFT JOIN storefront_market_locales ml ON ml.country_code=m.country_code AND ml.active=1
    WHERE m.market_status='active' GROUP BY m.country_code ORDER BY m.display_name`).all<any>()).results;
  return markets.map((m) => ({
    countryCode:String(m.country_code),displayName:String(m.display_name),defaultLocale:String(m.default_locale),defaultCurrency:String(m.default_currency),
    taxInclusive:!!m.tax_inclusive_default,checkoutEnabled:!!m.checkout_enabled,locales:String(m.locales||"").split(",").filter(Boolean),
  }));
}

export async function recordStorefrontContext(db: StorefrontDB, context: StorefrontContext, userId: string | null, sessionFingerprint?: string | null) {
  try {
    await db.prepare("INSERT INTO storefront_context_events(id,user_id,session_fingerprint,network_country,storefront_country,rights_country,tax_country,locale,currency,source_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)")
      .bind(`sfctx_${crypto.randomUUID()}`,userId,sessionFingerprint||null,context.networkCountry,context.storefrontCountry,context.rightsCountry,null,context.locale,context.currency,JSON.stringify(context.source),now()).run();
  } catch {}
}

export async function localizationAdminSnapshot(db: StorefrontDB) {
  const [markets,locales,bundles,methods,localizedNodes] = await Promise.all([
    db.prepare("SELECT * FROM storefront_markets ORDER BY display_name").all<any>(),
    db.prepare("SELECT * FROM storefront_locales ORDER BY language_code,locale").all<any>(),
    db.prepare("SELECT * FROM ui_translation_bundles ORDER BY locale,version DESC").all<any>(),
    db.prepare("SELECT * FROM storefront_payment_methods ORDER BY country_code,priority,payment_method").all<any>(),
    db.prepare("SELECT l.*,n.path FROM storefront_taxonomy_node_localizations l JOIN storefront_taxonomy_nodes n ON n.id=l.taxonomy_node_id ORDER BY l.locale,n.path LIMIT 2000").all<any>(),
  ]);
  return { markets:markets.results,locales:locales.results,bundles:bundles.results,paymentMethods:methods.results,taxonomyLocalizations:localizedNodes.results };
}

export async function upsertMarket(db: StorefrontDB, actorUserId: string, raw: unknown) {
  const x=z.object({countryCode:countrySchema,displayName:z.string().min(1).max(120),defaultLocale:localeSchema,defaultCurrency:currencySchema,taxInclusive:z.boolean().default(false),status:z.enum(["draft","active","paused","retired"]).default("active"),recommendationRegion:z.string().min(1).max(80).default("global"),merchandisingRegion:z.string().min(1).max(80).default("global"),checkoutEnabled:z.boolean().default(true)}).parse(raw),at=now();
  const territory=await db.prepare("SELECT 1 ok FROM territories WHERE code=? AND is_sellable=1").bind(x.countryCode).first<any>();if(!territory)throw new ApiError(400,"Use a configured sellable territory.");
  const locale=await db.prepare("SELECT 1 ok FROM storefront_locales WHERE locale=? AND status='active'").bind(x.defaultLocale).first<any>();if(!locale)throw new ApiError(400,"Default locale must be active.");
  await db.batch([
    db.prepare(`INSERT INTO storefront_markets(country_code,display_name,default_locale,default_currency,tax_inclusive_default,market_status,recommendation_region,merchandising_region,payment_provider,checkout_enabled,launched_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?, 'stripe',?,?,?,?)
      ON CONFLICT(country_code) DO UPDATE SET display_name=excluded.display_name,default_locale=excluded.default_locale,default_currency=excluded.default_currency,tax_inclusive_default=excluded.tax_inclusive_default,market_status=excluded.market_status,recommendation_region=excluded.recommendation_region,merchandising_region=excluded.merchandising_region,checkout_enabled=excluded.checkout_enabled,updated_at=excluded.updated_at`).bind(x.countryCode,x.displayName,x.defaultLocale,x.defaultCurrency,x.taxInclusive?1:0,x.status,x.recommendationRegion,x.merchandisingRegion,x.checkoutEnabled?1:0,x.status==="active"?at:null,at,at),
    db.prepare("INSERT OR IGNORE INTO storefront_market_locales(country_code,locale,priority,active) VALUES(?,?,1,1)").bind(x.countryCode,x.defaultLocale),
    db.prepare("INSERT OR IGNORE INTO storefront_currency_options(country_code,currency,priority,active) VALUES(?,?,1,1)").bind(x.countryCode,x.defaultCurrency),
    db.prepare("INSERT INTO privileged_access_audit(id,request_id,actor_type,actor_id,permission_or_scope,method,path,outcome,response_status,metadata_json,created_at) VALUES(?,?,?,?,?,'INTERNAL','localization.market','completed',200,?,?)").bind(`pa_${crypto.randomUUID()}`,`internal_${crypto.randomUUID()}`,'staff',actorUserId,'localization.manage',JSON.stringify({country:x.countryCode}),at),
  ]);
  return {saved:true,countryCode:x.countryCode};
}

export async function upsertTaxonomyLocalization(db:StorefrontDB,actorUserId:string,raw:unknown){const x=z.object({taxonomyNodeId:z.string().min(1),locale:localeSchema,name:z.string().min(1).max(160),description:z.string().max(1200).default(""),seoTitle:z.string().max(200).default(""),seoDescription:z.string().max(400).default("")}).parse(raw),at=now();const [node,locale]=await Promise.all([db.prepare("SELECT 1 ok FROM storefront_taxonomy_nodes WHERE id=?").bind(x.taxonomyNodeId).first<any>(),db.prepare("SELECT 1 ok FROM storefront_locales WHERE locale=? AND status='active'").bind(x.locale).first<any>()]);if(!node||!locale)throw new ApiError(400,"Unknown taxonomy node or locale.");await db.prepare(`INSERT INTO storefront_taxonomy_node_localizations(taxonomy_node_id,locale,name,description,seo_title,seo_description,updated_by_user_id,updated_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(taxonomy_node_id,locale) DO UPDATE SET name=excluded.name,description=excluded.description,seo_title=excluded.seo_title,seo_description=excluded.seo_description,updated_by_user_id=excluded.updated_by_user_id,updated_at=excluded.updated_at`).bind(x.taxonomyNodeId,x.locale,x.name,x.description,x.seoTitle,x.seoDescription,actorUserId,at).run();return{saved:true};}

async function sha256Text(value:string){const bytes=new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(value)));return [...bytes].map(b=>b.toString(16).padStart(2,"0")).join("");}

export async function upsertLocale(db:StorefrontDB,actorUserId:string,raw:unknown){
  const x=z.object({locale:localeSchema,languageCode:z.string().regex(/^[a-zA-Z]{2,3}$/),scriptCode:z.string().regex(/^[A-Za-z]{4}$/).default("Latn"),regionCode:z.string().regex(/^[A-Z]{2}$/).nullable().optional(),displayName:z.string().min(1).max(120),nativeName:z.string().min(1).max(120),direction:z.enum(["ltr","rtl"]),fallbackLocale:localeSchema.nullable().optional(),status:z.enum(["draft","active","retired"]).default("active"),requiredCoverageBps:z.number().int().min(0).max(10000).default(9500)}).parse(raw),at=now();
  if(x.fallbackLocale===x.locale)throw new ApiError(400,"A locale cannot fall back to itself.");
  if(x.fallbackLocale){const fallback=await db.prepare("SELECT 1 ok FROM storefront_locales WHERE locale=?").bind(x.fallbackLocale).first<any>();if(!fallback)throw new ApiError(400,"Fallback locale does not exist.");}
  await db.prepare(`INSERT INTO storefront_locales(locale,language_code,script_code,region_code,display_name,native_name,direction,fallback_locale,status,required_translation_coverage_bps,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(locale) DO UPDATE SET language_code=excluded.language_code,script_code=excluded.script_code,region_code=excluded.region_code,display_name=excluded.display_name,native_name=excluded.native_name,direction=excluded.direction,fallback_locale=excluded.fallback_locale,status=excluded.status,required_translation_coverage_bps=excluded.required_translation_coverage_bps,updated_at=excluded.updated_at`).bind(x.locale,x.languageCode.toLowerCase(),x.scriptCode,x.regionCode||null,x.displayName,x.nativeName,x.direction,x.fallbackLocale||null,x.status,x.requiredCoverageBps,at,at).run();
  return{saved:true,locale:x.locale,actorUserId};
}

export async function saveTranslationBundle(db:StorefrontDB,actorUserId:string,raw:unknown){
  const x=z.object({locale:localeSchema,version:z.number().int().positive().optional(),source:z.string().min(1).max(120).default("fore"),messages:z.record(z.string().max(5000)).refine(v=>Object.keys(v).length<=5000,"Too many translation messages."),activate:z.boolean().default(false)}).parse(raw),at=now();
  const locale=await db.prepare("SELECT required_translation_coverage_bps,status FROM storefront_locales WHERE locale=?").bind(x.locale).first<any>();if(!locale||locale.status==="retired")throw new ApiError(400,"The locale is not available for translation.");
  const baseRows=(await db.prepare(`SELECT m.message_key FROM ui_translation_messages m JOIN ui_translation_bundles b ON b.id=m.bundle_id WHERE b.locale='en-US' AND b.status='active'`).all<any>()).results;
  const baseKeys=new Set(baseRows.map(r=>String(r.message_key))),keys=Object.keys(x.messages).filter(k=>k.trim()),translated=keys.filter(k=>String(x.messages[k]||"").trim()&&(!baseKeys.size||baseKeys.has(k))).length,total=baseKeys.size||keys.length,coverage=total?Math.min(10000,Math.floor(translated*10000/total)):0;
  if(x.activate&&coverage<Number(locale.required_translation_coverage_bps||9500))throw new ApiError(409,`Translation coverage is ${coverage/100}% but this locale requires ${Number(locale.required_translation_coverage_bps||9500)/100}%.`);
  const version=x.version||Number((await db.prepare("SELECT COALESCE(MAX(version),0)+1 next_version FROM ui_translation_bundles WHERE locale=?").bind(x.locale).first<any>())?.next_version||1),bundleId=`uib_${x.locale.toLowerCase().replace(/[^a-z0-9]+/g,"_")}_v${version}`,canonical=JSON.stringify(Object.fromEntries(Object.entries(x.messages).sort(([a],[b])=>a.localeCompare(b)))),checksum=await sha256Text(canonical),status=x.activate?"active":"review";
  const statements:any[]=[];
  if(x.activate)statements.push(db.prepare("UPDATE ui_translation_bundles SET status='retired' WHERE locale=? AND status='active' AND id<>?").bind(x.locale,bundleId));
  statements.push(db.prepare(`INSERT INTO ui_translation_bundles(id,locale,version,status,source,message_count,translated_count,coverage_bps,checksum_sha256,created_by_user_id,created_at,activated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(locale,version) DO UPDATE SET status=excluded.status,source=excluded.source,message_count=excluded.message_count,translated_count=excluded.translated_count,coverage_bps=excluded.coverage_bps,checksum_sha256=excluded.checksum_sha256,activated_at=excluded.activated_at`).bind(bundleId,x.locale,version,status,x.source,keys.length,translated,coverage,checksum,actorUserId,at,x.activate?at:null));
  statements.push(db.prepare("DELETE FROM ui_translation_messages WHERE bundle_id=?").bind(bundleId));
  for(const [key,value] of Object.entries(x.messages))statements.push(db.prepare("INSERT INTO ui_translation_messages(bundle_id,message_key,message_value,description,updated_at) VALUES(?,?,?,'',?)").bind(bundleId,key,String(value),at));
  await db.batch(statements);return{id:bundleId,locale:x.locale,version,status,coverageBps:coverage,checksumSha256:checksum};
}

export async function configureMarketOptions(db:StorefrontDB,actorUserId:string,raw:unknown){
  const x=z.object({countryCode:countrySchema,locales:z.array(localeSchema).min(1).max(20),currencies:z.array(currencySchema).min(1).max(10),paymentMethods:z.array(z.object({paymentMethod:z.string().regex(/^[a-z0-9_-]{2,80}$/),provider:z.string().min(1).max(80).default("stripe"),currency:currencySchema.nullable().optional(),availability:z.enum(["available","planned","disabled"]),priority:z.number().int().min(0).max(10000).default(100),config:z.record(z.any()).default({})})).max(100).default([])}).parse(raw),market=await db.prepare("SELECT default_locale,default_currency FROM storefront_markets WHERE country_code=?").bind(x.countryCode).first<any>();if(!market)throw new ApiError(404,"Storefront market not found.");
  if(!x.locales.includes(String(market.default_locale))||!x.currencies.includes(String(market.default_currency)))throw new ApiError(400,"Market options must include its default locale and currency.");
  const at=now(),statements:any[]=[db.prepare("DELETE FROM storefront_market_locales WHERE country_code=?").bind(x.countryCode),db.prepare("DELETE FROM storefront_currency_options WHERE country_code=?").bind(x.countryCode),db.prepare("DELETE FROM storefront_payment_methods WHERE country_code=?").bind(x.countryCode)];
  x.locales.forEach((loc,i)=>statements.push(db.prepare("INSERT INTO storefront_market_locales(country_code,locale,priority,active) VALUES(?,?,?,1)").bind(x.countryCode,loc,i+1)));
  x.currencies.forEach((cur,i)=>statements.push(db.prepare("INSERT INTO storefront_currency_options(country_code,currency,priority,active) VALUES(?,?,?,1)").bind(x.countryCode,cur,i+1)));
  x.paymentMethods.forEach(m=>statements.push(db.prepare("INSERT INTO storefront_payment_methods(country_code,payment_method,provider,currency,availability,priority,config_json,updated_at) VALUES(?,?,?,?,?,?,?,?)").bind(x.countryCode,m.paymentMethod,m.provider,m.currency||null,m.availability,m.priority,JSON.stringify(m.config),at)));
  await db.batch(statements);return{saved:true,countryCode:x.countryCode,actorUserId};
}
