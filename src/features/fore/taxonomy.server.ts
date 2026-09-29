import { z } from "zod";
import type { CatalogDB } from "./catalog-model.server";
import { ApiError, now } from "./service";
import { canonicalEntitySlug, resolveEntityId } from "./discovery.server";

export type TaxonomyNode = {
  id: string;
  slug: string;
  path: string;
  name: string;
  description: string;
  depth: number;
  sortOrder: number;
  featured: boolean;
  seoTitle: string;
  seoDescription: string;
  count: number;
  href: string;
  children: TaxonomyNode[];
};

function parseObject(value: unknown): Record<string, unknown> {
  try {
    const parsed = JSON.parse(String(value ?? "{}"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function flattenTaxonomy(nodes: TaxonomyNode[]): TaxonomyNode[] {
  return nodes.flatMap((node) => [node, ...flattenTaxonomy(node.children)]);
}

function normalizePath(path: string) {
  let value = path.trim();
  if (!value.startsWith("/")) value = "/" + value;
  value = value.replace(/\/{2,}/g, "/");
  if (value.length > 1) value = value.replace(/\/$/, "");
  return value;
}

/**
 * Rebuild Cove retail taxonomy assignments for one edition from source categories.
 * Manual assignments survive supplier refreshes; mapping/ancestor assignments are derived.
 */
export async function syncEditionTaxonomy(db: CatalogDB, editionId: string) {
  const at = now();
  await db.prepare("DELETE FROM edition_taxonomy_nodes WHERE edition_id=? AND source IN ('mapping','ancestor')").bind(editionId).run();
  await db.prepare(`INSERT OR IGNORE INTO edition_taxonomy_nodes(edition_id,taxonomy_node_id,source,confidence,is_primary,created_at)
    SELECT DISTINCT src.edition_id,m.taxonomy_node_id,'mapping',CASE WHEN m.match_mode='exact' THEN 1.0 ELSE 0.85 END,0,?
    FROM (
      SELECT ec.edition_id,c.scheme source_scheme,c.name source_value
      FROM edition_categories ec JOIN categories c ON c.id=ec.category_id WHERE ec.edition_id=?
      UNION ALL
      SELECT es.edition_id,CASE WHEN s.scheme='gutenberg' THEN 'gutenberg-subject' ELSE s.scheme END,s.name
      FROM edition_subjects es JOIN subjects s ON s.id=es.subject_id WHERE es.edition_id=?
    ) src
    JOIN storefront_taxonomy_mappings m ON m.active=1
      AND (m.source_scheme='*' OR m.source_scheme=src.source_scheme)
      AND ((m.match_mode='exact' AND lower(src.source_value)=lower(m.source_value))
        OR (m.match_mode='prefix' AND lower(src.source_value) LIKE lower(m.source_value)||'%')
        OR (m.match_mode='contains' AND lower(src.source_value) LIKE '%'||lower(m.source_value)||'%'))`).bind(at, editionId, editionId).run();
  await db.prepare(`WITH RECURSIVE ancestors(edition_id,node_id,parent_id,confidence) AS (
      SELECT et.edition_id,n.id,n.parent_id,et.confidence
      FROM edition_taxonomy_nodes et JOIN storefront_taxonomy_nodes n ON n.id=et.taxonomy_node_id
      WHERE et.edition_id=? AND et.source IN ('mapping','manual')
      UNION ALL
      SELECT a.edition_id,n.id,n.parent_id,a.confidence
      FROM ancestors a JOIN storefront_taxonomy_nodes n ON n.id=a.parent_id
      WHERE a.parent_id IS NOT NULL
    )
    INSERT OR IGNORE INTO edition_taxonomy_nodes(edition_id,taxonomy_node_id,source,confidence,is_primary,created_at)
    SELECT edition_id,node_id,'ancestor',confidence,0,? FROM ancestors`).bind(editionId, at).run();
  await db.prepare(`UPDATE catalog_search_documents SET taxonomy_text=COALESCE((
    SELECT group_concat(n.path,' | ') FROM products p
    JOIN edition_taxonomy_nodes et ON et.edition_id=p.edition_id
    JOIN storefront_taxonomy_nodes n ON n.id=et.taxonomy_node_id
    WHERE p.id=catalog_search_documents.product_id
  ),''), updated_at=updated_at WHERE product_id IN (SELECT id FROM products WHERE edition_id=?)`).bind(editionId).run();
  await db.prepare(`INSERT INTO search_index_outbox(product_id,operation,queued_at,attempts,last_error)
    SELECT id,'upsert',?,0,'' FROM products WHERE edition_id=? AND source_name<>'upload'
    ON CONFLICT(product_id) DO UPDATE SET operation='upsert',queued_at=excluded.queued_at,attempts=0,last_error=''`).bind(at, editionId).run();
}

export async function syncTaxonomyBatch(db: CatalogDB, limit = 250, afterEditionId = "") {
  const rows = await db.prepare(`SELECT id FROM editions WHERE id>? ORDER BY id LIMIT ?`).bind(afterEditionId, limit).all<any>();
  for (const row of rows.results) await syncEditionTaxonomy(db, String(row.id));
  return {
    processed: rows.results.length,
    nextAfter: rows.results.length === limit ? String(rows.results[rows.results.length - 1].id) : null,
  };
}

export async function taxonomyTree(db: CatalogDB, territory = "US", language = "", locale = "en-US") {
  // Fetch the hierarchy and product counts separately. This avoids one correlated rights/catalog
  // subquery per taxonomy node, which becomes prohibitively expensive once the catalog is large.
  const [rows, countRows, localizationRows] = await Promise.all([
    db.prepare(`SELECT n.* FROM storefront_taxonomy_nodes n
      JOIN storefront_taxonomies t ON t.id=n.taxonomy_id
      WHERE t.is_default=1 AND t.status='active' AND n.visible=1
      ORDER BY n.depth,n.sort_order,n.name`).all<any>(),
    db.prepare(`SELECT et.taxonomy_node_id node_id,COUNT(DISTINCT p.id) product_count
      FROM edition_taxonomy_nodes et
      JOIN products p ON p.edition_id=et.edition_id
      JOIN editions e ON e.id=p.edition_id
      WHERE p.storefront_status='active' AND p.source_name<>'upload'
        AND e.release_status IN ('available','preorder')
        AND (?='' OR EXISTS(SELECT 1 FROM edition_languages el WHERE el.edition_id=e.id AND lower(el.language_code)=lower(?)))
        AND EXISTS(SELECT 1 FROM retail_product_availability rpa WHERE rpa.product_id=p.id AND rpa.territory_code=upper(?))
      GROUP BY et.taxonomy_node_id`).bind(language, language, territory).all<any>(),
    db.prepare("SELECT taxonomy_node_id,name,description,seo_title,seo_description FROM storefront_taxonomy_node_localizations WHERE locale=?").bind(locale).all<any>(),
  ]);
  const localized = new Map(localizationRows.results.map((row) => [String(row.taxonomy_node_id), row]));
  const counts = new Map(countRows.results.map((row) => [String(row.node_id), Number(row.product_count || 0)]));
  const byId = new Map<string, TaxonomyNode>();
  for (const row of rows.results) {
    const tr:any = localized.get(String(row.id));
    byId.set(String(row.id), {
      id: String(row.id), slug: String(row.slug), path: String(row.path), name: String(tr?.name || row.name),
      description: String(tr?.description || row.description || ""), depth: Number(row.depth || 0), sortOrder: Number(row.sort_order || 0),
      featured: !!row.featured, seoTitle: String(tr?.seo_title || row.seo_title || ""), seoDescription: String(tr?.seo_description || row.seo_description || ""),
      count: counts.get(String(row.id)) || 0, href: `/ebooks/${String(row.path)}`, children: [],
    });
  }
  const roots: TaxonomyNode[] = [];
  for (const row of rows.results) {
    const node = byId.get(String(row.id))!;
    const parent = row.parent_id ? byId.get(String(row.parent_id)) : null;
    if (parent) parent.children.push(node); else roots.push(node);
  }
  const taxonomyMeta = await db.prepare("SELECT name,version FROM storefront_taxonomies WHERE is_default=1 AND status='active' LIMIT 1").first<any>();
  return {
    taxonomy: String(taxonomyMeta?.name || "Cove Books"),
    version: String(taxonomyMeta?.version || ""),
    territory,
    language: language || null,
    locale,
    featured: flattenTaxonomy(roots).filter((n) => n.featured && n.count > 0),
    nodes: roots,
  };
}

export async function resolveStorefrontPage(db: CatalogDB, pathValue: string, territory = "US", language = "en", locale = "en-US") {
  const path = normalizePath(pathValue);
  if (path.startsWith("/ebooks/")) {
    const taxonomyPath = decodeURIComponent(path.slice("/ebooks/".length));
    const node = await db.prepare(`SELECT n.* FROM storefront_taxonomy_nodes n JOIN storefront_taxonomies t ON t.id=n.taxonomy_id
      WHERE t.is_default=1 AND t.status='active' AND n.visible=1 AND n.path=? LIMIT 1`).bind(taxonomyPath).first<any>();
    if (!node) {
      const redirect = await db.prepare("SELECT to_path,status_code FROM storefront_redirects WHERE from_path=? LIMIT 1").bind(path).first<any>();
      if (redirect) return { path, pageType: "redirect", redirectTo: String(redirect.to_path), statusCode: Number(redirect.status_code || 301), noindex: true, canonical: String(redirect.to_path), query: {} };
      throw new ApiError(404, "This bookstore category does not exist.");
    }
    const nodeLocalization=await db.prepare("SELECT name,description,seo_title,seo_description FROM storefront_taxonomy_node_localizations WHERE taxonomy_node_id=? AND locale=? LIMIT 1").bind(node.id,locale).first<any>();
    if(nodeLocalization){node.name=nodeLocalization.name||node.name;node.description=nodeLocalization.description||node.description;node.seo_title=nodeLocalization.seo_title||node.seo_title;node.seo_description=nodeLocalization.seo_description||node.seo_description;}
    const parts = String(node.path).split("/");
    const prefixes = parts.map((_, i) => parts.slice(0, i + 1).join("/"));
    const placeholders = prefixes.map(() => "?").join(",");
    const breadcrumbRows = await db.prepare(`SELECT n.id,n.path,COALESCE(l.name,n.name) name,n.depth FROM storefront_taxonomy_nodes n LEFT JOIN storefront_taxonomy_node_localizations l ON l.taxonomy_node_id=n.id AND l.locale=? WHERE n.taxonomy_id=? AND n.path IN (${placeholders}) ORDER BY n.depth`)
      .bind(locale,node.taxonomy_id, ...prefixes).all<any>();
    const childRows = await db.prepare(`SELECT n.id,n.path,COALESCE(l.name,n.name) name,COALESCE(l.description,n.description) description FROM storefront_taxonomy_nodes n LEFT JOIN storefront_taxonomy_node_localizations l ON l.taxonomy_node_id=n.id AND l.locale=? WHERE n.parent_id=? AND n.visible=1 ORDER BY n.sort_order,name`).bind(locale,node.id).all<any>();
    return {
      path,
      pageType: "taxonomy",
      title: String(node.name),
      heading: String(node.name),
      eyebrow: "BROWSE EBOOKS",
      description: String(node.description || ""),
      seoTitle: String(node.seo_title || `${node.name} eBooks | Cove`),
      seoDescription: String(node.seo_description || node.description || `Browse ${node.name} eBooks on Cove.`),
      noindex: false,
      canonical: `/ebooks/${String(node.path)}`,
      query: { taxonomy: [String(node.path)], sort: "popular" },
      taxonomy: { id: String(node.id), path: String(node.path), name: String(node.name) },
      breadcrumbs: breadcrumbRows.results.map((row) => ({ id: String(row.id), name: String(row.name), path: String(row.path), href: `/ebooks/${String(row.path)}` })),
      children: childRows.results.map((row) => ({ id: String(row.id), name: String(row.name), path: String(row.path), description: String(row.description || ""), href: `/ebooks/${String(row.path)}` })),
    };
  }
  if (path.startsWith("/author/")) {
    const ref = decodeURIComponent(path.slice("/author/".length));
    const id=await resolveEntityId(db,"author",ref);
    const contributor = await db.prepare("SELECT id,name,bio,website,image_url,slug FROM contributors WHERE id=? LIMIT 1").bind(id).first<any>();
    if (!contributor) throw new ApiError(404, "This author does not exist.");
    const slug=await canonicalEntitySlug(db,"author",id);
    const seriesRows=await db.prepare(`SELECT DISTINCT s.id,s.name,s.slug,s.series_type FROM series s JOIN series_memberships sm ON sm.series_id=s.id JOIN edition_contributors ec ON ec.edition_id=sm.edition_id WHERE ec.contributor_id=? AND ec.role='author' AND s.status='active' ORDER BY s.name LIMIT 24`).bind(id).all<any>();
    const canonical=`/author/${encodeURIComponent(slug)}`;
    return { path, pageType: "author", title: String(contributor.name), heading: String(contributor.name), eyebrow: "AUTHOR", description: String(contributor.bio || `Books by ${contributor.name}.`), seoTitle: `${contributor.name} eBooks | Cove`, seoDescription: String(contributor.bio || `Browse books by ${contributor.name} on Cove.`).slice(0,320), noindex: false, canonical, redirectTo:path!==canonical?canonical:undefined, query: { authorId: [id], sort: "popular" }, entity: { id, type: "author", name: String(contributor.name), bio:String(contributor.bio||""), website:String(contributor.website||""), imageUrl:String(contributor.image_url||""), series:seriesRows.results.map((r:any)=>({id:String(r.id),name:String(r.name),slug:String(r.slug||r.id),seriesType:String(r.series_type||"ordered")})) } };
  }
  if (path.startsWith("/series/")) {
    const ref = decodeURIComponent(path.slice("/series/".length));
    const id=await resolveEntityId(db,"series",ref);
    const series = await db.prepare("SELECT s.*,p.name publisher_name FROM series s LEFT JOIN publishers p ON p.id=s.publisher_id WHERE s.id=? AND s.status<>'archived' LIMIT 1").bind(id).first<any>();
    if (!series) throw new ApiError(404, "This series does not exist.");
    const slug=await canonicalEntitySlug(db,"series",id);
    const canonical=`/series/${encodeURIComponent(slug)}`;
    return { path, pageType: "series", title: String(series.name), heading: String(series.name), eyebrow: series.series_type==='unordered'?"BOOK COLLECTION":"BOOK SERIES", description: String(series.description || `Books in the ${series.name} series.`), seoTitle: `${series.name} Series | Cove`, seoDescription: String(series.description || `Browse the ${series.name} series on Cove.`).slice(0,320), noindex: false, canonical, redirectTo:path!==canonical?canonical:undefined, query: { seriesId: [id], sort: "published" }, entity: { id, type: "series", name: String(series.name), seriesType:String(series.series_type||"ordered"), heroImageUrl:String(series.hero_image_url||""), publisherId:series.publisher_id?String(series.publisher_id):null,publisherName:String(series.publisher_name||"") } };
  }
  if (path.startsWith("/publisher/")) {
    const ref = decodeURIComponent(path.slice("/publisher/".length));
    const id=await resolveEntityId(db,"publisher",ref);
    const publisher = await db.prepare("SELECT id,name,website,description,logo_url,slug FROM publishers WHERE id=? LIMIT 1").bind(id).first<any>();
    if (!publisher) throw new ApiError(404, "This publisher does not exist.");
    const slug=await canonicalEntitySlug(db,"publisher",id);
    const [imprints,seriesRows]=await Promise.all([
      db.prepare("SELECT id,name,slug FROM imprints WHERE publisher_id=? ORDER BY name LIMIT 100").bind(id).all<any>(),
      db.prepare("SELECT id,name,slug,series_type FROM series WHERE publisher_id=? AND status='active' ORDER BY name LIMIT 50").bind(id).all<any>(),
    ]);
    const canonical=`/publisher/${encodeURIComponent(slug)}`;
    return { path, pageType: "publisher", title: String(publisher.name), heading: String(publisher.name), eyebrow: "PUBLISHER", description: String(publisher.description||`Browse eBooks from ${publisher.name}.`), seoTitle: `${publisher.name} eBooks | Cove`, seoDescription: String(publisher.description||`Browse eBooks published by ${publisher.name} on Cove.`).slice(0,320), noindex: false, canonical, redirectTo:path!==canonical?canonical:undefined, query: { publisherId: [id], sort: "released" }, entity: { id, type: "publisher", name: String(publisher.name), website: String(publisher.website || ""), description:String(publisher.description||""), imageUrl:String(publisher.logo_url||""), imprints:imprints.results.map((r:any)=>({id:String(r.id),name:String(r.name),slug:String(r.slug||r.id)})), series:seriesRows.results.map((r:any)=>({id:String(r.id),name:String(r.name),slug:String(r.slug||r.id),seriesType:String(r.series_type||"ordered")})) } };
  }
  if (path.startsWith("/imprint/")) {
    const ref = decodeURIComponent(path.slice("/imprint/".length));
    const id=await resolveEntityId(db,"imprint",ref);
    const imprint = await db.prepare("SELECT i.*,p.name publisher_name,p.id publisher_id,p.slug publisher_slug FROM imprints i JOIN publishers p ON p.id=i.publisher_id WHERE i.id=? LIMIT 1").bind(id).first<any>();
    if (!imprint) throw new ApiError(404, "This imprint does not exist.");
    const slug=await canonicalEntitySlug(db,"imprint",id);
    const seriesRows=await db.prepare(`SELECT DISTINCT s.id,s.name,s.slug,s.series_type FROM series s JOIN series_memberships sm ON sm.series_id=s.id JOIN editions e ON e.id=sm.edition_id WHERE e.imprint_id=? AND s.status='active' ORDER BY s.name LIMIT 50`).bind(id).all<any>();
    const canonical=`/imprint/${encodeURIComponent(slug)}`;
    return { path, pageType: "imprint", title: String(imprint.name), heading: String(imprint.name), eyebrow: "IMPRINT", description: String(imprint.description||`Browse eBooks from ${imprint.name}, an imprint of ${imprint.publisher_name}.`), seoTitle: `${imprint.name} eBooks | Cove`, seoDescription: String(imprint.description||`Browse eBooks from ${imprint.name} on Cove.`).slice(0,320), noindex: false, canonical, redirectTo:path!==canonical?canonical:undefined, query: { imprintId: [id], sort: "released" }, entity: { id, type: "imprint", name: String(imprint.name), website:String(imprint.website||""), description:String(imprint.description||""), imageUrl:String(imprint.logo_url||""), publisherId:String(imprint.publisher_id),publisherSlug:String(imprint.publisher_slug||imprint.publisher_id),publisherName:String(imprint.publisher_name), series:seriesRows.results.map((r:any)=>({id:String(r.id),name:String(r.name),slug:String(r.slug||r.id),seriesType:String(r.series_type||"ordered")})) } };
  }
  const row = await db.prepare(`SELECT * FROM storefront_pages WHERE path=? AND status='published'
    AND (territory_code IS NULL OR territory_code=?) AND (language_code IS NULL OR lower(language_code)=lower(?))
    AND (starts_at IS NULL OR starts_at<=datetime('now')) AND (ends_at IS NULL OR ends_at>datetime('now')) LIMIT 1`).bind(path, territory, language).first<any>();
  if (!row) {
    if (["/", "/store", "/search"].includes(path)) {
      return { path, pageType: path === "/search" ? "search" : "home", title: "Bookstore", heading: path === "/search" ? "Search the bookstore" : "Find your next great read.", eyebrow: "THE BOOKSTORE", description: "Stories to get lost in. Ideas to carry with you.", seoTitle: path === "/search" ? "Search eBooks | Cove" : "Cove — Bookstore & Reading Room", seoDescription: "Discover ebooks, read online, and build your reading life.", noindex: path === "/search", canonical: path === "/store" ? "/" : path, query: {} };
    }
    throw new ApiError(404, "This bookstore page does not exist.");
  }
  return {
    path: String(row.path), pageType: String(row.page_type), title: String(row.title), heading: String(row.heading),
    eyebrow: String(row.eyebrow || "THE BOOKSTORE"), description: String(row.description || ""),
    seoTitle: String(row.seo_title || row.title), seoDescription: String(row.seo_description || row.description || ""),
    noindex: !!row.noindex, canonical: String(row.path), query: parseObject(row.query_json),
  };
}

const taxonomyNodeInput = z.object({
  id: z.string().trim().min(1).max(100).optional(),
  parentId: z.string().trim().max(100).nullable().optional(),
  slug: z.string().trim().min(1).max(80).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  name: z.string().trim().min(1).max(100),
  description: z.string().max(1000).default(""),
  sortOrder: z.number().int().min(-10000).max(10000).default(0),
  visible: z.boolean().default(true),
  featured: z.boolean().default(false),
  seoTitle: z.string().max(180).default(""),
  seoDescription: z.string().max(320).default(""),
});
const taxonomyMappingInput = z.object({
  id: z.string().trim().min(1).max(120).optional(),
  taxonomyNodeId: z.string().trim().min(1).max(100),
  sourceScheme: z.string().trim().min(1).max(80).default("*"),
  sourceValue: z.string().trim().min(1).max(240),
  matchMode: z.enum(["exact", "prefix", "contains"]).default("contains"),
  priority: z.number().int().min(-10000).max(10000).default(0),
  active: z.boolean().default(true),
});
const pageInput = z.object({
  id: z.string().trim().min(1).max(120).optional(), path: z.string().trim().min(1).max(240),
  pageType: z.enum(["browse", "campaign", "collection", "search"]).default("browse"), title: z.string().trim().min(1).max(140),
  heading: z.string().trim().min(1).max(180), description: z.string().max(1200).default(""), eyebrow: z.string().max(80).default(""),
  seoTitle: z.string().max(180).default(""), seoDescription: z.string().max(320).default(""), query: z.record(z.string(), z.unknown()).default({}),
  status: z.enum(["draft", "published", "archived"]).default("draft"), territoryCode: z.string().regex(/^[A-Z]{2}$/).nullable().optional(),
  languageCode: z.string().min(2).max(16).nullable().optional(), startsAt: z.string().datetime().nullable().optional(), endsAt: z.string().datetime().nullable().optional(),
  noindex: z.boolean().default(false),
}).superRefine((value, ctx) => {
  const path = normalizePath(value.path);
  const builtIns = new Set(["/bestsellers", "/new-releases", "/preorders", "/deals"]);
  if (!builtIns.has(path) && !/^\/campaign\/[a-z0-9]+(?:-[a-z0-9]+)*$/.test(path)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["path"], message: "Custom storefront pages must use /campaign/<slug>." });
  }
  if (value.startsAt && value.endsAt && Date.parse(value.startsAt) >= Date.parse(value.endsAt)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["endsAt"], message: "The end time must be after the start time." });
  }
});

const manualTaxonomyInput = z.object({
  editionId: z.string().trim().min(1).max(160),
  taxonomyNodeIds: z.array(z.string().trim().min(1).max(100)).max(30),
});

async function audit(db: CatalogDB, action: string, entityType: string, entityId: string, before: unknown, after: unknown) {
  await db.prepare("INSERT INTO storefront_admin_audit(id,actor,action,entity_type,entity_id,before_json,after_json,created_at) VALUES(?,?,?,?,?,?,?,?)")
    .bind(crypto.randomUUID(), "operator", action, entityType, entityId, before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null, now()).run();
}

function taxonomyPathFromParent(parentPath: string | null, slug: string) {
  return parentPath ? `${parentPath}/${slug}` : slug;
}

async function refreshTaxonomyProjection(db: CatalogDB, nodeIds: string[]) {
  const ids = [...new Set(nodeIds)].filter(Boolean);
  if (!ids.length) return;
  const placeholders = ids.map(() => "?").join(",");
  await db.prepare(`UPDATE catalog_search_documents SET taxonomy_text=COALESCE((
      SELECT group_concat(n.path,' | ') FROM products px
      JOIN edition_taxonomy_nodes etx ON etx.edition_id=px.edition_id
      JOIN storefront_taxonomy_nodes n ON n.id=etx.taxonomy_node_id
      WHERE px.id=catalog_search_documents.product_id
    ),'') WHERE product_id IN (
      SELECT DISTINCT p.id FROM products p JOIN edition_taxonomy_nodes et ON et.edition_id=p.edition_id
      WHERE et.taxonomy_node_id IN (${placeholders})
    )`).bind(...ids).run();
  await db.prepare(`INSERT INTO search_index_outbox(product_id,operation,queued_at,attempts,last_error)
      SELECT DISTINCT p.id,'upsert',?,0,'' FROM products p JOIN edition_taxonomy_nodes et ON et.edition_id=p.edition_id
      WHERE p.source_name<>'upload' AND et.taxonomy_node_id IN (${placeholders})
      ON CONFLICT(product_id) DO UPDATE SET operation='upsert',queued_at=excluded.queued_at,attempts=0,last_error=''`)
    .bind(now(), ...ids).run();
}

export async function adminTaxonomySnapshot(db: CatalogDB) {
  const [nodes, mappings, manualAssignments, pages, auditRows] = await Promise.all([
    db.prepare("SELECT * FROM storefront_taxonomy_nodes ORDER BY depth,sort_order,name").all<any>(),
    db.prepare("SELECT m.*,n.name node_name,n.path node_path FROM storefront_taxonomy_mappings m JOIN storefront_taxonomy_nodes n ON n.id=m.taxonomy_node_id ORDER BY m.priority DESC,m.source_value").all<any>(),
    db.prepare(`SELECT et.edition_id,group_concat(et.taxonomy_node_id) taxonomy_node_ids,group_concat(n.path,' | ') taxonomy_paths
      FROM edition_taxonomy_nodes et JOIN storefront_taxonomy_nodes n ON n.id=et.taxonomy_node_id
      WHERE et.source='manual' GROUP BY et.edition_id ORDER BY et.edition_id LIMIT 500`).all<any>(),
    db.prepare("SELECT * FROM storefront_pages ORDER BY path").all<any>(),
    db.prepare("SELECT * FROM storefront_admin_audit ORDER BY created_at DESC LIMIT 100").all<any>(),
  ]);
  return { nodes: nodes.results, mappings: mappings.results, manualAssignments: manualAssignments.results, pages: pages.results, audit: auditRows.results };
}

export async function upsertTaxonomyNode(db: CatalogDB, raw: unknown) {
  const input = taxonomyNodeInput.parse(raw);
  const id = input.id || `tax_${crypto.randomUUID()}`;
  const before = await db.prepare("SELECT * FROM storefront_taxonomy_nodes WHERE id=?").bind(id).first<any>();
  const parent = input.parentId ? await db.prepare("SELECT id,path,depth FROM storefront_taxonomy_nodes WHERE id=?").bind(input.parentId).first<any>() : null;
  if (input.parentId && !parent) throw new ApiError(400, "The parent category does not exist.");
  if (parent && String(parent.id) === id) throw new ApiError(400, "A category cannot be its own parent.");
  if (before && parent && (String(parent.path) === String(before.path) || String(parent.path).startsWith(`${String(before.path)}/`))) {
    throw new ApiError(400, "A category cannot be moved underneath one of its descendants.");
  }
  const path = taxonomyPathFromParent(parent ? String(parent.path) : null, input.slug);
  const conflict = await db.prepare("SELECT id FROM storefront_taxonomy_nodes WHERE taxonomy_id='tax_fore_books' AND path=? AND id<>? LIMIT 1").bind(path,id).first<any>();
  if (conflict) throw new ApiError(409, "Another category already uses this path.");
  const oldSubtree = before?.path
    ? await db.prepare("SELECT id,path FROM storefront_taxonomy_nodes WHERE id=? OR path LIKE ? ORDER BY depth").bind(id, `${String(before.path)}/%`).all<any>()
    : { results: [] as any[] };
  const at = now();
  await db.prepare(`INSERT INTO storefront_taxonomy_nodes(id,taxonomy_id,parent_id,slug,path,name,description,depth,sort_order,visible,featured,seo_title,seo_description,created_at,updated_at)
    VALUES(?,'tax_fore_books',?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET parent_id=excluded.parent_id,slug=excluded.slug,path=excluded.path,name=excluded.name,description=excluded.description,depth=excluded.depth,sort_order=excluded.sort_order,visible=excluded.visible,featured=excluded.featured,seo_title=excluded.seo_title,seo_description=excluded.seo_description,updated_at=excluded.updated_at`)
    .bind(id, input.parentId || null, input.slug, path, input.name, input.description, parent ? Number(parent.depth) + 1 : 0, input.sortOrder, input.visible ? 1 : 0, input.featured ? 1 : 0, input.seoTitle, input.seoDescription, before?.created_at || at, at).run();
  if (before?.path && before.path !== path) {
    const depthDelta = (parent ? Number(parent.depth) + 1 : 0) - Number(before.depth || 0);
    await db.prepare(`UPDATE storefront_taxonomy_nodes SET path=?||substr(path,?),depth=depth+?,updated_at=? WHERE path LIKE ?`)
      .bind(path, String(before.path).length + 1, depthDelta, at, `${String(before.path)}/%`).run();
    const changedIds = oldSubtree.results.map((row:any) => String(row.id));
    const placeholders = changedIds.map(() => "?").join(",");
    const newRows = changedIds.length ? await db.prepare(`SELECT id,path FROM storefront_taxonomy_nodes WHERE id IN (${placeholders})`).bind(...changedIds).all<any>() : { results: [] as any[] };
    const newById = new Map(newRows.results.map((row:any) => [String(row.id), String(row.path)]));
    for (const oldRow of oldSubtree.results) {
      const oldPath = `/ebooks/${String(oldRow.path)}`;
      const newPath = `/ebooks/${String(newById.get(String(oldRow.id)) || oldRow.path)}`;
      if (oldPath === newPath) continue;
      await db.prepare("DELETE FROM storefront_redirects WHERE from_path=?").bind(newPath).run();
      await db.prepare(`INSERT INTO storefront_redirects(from_path,to_path,status_code,created_at,updated_at) VALUES(?,?,301,?,?)
        ON CONFLICT(from_path) DO UPDATE SET to_path=excluded.to_path,status_code=301,updated_at=excluded.updated_at`)
        .bind(oldPath,newPath,at,at).run();
    }
    await refreshTaxonomyProjection(db, changedIds);
  }
  const after = await db.prepare("SELECT * FROM storefront_taxonomy_nodes WHERE id=?").bind(id).first<any>();
  await audit(db, before ? "update" : "create", "taxonomy_node", id, before, after);
  return after;
}

export async function upsertTaxonomyMapping(db: CatalogDB, raw: unknown) {
  const input = taxonomyMappingInput.parse(raw);
  const exists = await db.prepare("SELECT id FROM storefront_taxonomy_nodes WHERE id=?").bind(input.taxonomyNodeId).first<any>();
  if (!exists) throw new ApiError(400, "The mapped category does not exist.");
  const id = input.id || `map_${crypto.randomUUID()}`;
  const before = await db.prepare("SELECT * FROM storefront_taxonomy_mappings WHERE id=?").bind(id).first<any>();
  const at = now();
  await db.prepare(`INSERT INTO storefront_taxonomy_mappings(id,taxonomy_node_id,source_scheme,source_value,match_mode,priority,active,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET taxonomy_node_id=excluded.taxonomy_node_id,source_scheme=excluded.source_scheme,source_value=excluded.source_value,match_mode=excluded.match_mode,priority=excluded.priority,active=excluded.active,updated_at=excluded.updated_at`)
    .bind(id, input.taxonomyNodeId, input.sourceScheme, input.sourceValue, input.matchMode, input.priority, input.active ? 1 : 0, before?.created_at || at, at).run();
  const after = await db.prepare("SELECT * FROM storefront_taxonomy_mappings WHERE id=?").bind(id).first<any>();
  await audit(db, before ? "update" : "create", "taxonomy_mapping", id, before, after);
  return after;
}

export async function setManualEditionTaxonomy(db: CatalogDB, raw: unknown) {
  const input = manualTaxonomyInput.parse(raw);
  const edition = await db.prepare("SELECT id FROM editions WHERE id=?").bind(input.editionId).first<any>();
  if (!edition) throw new ApiError(404, "Edition not found.");
  const uniqueIds = [...new Set(input.taxonomyNodeIds)];
  if (uniqueIds.length) {
    const placeholders = uniqueIds.map(() => "?").join(",");
    const valid = await db.prepare(`SELECT id FROM storefront_taxonomy_nodes n JOIN storefront_taxonomies t ON t.id=n.taxonomy_id
      WHERE t.is_default=1 AND t.status='active' AND n.id IN (${placeholders})`).bind(...uniqueIds).all<any>();
    if (valid.results.length !== uniqueIds.length) throw new ApiError(400, "One or more taxonomy categories do not exist in the active retail taxonomy.");
  }
  const before = await db.prepare("SELECT taxonomy_node_id FROM edition_taxonomy_nodes WHERE edition_id=? AND source='manual' ORDER BY taxonomy_node_id").bind(input.editionId).all<any>();
  await db.prepare("DELETE FROM edition_taxonomy_nodes WHERE edition_id=? AND source='manual'").bind(input.editionId).run();
  const at = now();
  for (const nodeId of uniqueIds) {
    await db.prepare("INSERT INTO edition_taxonomy_nodes(edition_id,taxonomy_node_id,source,confidence,is_primary,created_at) VALUES(?,?,'manual',1.0,0,?)")
      .bind(input.editionId, nodeId, at).run();
  }
  await syncEditionTaxonomy(db, input.editionId);
  await audit(db, "replace_manual", "edition_taxonomy", input.editionId, before.results, uniqueIds);
  return { editionId: input.editionId, taxonomyNodeIds: uniqueIds };
}

export async function upsertStorefrontPage(db: CatalogDB, raw: unknown) {
  const input = pageInput.parse(raw);
  const id = input.id || `page_${crypto.randomUUID()}`;
  const before = await db.prepare("SELECT * FROM storefront_pages WHERE id=?").bind(id).first<any>();
  const path = normalizePath(input.path);
  const pathOwner = await db.prepare("SELECT id FROM storefront_pages WHERE path=? AND id<>? LIMIT 1").bind(path,id).first<any>();
  if (pathOwner) throw new ApiError(409, "Another landing page already uses this path.");
  if (input.startsAt && input.endsAt && Date.parse(input.startsAt) >= Date.parse(input.endsAt)) throw new ApiError(400, "The end time must be after the start time.");
  const at = now();
  await db.prepare(`INSERT INTO storefront_pages(id,path,page_type,title,heading,description,eyebrow,seo_title,seo_description,query_json,status,territory_code,language_code,starts_at,ends_at,noindex,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET path=excluded.path,page_type=excluded.page_type,title=excluded.title,heading=excluded.heading,description=excluded.description,eyebrow=excluded.eyebrow,seo_title=excluded.seo_title,seo_description=excluded.seo_description,query_json=excluded.query_json,status=excluded.status,territory_code=excluded.territory_code,language_code=excluded.language_code,starts_at=excluded.starts_at,ends_at=excluded.ends_at,noindex=excluded.noindex,updated_at=excluded.updated_at`)
    .bind(id, path, input.pageType, input.title, input.heading, input.description, input.eyebrow, input.seoTitle, input.seoDescription, JSON.stringify(input.query), input.status, input.territoryCode || null, input.languageCode || null, input.startsAt || null, input.endsAt || null, input.noindex ? 1 : 0, before?.created_at || at, at).run();
  const after = await db.prepare("SELECT * FROM storefront_pages WHERE id=?").bind(id).first<any>();
  await audit(db, before ? "update" : "create", "storefront_page", id, before, after);
  return after;
}
