/* eslint-disable prettier/prettier -- Keep bounded FTS query and source trust checks adjacent. */
// Private, advisory candidate discovery. Must never be exposed as a legal or
// purchase decision. Serving code must independently recheck PRIMARY D1.
type Statement = {
  bind(...values: unknown[]): Statement;
  first<T>(): Promise<T | null>;
  all<T>(): Promise<{ results: T[] }>;
};
type DB = { prepare(sql: string): Statement };
export type CatalogQueryEnv = {
  CATALOG_INDEX_DB: DB;
  COVE_CATALOG_SEARCH_ENABLED?: string;
};
export function catalogSearchExpression(raw: unknown) {
  if (typeof raw !== "string" || raw.length > 160) throw Error("invalid_catalog_query");
  const terms = raw.normalize("NFKC").match(/[\p{L}\p{N}]+/gu) || [];
  if (terms.length < 1 || terms.length > 8) throw Error("invalid_catalog_query");
  return terms.map((t) => '"' + t.slice(0, 48) + '"').join(" AND ");
}
export async function queryIsolatedCatalogIndex(
  env: CatalogQueryEnv,
  input: { query?: unknown; page?: unknown; limit?: unknown },
) {
  if (env.COVE_CATALOG_SEARCH_ENABLED !== "1")
    throw Error("catalog_search_disabled");
  const page = Number(input.page ?? 1), limit = Number(input.limit ?? 24);
  if (!Number.isInteger(page) || page < 1 || page > 10 ||
      !Number.isInteger(limit) || limit < 1 || limit > 64)
    throw Error("invalid_catalog_page");
  const expression = catalogSearchExpression(input.query);
  const identity = await env.CATALOG_INDEX_DB.prepare(
    "SELECT domain,EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name IN ('rights_grants','entitlements','orders','payment_orders')) contaminated FROM catalog_index_identity WHERE id=1"
  ).first<{ domain: string; contaminated: number }>();
  if (identity?.domain !== "cove-independent-catalog-index" || identity.contaminated)
    throw Error("catalog_search_domain_not_isolated");
  const results = await env.CATALOG_INDEX_DB.prepare(
    `SELECT catalog_index_fts.product_id FROM catalog_index_fts
    JOIN catalog_index_documents d ON d.rowid=catalog_index_fts.rowid
    WHERE catalog_index_fts MATCH ? AND d.visible=1
    ORDER BY bm25(catalog_index_fts),catalog_index_fts.rowid LIMIT ? OFFSET ?`,
  ).bind(expression, limit + 1, (page - 1) * limit)
    .all<{ product_id: string }>();
  const ids = results.results.slice(0, limit).map((r) => r.product_id);
  if (ids.some((x) => !/^prd_gutenberg_[a-z0-9_]{1,120}$/.test(x)) ||
      new Set(ids).size !== ids.length) throw Error("catalog_search_invalid_index");
  return {
    schema: "cove.catalog.candidates.v1",
    ids,
    hasMore: results.results.length > limit,
    // This is deliberately NOT a count of rights-eligible books.
    // Consumers cannot surface it as legal availability.
    authoritative: false,
  };
}

export async function queryIsolatedCatalogGraph(env:CatalogQueryEnv, ids:unknown) {
  if (env.COVE_CATALOG_SEARCH_ENABLED !== "1") throw Error("catalog_search_disabled");
  if (!Array.isArray(ids)||ids.length<1||ids.length>24||
      ids.some(x=>typeof x!=="string"||!/^prd_gutenberg_[a-z0-9_]{1,120}$/.test(x))||
      new Set(ids).size!==ids.length)
    throw Error("invalid_catalog_graph_candidates");
  const identity=await env.CATALOG_INDEX_DB.prepare(
    "SELECT domain,EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name IN ('rights_grants','entitlements','orders','payment_orders','products')) contaminated FROM catalog_index_identity WHERE id=1"
  ).first<{domain:string;contaminated:number}>();
  if(identity?.domain!=="cove-independent-catalog-index"||identity.contaminated)
    throw Error("catalog_graph_domain_not_isolated");
  const results=await env.CATALOG_INDEX_DB.prepare(
    "SELECT product_id,edition_id,work_id,revision,visible,title,description,contributors_json,subjects_json,shelves_json,languages_json,assets_json FROM catalog_graph_documents WHERE product_id IN ("+
      ids.map(()=>"?").join(",")+") AND visible=1"
  ).bind(...ids).all<{
    product_id:string;edition_id:string;work_id:string;revision:number;visible:number;
    title:string;description:string;contributors_json:string;subjects_json:string;
    shelves_json:string;languages_json:string;assets_json:string;
  }>();
  const allowed=new Set(ids as string[]);
  const items=results.results.map((row)=>{
    if(!allowed.has(row.product_id)||!row.edition_id.startsWith("ed_gutenberg_")||
       !row.work_id.startsWith("wrk_gutenberg_")||
       !Number.isSafeInteger(row.revision)||row.revision<0||
       row.title.length>512||row.description.length>5000||row.visible!==1)
      throw Error("catalog_graph_corrupt_row");
    function textArray(raw:string,max:number){
      const parsed:unknown=JSON.parse(raw);
      if(!Array.isArray(parsed)||parsed.length>max||
        parsed.some(x=>typeof x!=="string"||x.length>200))
        throw Error("catalog_graph_corrupt_array");
      return parsed as string[];
    }
    const authors=textArray(row.contributors_json,40);
    const subjects=textArray(row.subjects_json,60);
    const shelves=textArray(row.shelves_json,40);
    const languages=textArray(row.languages_json,16);
    const assets=JSON.parse(row.assets_json) as unknown;
    if(!assets||typeof assets!=="object"||Array.isArray(assets))
      throw Error("catalog_graph_corrupt_assets");
    // A database row is never trusted to provide a raw download URL.
    const cover=(assets as Record<string,unknown>)["image/jpeg"]||
      (assets as Record<string,unknown>)["image/png"];
    let coverUrl:string|null=null;
    if(cover!==undefined){
      if(typeof cover!=="string"||cover.length>2048) throw Error("catalog_graph_corrupt_cover");
      const u=new URL(cover);
      if(u.protocol!=="https:"||u.username||u.password||!u.hostname.includes("."))
        throw Error("catalog_graph_corrupt_cover");
      coverUrl=u.href;
    }
    return {productId:row.product_id,editionId:row.edition_id,workId:row.work_id,
      revision:row.revision,title:row.title,description:row.description,
      authors,subjects,shelves,languages,coverUrl};
  });
  const order=new Map((ids as string[]).map((id,index)=>[id,index]));
  items.sort((a,b)=>(order.get(a.productId)??999)-(order.get(b.productId)??999));
  return {schema:"cove.catalog.graph.v1",authoritative:false,books:items};
}
