import { z } from "zod";
import type { CatalogBook } from "./client";
import { canonicalBooksByProductIds, type CatalogDB } from "./catalog-model.server";
import { searchCatalog, type SearchInput } from "./search.server";
import { ApiError, now } from "./service";
import { recommendationPlacementBooks } from "./recommendations.server";

export type MerchEnv = {
  DB: CatalogDB;
  FORE_SEARCH_BACKEND?: string;
  FORE_SEARCH_URL?: string;
  FORE_SEARCH_SEARCH_KEY?: string;
  FORE_SEARCH_ADMIN_KEY?: string;
  FORE_SEARCH_INDEX?: string;
  FORE_SEARCH_EMBEDDER?: string;
  FORE_RECOMMENDER_URL?: string;
  FORE_RECOMMENDER_API_KEY?: string;
  FORE_RECOMMENDER_MODEL?: string;
};

type PlacementRow = Record<string, any>;

function parseJson<T>(value: unknown, fallback: T): T {
  try {
    return JSON.parse(String(value ?? "")) as T;
  } catch {
    return fallback;
  }
}
function text(value: unknown, max = 300) {
  return String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max);
}
function hash32(value: string) {
  let h = 2166136261;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
function chooseVariant(variantsRaw: unknown, visitorId: string, experimentKey: string) {
  const variants = parseJson<Array<{ key: string; weight: number }>>(variantsRaw, [{ key: "control", weight: 100 }])
    .map((v) => ({ key: text(v.key, 50), weight: Math.max(0, Number(v.weight || 0)) })).filter((v) => v.key && v.weight > 0);
  if (!variants.length) return "control";
  const total = variants.reduce((sum, v) => sum + v.weight, 0);
  let bucket = hash32(`${visitorId}:${experimentKey}`) % total;
  for (const variant of variants) {
    if (bucket < variant.weight) return variant.key;
    bucket -= variant.weight;
  }
  return variants[0].key;
}

function chooseWeighted<T extends { weight?: unknown }>(rows: T[], seed: string): T | null {
  const eligible = rows.filter((row) => Math.max(0, Number(row.weight ?? 100)) > 0);
  if (!eligible.length) return null;
  const total = eligible.reduce((sum, row) => sum + Math.max(0, Number(row.weight ?? 100)), 0);
  let bucket = hash32(seed) % total;
  for (const row of eligible) {
    const weight = Math.max(0, Number(row.weight ?? 100));
    if (bucket < weight) return row;
    bucket -= weight;
  }
  return eligible[0] || null;
}

function assertSchedule(startsAt?: string | null, endsAt?: string | null) {
  if (startsAt && endsAt && Date.parse(startsAt) >= Date.parse(endsAt)) throw new ApiError(400, "The end time must be after the start time.");
}
function safeLink(value: string, allowEmpty = true) {
  const href = value.trim();
  if (!href && allowEmpty) return true;
  return href.startsWith("/") || /^https:\/\//i.test(href);
}

async function audienceContext(db: CatalogDB, userId: string | null) {
  if (!userId) return { authenticated: false, librarySize: 0 };
  const row = await db.prepare("SELECT COUNT(*) count FROM reading_states WHERE user_id=? AND in_library=1").bind(userId).first<any>();
  return { authenticated: true, librarySize: Number(row?.count || 0) };
}
function audienceMatches(audienceRaw: unknown, context: { authenticated: boolean; librarySize: number }) {
  const audience = parseJson<Record<string, unknown>>(audienceRaw, {});
  if (audience.authenticated === true && !context.authenticated) return false;
  if (audience.anonymous === true && context.authenticated) return false;
  const min = Number(audience.minLibrarySize);
  const max = Number(audience.maxLibrarySize);
  if (Number.isFinite(min) && context.librarySize < min) return false;
  if (Number.isFinite(max) && context.librarySize > max) return false;
  return true;
}

function searchInput(query: Record<string, any>, territory: string, maxItems: number): SearchInput {
  const asArray = (v: unknown, max = 8) => Array.isArray(v) ? v.map(String).slice(0, max) : v ? [String(v)] : [];
  const allowedSort = new Set(["relevance","popular","trending","released","published","added","updated","coming_soon","price_asc","price_desc","rating","title"]);
  const sort = allowedSort.has(String(query.sort || "")) ? String(query.sort) : "popular";
  return {
    query: text(query.q || query.search || "", 160), topic: query.topic ? text(query.topic, 100) : undefined,
    taxonomy: asArray(query.taxonomy, 8), categories: asArray(query.categories || query.category, 8),
    languages: asArray(query.languages || query.language, 8).map((x) => x.toLowerCase()), formats: asArray(query.formats || query.format, 4).map((x) => x.toLowerCase()),
    publishers: asArray(query.publishers || query.publisher, 8), series: asArray(query.series, 8),
    contributorIds: asArray(query.contributorIds, 16), seriesIds: asArray(query.seriesIds, 16), publisherIds: asArray(query.publisherIds, 16), imprintIds: asArray(query.imprintIds, 16),
    currency: text(query.currency || "USD", 3).toUpperCase(),
    minPrice: Number.isFinite(Number(query.minPrice)) ? Math.max(0, Math.round(Number(query.minPrice) * 100)) : undefined,
    maxPrice: Number.isFinite(Number(query.maxPrice)) ? Math.max(0, Math.round(Number(query.maxPrice) * 100)) : undefined,
    subscription: typeof query.subscription === "boolean" ? query.subscription : undefined,
    library: typeof query.library === "boolean" ? query.library : undefined,
    minRating: Number.isFinite(Number(query.minRating)) ? Number(query.minRating) : undefined,
    minReviews: Number.isFinite(Number(query.minReviews)) ? Number(query.minReviews) : undefined,
    publishedAfter: query.publishedAfter ? text(query.publishedAfter, 10) : undefined,
    publishedBefore: query.publishedBefore ? text(query.publishedBefore, 10) : undefined,
    preorder: typeof query.preorder === "boolean" ? query.preorder : undefined,
    newRelease: typeof query.newRelease === "boolean" ? query.newRelease : undefined,
    deals: typeof query.deals === "boolean" ? query.deals : undefined,
    availability: text(query.availability || "available", 30), territory, sort,
    page: 1, limit: Math.min(Math.max(1, Number(query.limit || maxItems)), Math.min(60, maxItems)),
  };
}

async function resolveCollection(env: MerchEnv, row: any, territory: string, userId: string | null, maxItems: number) {
  if (row.mode === "dynamic") {
    const input = searchInput(parseJson(row.query_json, {}), territory, maxItems);
    return (await searchCatalog(env, input, userId)).books;
  }
  const items = await env.DB.prepare(`SELECT mci.product_id FROM merch_collection_items mci
    WHERE mci.collection_id=?
      AND (mci.starts_at IS NULL OR mci.starts_at<=datetime('now')) AND (mci.ends_at IS NULL OR mci.ends_at>datetime('now'))
      AND EXISTS(SELECT 1 FROM retail_product_availability rpa WHERE rpa.product_id=mci.product_id AND rpa.territory_code=upper(?))
    ORDER BY mci.sort_order,mci.product_id LIMIT ?`).bind(row.id, territory, maxItems).all<any>();
  return canonicalBooksByProductIds(env.DB, items.results.map((x) => String(x.product_id)));
}

async function resolvePlacement(env: MerchEnv, row: PlacementRow, territory: string, userId: string | null, visitorId: string) {
  row.request_visitor_id = visitorId;
  let books: CatalogBook[] = [];
  const maxItems = Math.max(1, Math.min(60, Number(row.max_items || 12)));
  if (row.source_type === "product" && row.product_id) {
    const eligible = await env.DB.prepare("SELECT 1 ok FROM retail_product_availability WHERE product_id=? AND territory_code=upper(?) LIMIT 1").bind(String(row.product_id), territory).first<any>();
    books = eligible ? await canonicalBooksByProductIds(env.DB, [String(row.product_id)]) : [];
  } else if (row.source_type === "collection" && row.collection_id) {
    const collection = await env.DB.prepare(`SELECT * FROM merch_collections WHERE id=? AND status='published'
      AND (territory_code IS NULL OR territory_code=?) AND (language_code IS NULL OR lower(language_code)=lower(?))
      AND (starts_at IS NULL OR starts_at<=datetime('now')) AND (ends_at IS NULL OR ends_at>datetime('now'))`).bind(row.collection_id, territory, row.request_language || "en").first<any>();
    if (collection) books = await resolveCollection(env, collection, territory, userId, maxItems);
  } else if (row.source_type === "personalized") {
    const base = parseJson<Record<string, any>>(row.query_json, {});
    books = await recommendationPlacementBooks(env, { userId, visitorId: String(row.request_visitor_id || row.visitor_id || "00000000-0000-4000-8000-000000000000"), territory, strategy: String(base.strategy || "recommended-for-you"), limit: maxItems });
    // If personalization is unavailable or disabled, the placement's JSON also doubles as a safe catalog fallback.
    if (!books.length) books = (await searchCatalog(env, searchInput(base, territory, maxItems), userId)).books;
  } else if (row.source_type === "query") {
    const base = parseJson<Record<string, any>>(row.query_json, {});
    books = (await searchCatalog(env, searchInput(base, territory, maxItems), userId)).books;
  }
  return {
    id: String(row.id), campaignId: String(row.campaign_id), slotKey: String(row.slot_key), type: String(row.placement_type),
    sourceType: String(row.source_type), title: String(row.title || ""), eyebrow: String(row.eyebrow || ""), body: String(row.body || ""),
    ctaLabel: String(row.cta_label || ""), ctaHref: String(row.cta_href || ""), imageUrl: String(row.image_url || ""), badge: String(row.badge || ""),
    sponsored: !!row.sponsored, sponsorName: String(row.sponsor_name || ""), experimentId: row.experiment_id ? String(row.experiment_id) : null,
    experimentVariant: row.assigned_variant || null, books,
  };
}

export async function storefrontMerchandising(env: MerchEnv, options: { territory: string; language: string; visitorId: string; userId: string | null }) {
  const context = await audienceContext(env.DB, options.userId);
  const rows = await env.DB.prepare(`SELECT p.*,c.audience_json,c.priority campaign_priority,s.slot_key,s.name slot_name,s.placement_type,s.max_items,s.max_placements,
      x.experiment_key,x.variants_json
    FROM merch_placements p
    JOIN merch_campaigns c ON c.id=p.campaign_id
    JOIN merch_slots s ON s.id=p.slot_id
    LEFT JOIN merch_experiments x ON x.id=p.experiment_id AND x.status='published'
      AND (x.starts_at IS NULL OR x.starts_at<=datetime('now')) AND (x.ends_at IS NULL OR x.ends_at>datetime('now'))
    WHERE p.active=1 AND s.active=1 AND c.status='published'
      AND (c.territory_code IS NULL OR c.territory_code=?) AND (p.territory_code IS NULL OR p.territory_code=?)
      AND (c.language_code IS NULL OR lower(c.language_code)=lower(?)) AND (p.language_code IS NULL OR lower(p.language_code)=lower(?))
      AND (c.starts_at IS NULL OR c.starts_at<=datetime('now')) AND (c.ends_at IS NULL OR c.ends_at>datetime('now'))
      AND (p.starts_at IS NULL OR p.starts_at<=datetime('now')) AND (p.ends_at IS NULL OR p.ends_at>datetime('now'))
    ORDER BY c.priority DESC,p.sort_order,p.id`).bind(options.territory, options.territory, options.language, options.language).all<any>();

  // Resolve conflicts per stable slot. Highest campaign priority wins first; placements at the
  // same priority/sort order use deterministic visitor weighting so traffic allocation is sticky.
  const candidatesBySlot = new Map<string, PlacementRow[]>();
  for (const raw of rows.results) {
    if (!audienceMatches(raw.audience_json, context)) continue;
    const assignedVariant = raw.experiment_id && raw.experiment_key
      ? chooseVariant(raw.variants_json, options.visitorId, String(raw.experiment_key))
      : null;
    // A placement tied to a draft/paused/out-of-window experiment must not leak into production.
    if (raw.experiment_id && !raw.experiment_key) continue;
    if (raw.experiment_variant && raw.experiment_variant !== assignedVariant) continue;
    const row = { ...raw, assigned_variant: assignedVariant, request_language: options.language };
    const key = String(raw.slot_key);
    const list = candidatesBySlot.get(key) || [];
    list.push(row);
    candidatesBySlot.set(key, list);
  }

  const bySlot = new Map<string, any[]>();
  const usedProducts = new Set<string>();
  const slotOrder = ["home.hero", "home.campaign", "home.primary", "home.secondary"];
  const orderedEntries = [...candidatesBySlot.entries()].sort(([a], [b]) => {
    const ai = slotOrder.indexOf(a), bi = slotOrder.indexOf(b);
    return (ai < 0 ? 999 : ai) - (bi < 0 ? 999 : bi) || a.localeCompare(b);
  });

  for (const [slotKey, rawCandidates] of orderedEntries) {
    const candidates = [...rawCandidates];
    const maxPlacements = Math.max(1, Math.min(12, Number(candidates[0]?.max_placements || 1)));
    const selected: any[] = [];
    let ordinal = 0;
    while (candidates.length && selected.length < maxPlacements) {
      const highestPriority = Math.max(...candidates.map((row) => Number(row.campaign_priority || 0)));
      const atPriority = candidates.filter((row) => Number(row.campaign_priority || 0) === highestPriority);
      const lowestSort = Math.min(...atPriority.map((row) => Number(row.sort_order || 0)));
      const tier = atPriority.filter((row) => Number(row.sort_order || 0) === lowestSort);
      const chosen = chooseWeighted(tier, `${options.visitorId}:${slotKey}:${ordinal}`);
      if (!chosen) break;
      const chosenIndex = candidates.findIndex((row) => row.id === chosen.id);
      if (chosenIndex >= 0) candidates.splice(chosenIndex, 1);
      ordinal += 1;

      const resolved = await resolvePlacement(env, chosen, options.territory, options.userId, options.visitorId);
      // Avoid showing the same SKU in the hero and multiple homepage rails. This is done after
      // resolution because dynamic/personalized collections are not known until request time.
      resolved.books = resolved.books.filter((book) => {
        const productId = String(book.productId || "");
        if (!productId) return true;
        if (usedProducts.has(productId)) return false;
        usedProducts.add(productId);
        return true;
      });
      if (!resolved.books.length && !resolved.imageUrl && !resolved.title && !resolved.body) continue;
      selected.push(resolved);
    }
    if (selected.length) bySlot.set(slotKey, selected);
  }

  return {
    visitorId: options.visitorId,
    territory: options.territory,
    language: options.language,
    slots: Object.fromEntries([...bySlot.entries()]),
  };
}

export async function recordMerchEvent(db: CatalogDB, raw: unknown, userId: string | null) {
  const input = z.object({
    type: z.enum(["impression", "click"]), placementId: z.string().min(1).max(120), visitorId: z.string().uuid(), pageViewId: z.string().uuid(),
    productId: z.string().min(1).max(140).nullable().optional(), position: z.number().int().min(1).max(100).nullable().optional(),
  }).parse(raw);
  const placement = await db.prepare(`SELECT p.id,p.campaign_id,p.experiment_id,p.experiment_variant,p.territory_code placement_territory,p.language_code placement_language,
      c.territory_code campaign_territory,c.language_code campaign_language,s.slot_key,x.experiment_key,x.variants_json
    FROM merch_placements p JOIN merch_slots s ON s.id=p.slot_id
    JOIN merch_campaigns c ON c.id=p.campaign_id
    LEFT JOIN merch_experiments x ON x.id=p.experiment_id AND x.status='published'
      AND (x.starts_at IS NULL OR x.starts_at<=datetime('now')) AND (x.ends_at IS NULL OR x.ends_at>datetime('now'))
    WHERE p.id=? AND p.active=1 AND s.active=1 AND c.status='published'
      AND (c.starts_at IS NULL OR c.starts_at<=datetime('now')) AND (c.ends_at IS NULL OR c.ends_at>datetime('now'))
      AND (p.starts_at IS NULL OR p.starts_at<=datetime('now')) AND (p.ends_at IS NULL OR p.ends_at>datetime('now')) LIMIT 1`).bind(input.placementId).first<any>();
  if (!placement) throw new ApiError(400, "This merchandising placement is not active.");
  if (placement.experiment_id && !placement.experiment_key) throw new ApiError(400, "This experiment is not active.");
  const assignedVariant = placement.experiment_id
    ? chooseVariant(placement.variants_json, input.visitorId, String(placement.experiment_key || placement.experiment_id))
    : null;
  if (placement.experiment_variant && placement.experiment_variant !== assignedVariant) throw new ApiError(400, "This placement is not assigned to this visitor.");

  if (input.productId) {
    const product = await db.prepare("SELECT id FROM products WHERE id=? AND storefront_status='active'").bind(input.productId).first<any>();
    if (!product) throw new ApiError(400, "This product is not a valid storefront impression.");
  }
  if (input.type === "click") {
    const seen = await db.prepare(`SELECT id FROM merch_events WHERE event_type='impression' AND placement_id=? AND visitor_id=? AND page_view_id=?
      AND (product_id IS NULL OR ? IS NULL OR product_id=?) LIMIT 1`)
      .bind(input.placementId, input.visitorId, input.pageViewId, input.productId || null, input.productId || null).first<any>();
    if (!seen) throw new ApiError(400, "A click can only be attributed after a valid placement impression.");
  }
  const eventId = input.type === "impression"
    ? `imp:${input.placementId}:${input.visitorId}:${input.pageViewId}:${input.productId || "placement"}:${input.position || 0}`
    : crypto.randomUUID();
  await db.prepare(`INSERT OR IGNORE INTO merch_events(id,event_type,placement_id,campaign_id,slot_key,visitor_id,user_id,product_id,experiment_id,experiment_variant,position,page_view_id,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(eventId, input.type, input.placementId, placement.campaign_id, placement.slot_key, input.visitorId, userId, input.productId || null, placement.experiment_id || null, assignedVariant, input.position || null, input.pageViewId, now()).run();
  return { ok: true };
}

const campaignInput = z.object({
  id: z.string().max(120).optional(), slug: z.string().min(1).max(100).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/), name: z.string().min(1).max(160),
  status: z.enum(["draft","published","paused","archived"]).default("draft"), campaignType: z.enum(["editorial","seasonal","regional","sponsored","launch"]).default("editorial"),
  priority: z.number().int().min(-10000).max(10000).default(0), territoryCode: z.string().regex(/^[A-Z]{2}$/).nullable().optional(), languageCode: z.string().min(2).max(16).nullable().optional(),
  audience: z.record(z.string(), z.unknown()).default({}), startsAt: z.string().datetime().nullable().optional(), endsAt: z.string().datetime().nullable().optional(),
});
const collectionInput = z.object({
  id: z.string().max(120).optional(), slug: z.string().min(1).max(100).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/), title: z.string().min(1).max(160),
  description: z.string().max(1200).default(""), curator: z.string().max(120).default("Cove editors"), mode: z.enum(["manual","dynamic"]).default("manual"),
  query: z.record(z.string(), z.unknown()).default({}), status: z.enum(["draft","published","archived"]).default("draft"), territoryCode: z.string().regex(/^[A-Z]{2}$/).nullable().optional(),
  languageCode: z.string().min(2).max(16).nullable().optional(), startsAt: z.string().datetime().nullable().optional(), endsAt: z.string().datetime().nullable().optional(),
});
const placementInput = z.object({
  id: z.string().max(120).optional(), campaignId: z.string().min(1).max(120), slotKey: z.string().min(1).max(100),
  sourceType: z.enum(["product","collection","query","personalized","editorial"]), productId: z.string().max(140).nullable().optional(), collectionId: z.string().max(120).nullable().optional(),
  query: z.record(z.string(), z.unknown()).default({}), title: z.string().max(180).default(""), eyebrow: z.string().max(80).default(""), body: z.string().max(1600).default(""),
  ctaLabel: z.string().max(80).default(""), ctaHref: z.string().max(500).default(""), imageUrl: z.string().max(1000).default(""), badge: z.string().max(80).default(""),
  sortOrder: z.number().int().min(-10000).max(10000).default(0), weight: z.number().int().min(0).max(10000).default(100), sponsored: z.boolean().default(false), sponsorName: z.string().max(160).default(""),
  territoryCode: z.string().regex(/^[A-Z]{2}$/).nullable().optional(), languageCode: z.string().min(2).max(16).nullable().optional(), experimentId: z.string().max(120).nullable().optional(),
  experimentVariant: z.string().max(50).nullable().optional(), startsAt: z.string().datetime().nullable().optional(), endsAt: z.string().datetime().nullable().optional(), active: z.boolean().default(true),
});
const experimentInput = z.object({
  id: z.string().max(120).optional(), experimentKey: z.string().min(1).max(100).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/), name: z.string().min(1).max(160),
  status: z.enum(["draft","published","paused","completed"]).default("draft"), variants: z.array(z.object({ key: z.string().min(1).max(50), weight: z.number().int().min(1).max(10000) })).min(1).max(10),
  startsAt: z.string().datetime().nullable().optional(), endsAt: z.string().datetime().nullable().optional(),
});
const itemsInput = z.object({ collectionId: z.string().min(1).max(120), items: z.array(z.object({
  productId: z.string().min(1).max(140), sortOrder: z.number().int().min(0).max(10000), badge: z.string().max(80).default(""),
  titleOverride: z.string().max(180).default(""), subtitleOverride: z.string().max(240).default(""),
  startsAt: z.string().datetime().nullable().optional(), endsAt: z.string().datetime().nullable().optional(),
})).max(250) });

function validateCommonSchedule(startsAt?: string | null, endsAt?: string | null) { assertSchedule(startsAt, endsAt); }

async function audit(db: CatalogDB, action: string, entityType: string, entityId: string, before: unknown, after: unknown) {
  await db.prepare("INSERT INTO storefront_admin_audit(id,actor,action,entity_type,entity_id,before_json,after_json,created_at) VALUES(?,?,?,?,?,?,?,?)")
    .bind(crypto.randomUUID(), "operator", action, entityType, entityId, before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null, now()).run();
}

export async function adminMerchSnapshot(db: CatalogDB) {
  const [campaigns, slots, collections, collectionItems, placements, experiments, analytics, experimentAnalytics, auditRows] = await Promise.all([
    db.prepare("SELECT * FROM merch_campaigns ORDER BY priority DESC,name").all<any>(), db.prepare("SELECT * FROM merch_slots ORDER BY slot_key").all<any>(),
    db.prepare("SELECT * FROM merch_collections ORDER BY updated_at DESC,title").all<any>(),
    db.prepare("SELECT * FROM merch_collection_items ORDER BY collection_id,sort_order,product_id").all<any>(),
    db.prepare(`SELECT p.*,c.name campaign_name,s.slot_key,s.name slot_name FROM merch_placements p JOIN merch_campaigns c ON c.id=p.campaign_id JOIN merch_slots s ON s.id=p.slot_id ORDER BY s.slot_key,c.priority DESC,p.sort_order`).all<any>(),
    db.prepare("SELECT * FROM merch_experiments ORDER BY updated_at DESC").all<any>(),
    db.prepare(`SELECT p.id placement_id,c.name campaign_name,s.slot_key,
      SUM(CASE WHEN e.event_type='impression' THEN 1 ELSE 0 END) impressions,
      SUM(CASE WHEN e.event_type='click' THEN 1 ELSE 0 END) clicks
      FROM merch_placements p JOIN merch_campaigns c ON c.id=p.campaign_id JOIN merch_slots s ON s.id=p.slot_id
      LEFT JOIN merch_events e ON e.placement_id=p.id AND e.created_at>=datetime('now','-30 days')
      GROUP BY p.id ORDER BY impressions DESC`).all<any>(),
    db.prepare(`SELECT x.id experiment_id,x.name experiment_name,e.experiment_variant variant,
      SUM(CASE WHEN e.event_type='impression' THEN 1 ELSE 0 END) impressions,
      SUM(CASE WHEN e.event_type='click' THEN 1 ELSE 0 END) clicks,
      COUNT(DISTINCT CASE WHEN e.event_type='impression' THEN e.visitor_id END) unique_viewers
      FROM merch_experiments x LEFT JOIN merch_events e ON e.experiment_id=x.id AND e.created_at>=datetime('now','-30 days')
      GROUP BY x.id,e.experiment_variant ORDER BY x.name,e.experiment_variant`).all<any>(),
    db.prepare("SELECT * FROM storefront_admin_audit WHERE entity_type LIKE 'merch_%' ORDER BY created_at DESC LIMIT 100").all<any>(),
  ]);
  return { campaigns: campaigns.results, slots: slots.results, collections: collections.results, collectionItems: collectionItems.results, placements: placements.results, experiments: experiments.results, analytics: analytics.results.map((x:any)=>({ ...x, ctr: Number(x.impressions||0) ? Number(x.clicks||0)/Number(x.impressions) : 0 })), experimentAnalytics: experimentAnalytics.results.map((x:any)=>({ ...x, ctr: Number(x.impressions||0) ? Number(x.clicks||0)/Number(x.impressions) : 0 })), audit: auditRows.results };
}

export async function upsertCampaign(db: CatalogDB, raw: unknown) {
  const x = campaignInput.parse(raw); validateCommonSchedule(x.startsAt, x.endsAt);
  const id = x.id || `campaign_${crypto.randomUUID()}`, before = await db.prepare("SELECT * FROM merch_campaigns WHERE id=?").bind(id).first<any>(), at = now();
  const slugOwner = await db.prepare("SELECT id FROM merch_campaigns WHERE slug=? AND id<>?").bind(x.slug,id).first<any>();
  if (slugOwner) throw new ApiError(409,"Another campaign already uses this slug.");
  await db.prepare(`INSERT INTO merch_campaigns(id,slug,name,status,campaign_type,priority,territory_code,language_code,audience_json,starts_at,ends_at,created_by,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET slug=excluded.slug,name=excluded.name,status=excluded.status,campaign_type=excluded.campaign_type,priority=excluded.priority,territory_code=excluded.territory_code,language_code=excluded.language_code,audience_json=excluded.audience_json,starts_at=excluded.starts_at,ends_at=excluded.ends_at,updated_at=excluded.updated_at`)
    .bind(id,x.slug,x.name,x.status,x.campaignType,x.priority,x.territoryCode||null,x.languageCode||null,JSON.stringify(x.audience),x.startsAt||null,x.endsAt||null,"operator",before?.created_at||at,at).run();
  const after=await db.prepare("SELECT * FROM merch_campaigns WHERE id=?").bind(id).first<any>(); await audit(db,before?"update":"create","merch_campaign",id,before,after); return after;
}
export async function upsertCollection(db: CatalogDB, raw: unknown) {
  const x=collectionInput.parse(raw); validateCommonSchedule(x.startsAt,x.endsAt);
  const id=x.id||`collection_${crypto.randomUUID()}`,before=await db.prepare("SELECT * FROM merch_collections WHERE id=?").bind(id).first<any>(),at=now();
  const slugOwner=await db.prepare("SELECT id FROM merch_collections WHERE slug=? AND id<>?").bind(x.slug,id).first<any>();
  if(slugOwner)throw new ApiError(409,"Another collection already uses this slug.");
  await db.prepare(`INSERT INTO merch_collections(id,slug,title,description,curator,mode,query_json,status,territory_code,language_code,starts_at,ends_at,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET slug=excluded.slug,title=excluded.title,description=excluded.description,curator=excluded.curator,mode=excluded.mode,query_json=excluded.query_json,status=excluded.status,territory_code=excluded.territory_code,language_code=excluded.language_code,starts_at=excluded.starts_at,ends_at=excluded.ends_at,updated_at=excluded.updated_at`)
    .bind(id,x.slug,x.title,x.description,x.curator,x.mode,JSON.stringify(x.query),x.status,x.territoryCode||null,x.languageCode||null,x.startsAt||null,x.endsAt||null,before?.created_at||at,at).run();
  const after=await db.prepare("SELECT * FROM merch_collections WHERE id=?").bind(id).first<any>(); await audit(db,before?"update":"create","merch_collection",id,before,after); return after;
}
export async function setCollectionItems(db: CatalogDB, raw: unknown) {
  const x=itemsInput.parse(raw),collection=await db.prepare("SELECT * FROM merch_collections WHERE id=?").bind(x.collectionId).first<any>(); if(!collection) throw new ApiError(404,"Collection not found.");
  const seenProducts=new Set<string>();
  for(const item of x.items){
    if(seenProducts.has(item.productId))throw new ApiError(400,`Product ${item.productId} appears more than once.`); seenProducts.add(item.productId);
    validateCommonSchedule(item.startsAt,item.endsAt);
    const product=await db.prepare("SELECT id FROM products WHERE id=? AND storefront_status='active'").bind(item.productId).first<any>();if(!product)throw new ApiError(400,`Unknown or inactive product ${item.productId}.`)
  }
  await db.prepare("DELETE FROM merch_collection_items WHERE collection_id=?").bind(x.collectionId).run();
  for(const item of x.items) await db.prepare("INSERT INTO merch_collection_items(collection_id,product_id,sort_order,badge,title_override,subtitle_override,starts_at,ends_at) VALUES(?,?,?,?,?,?,?,?)").bind(x.collectionId,item.productId,item.sortOrder,item.badge,item.titleOverride,item.subtitleOverride,item.startsAt||null,item.endsAt||null).run();
  await audit(db,"replace_items","merch_collection",x.collectionId,null,x.items); return {ok:true,count:x.items.length};
}
export async function upsertPlacement(db: CatalogDB, raw: unknown) {
  const x=placementInput.parse(raw); validateCommonSchedule(x.startsAt,x.endsAt);
  if(!safeLink(x.ctaHref))throw new ApiError(400,"CTA links must be an internal path or HTTPS URL.");
  if(x.imageUrl&&!/^https:\/\//i.test(x.imageUrl))throw new ApiError(400,"Merchandising images must use HTTPS URLs.");
  if(x.sponsored&&!x.sponsorName.trim())throw new ApiError(400,"Sponsored placements must name the sponsor.");
  const id=x.id||`placement_${crypto.randomUUID()}`,before=await db.prepare("SELECT * FROM merch_placements WHERE id=?").bind(id).first<any>(),at=now();
  const slot=await db.prepare("SELECT id FROM merch_slots WHERE slot_key=?").bind(x.slotKey).first<any>(); if(!slot)throw new ApiError(400,"Unknown merchandising slot.");
  const campaign=await db.prepare("SELECT id FROM merch_campaigns WHERE id=?").bind(x.campaignId).first<any>(); if(!campaign)throw new ApiError(400,"Unknown campaign.");
  if(x.sourceType==="product"){if(!x.productId)throw new ApiError(400,"Product placements require a product."); const product=await db.prepare("SELECT id FROM products WHERE id=? AND storefront_status='active'").bind(x.productId).first<any>(); if(!product)throw new ApiError(400,"The selected product is not storefront-active.");}
  if(x.sourceType==="collection"){if(!x.collectionId)throw new ApiError(400,"Collection placements require a collection."); const collection=await db.prepare("SELECT id FROM merch_collections WHERE id=?").bind(x.collectionId).first<any>(); if(!collection)throw new ApiError(400,"Unknown collection.");}
  if(x.experimentId){const experiment=await db.prepare("SELECT variants_json FROM merch_experiments WHERE id=?").bind(x.experimentId).first<any>(); if(!experiment)throw new ApiError(400,"Unknown experiment."); if(x.experimentVariant){const keys=parseJson<Array<{key:string}>>(experiment.variants_json,[]).map(v=>v.key); if(!keys.includes(x.experimentVariant))throw new ApiError(400,"The selected experiment variant does not exist.");}}
  await db.prepare(`INSERT INTO merch_placements(id,campaign_id,slot_id,source_type,product_id,collection_id,query_json,title,eyebrow,body,cta_label,cta_href,image_url,badge,sort_order,weight,sponsored,sponsor_name,territory_code,language_code,experiment_id,experiment_variant,starts_at,ends_at,active,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET campaign_id=excluded.campaign_id,slot_id=excluded.slot_id,source_type=excluded.source_type,product_id=excluded.product_id,collection_id=excluded.collection_id,query_json=excluded.query_json,title=excluded.title,eyebrow=excluded.eyebrow,body=excluded.body,cta_label=excluded.cta_label,cta_href=excluded.cta_href,image_url=excluded.image_url,badge=excluded.badge,sort_order=excluded.sort_order,weight=excluded.weight,sponsored=excluded.sponsored,sponsor_name=excluded.sponsor_name,territory_code=excluded.territory_code,language_code=excluded.language_code,experiment_id=excluded.experiment_id,experiment_variant=excluded.experiment_variant,starts_at=excluded.starts_at,ends_at=excluded.ends_at,active=excluded.active,updated_at=excluded.updated_at`)
    .bind(id,x.campaignId,slot.id,x.sourceType,x.productId||null,x.collectionId||null,JSON.stringify(x.query),x.title,x.eyebrow,x.body,x.ctaLabel,x.ctaHref,x.imageUrl,x.badge,x.sortOrder,x.weight,x.sponsored?1:0,x.sponsorName,x.territoryCode||null,x.languageCode||null,x.experimentId||null,x.experimentVariant||null,x.startsAt||null,x.endsAt||null,x.active?1:0,before?.created_at||at,at).run();
  const after=await db.prepare("SELECT * FROM merch_placements WHERE id=?").bind(id).first<any>(); await audit(db,before?"update":"create","merch_placement",id,before,after); return after;
}
export async function upsertExperiment(db: CatalogDB, raw: unknown) {
  const x=experimentInput.parse(raw); validateCommonSchedule(x.startsAt,x.endsAt);
  const id=x.id||`experiment_${crypto.randomUUID()}`,before=await db.prepare("SELECT * FROM merch_experiments WHERE id=?").bind(id).first<any>(),at=now();
  const keyOwner=await db.prepare("SELECT id FROM merch_experiments WHERE experiment_key=? AND id<>?").bind(x.experimentKey,id).first<any>(); if(keyOwner)throw new ApiError(409,"Another experiment already uses this key.");
  const keys=new Set<string>(); for(const v of x.variants){if(keys.has(v.key))throw new ApiError(400,"Experiment variant keys must be unique.");keys.add(v.key)}
  const total=x.variants.reduce((s,v)=>s+v.weight,0); if(total<=0)throw new ApiError(400,"Experiment weights must be positive.");
  await db.prepare(`INSERT INTO merch_experiments(id,experiment_key,name,status,variants_json,starts_at,ends_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET experiment_key=excluded.experiment_key,name=excluded.name,status=excluded.status,variants_json=excluded.variants_json,starts_at=excluded.starts_at,ends_at=excluded.ends_at,updated_at=excluded.updated_at`)
    .bind(id,x.experimentKey,x.name,x.status,JSON.stringify(x.variants),x.startsAt||null,x.endsAt||null,before?.created_at||at,at).run();
  const after=await db.prepare("SELECT * FROM merch_experiments WHERE id=?").bind(id).first<any>(); await audit(db,before?"update":"create","merch_experiment",id,before,after); return after;
}
