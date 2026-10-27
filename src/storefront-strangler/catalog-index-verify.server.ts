/* eslint-disable prettier/prettier -- Keep private catalog-authority boundary checks locally auditable. */
import { authorizeStorefrontPresentationIds, type CatalogDB } from "../features/fore/catalog-model.server";

// This is a private QA bridge: index results are only anonymous candidates.
// Primary D1 independently enforces the freshest retail rights, source
// suppression, market currency, release status, and active offer eligibility.
export type CatalogIndexVerifyEnv = {
  PRIMARY_DB: CatalogDB;
  CATALOG_QUERY: { fetch(request: Request): Promise<Response> };
  COVE_CATALOG_INDEX_VERIFY_ENABLED?: string;
};
export async function verifyIsolatedCatalogCandidates(
  env: CatalogIndexVerifyEnv,
  query: string,
  territory: string,
  currency = "USD",
) {
  if (env.COVE_CATALOG_INDEX_VERIFY_ENABLED !== "1")
    throw Error("catalog_index_verification_disabled");
  if (!/^[A-Z]{2}$/.test(territory) || !/^[A-Z]{3}$/.test(currency))
    throw Error("invalid_catalog_market");
  const response = await env.CATALOG_QUERY.fetch(
    new Request("https://catalog-index.internal/query", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query, page: 1, limit: 64 }),
    }),
  );
  if (!response.ok) throw Error("catalog_index_search_failed");
  const snapshot = (await response.json()) as {
    schema?: string;
    authoritative?: boolean;
    ids?: unknown;
  };
  if (snapshot.schema !== "cove.catalog.candidates.v1" ||
      snapshot.authoritative !== false || !Array.isArray(snapshot.ids) ||
      snapshot.ids.length > 64 ||
      snapshot.ids.some((id: unknown) => typeof id !== "string" ||
        !/^prd_gutenberg_[a-z0-9_]{1,120}$/.test(id)) ||
      new Set(snapshot.ids).size !== snapshot.ids.length)
    throw Error("catalog_index_untrusted_snapshot");
  // Never authorize an indexed book by absence of a tombstone or by
  // trusting an asynchronously replicated territory/price field.
  const live = await authorizeStorefrontPresentationIds(
    env.PRIMARY_DB, snapshot.ids as string[], territory, currency
  );
  return {
    source: "isolated-index-live-primary",
    productIds: live.map((r) => r.product_id),
    authoritative: true,
    // No total count or derived legal grant leaks into the result.
  };
}

/**
 * Read the isolated, fully prepared discovery graph BEFORE making the final
 * primary-authoritative rights check. Cached graph metadata is never a grant.
 * In-flight withdrawals are resolved at the last D1 read, not when search
 * candidates or isolated display metadata were fetched.
 */
export async function verifyIsolatedCatalogBooks(
  env:CatalogIndexVerifyEnv, query:string, territory:string, currency="USD",
) {
  if(env.COVE_CATALOG_INDEX_VERIFY_ENABLED!=="1") throw Error("catalog_index_verification_disabled");
  if(!/^[A-Z]{2}$/.test(territory)||!/^[A-Z]{3}$/.test(currency))
    throw Error("invalid_catalog_market");
  const candidatesResponse=await env.CATALOG_QUERY.fetch(new Request("https://catalog-index.internal/query",{
    method:"POST",headers:{"content-type":"application/json"},
    body:JSON.stringify({query,page:1,limit:24}),
  }));
  if(!candidatesResponse.ok) throw Error("catalog_index_search_failed");
  const candidates=await candidatesResponse.json() as {
    schema?:string;authoritative?:boolean;ids?:unknown;
  };
  if(candidates.schema!=="cove.catalog.candidates.v1"||
     candidates.authoritative!==false||!Array.isArray(candidates.ids)||
     candidates.ids.length>24||
     candidates.ids.some(id=>typeof id!=="string"||!/^prd_gutenberg_[a-z0-9_]{1,120}$/.test(id))||
     new Set(candidates.ids).size!==candidates.ids.length)
    throw Error("catalog_index_untrusted_snapshot");
  if(candidates.ids.length===0) return {source:"isolated-graph-live-primary",books:[],authoritative:true};
  const graphResponse=await env.CATALOG_QUERY.fetch(new Request("https://catalog-index.internal/graph",{
    method:"POST",headers:{"content-type":"application/json"},
    body:JSON.stringify({ids:candidates.ids}),
  }));
  if(!graphResponse.ok) throw Error("catalog_index_graph_failed");
  const graph=await graphResponse.json() as {
    schema?:string;authoritative?:boolean;books?:unknown;
  };
  if(graph.schema!=="cove.catalog.graph.v1"||graph.authoritative!==false||
     !Array.isArray(graph.books)||graph.books.length>24)
    throw Error("catalog_index_untrusted_graph");
  const allowed=new Set(candidates.ids);
  const metadata=new Map<string,{
    productId:string;editionId:string;title:string;
    authors:string[];subjects:string[];shelves:string[];coverUrl:string|null;
  }>();
  for(const raw of graph.books){
    const b=raw as Record<string,unknown>;
    if(!b||typeof b!=="object"||typeof b.productId!=="string"||
       !allowed.has(b.productId)||metadata.has(b.productId)||
       typeof b.editionId!=="string"||
       typeof b.title!=="string"||b.title.length>512||
       !Array.isArray(b.authors)||b.authors.length>40||
       b.authors.some(x=>typeof x!=="string"||x.length>200)||
       !Array.isArray(b.subjects)||b.subjects.length>60||
       b.subjects.some(x=>typeof x!=="string"||x.length>200)||
       !Array.isArray(b.shelves)||b.shelves.length>40||
       b.shelves.some(x=>typeof x!=="string"||x.length>200)||
       (b.coverUrl!==null&&b.coverUrl!==undefined&&
         (typeof b.coverUrl!=="string"||b.coverUrl.length>2048)))
      throw Error("catalog_index_untrusted_graph");
    if(b.coverUrl){
      const cover=new URL(b.coverUrl as string);
      if(cover.protocol!=="https:"||cover.username||cover.password||!cover.hostname.includes("."))
        throw Error("catalog_index_untrusted_graph");
    }
    metadata.set(b.productId,b as {
      productId:string;editionId:string;title:string;authors:string[];
      subjects:string[];shelves:string[];coverUrl:string|null;
    });
  }
  // The final external I/O operation is the authoritative primary D1 read.
  // No indexed graph evidence, replica, tombstone lag or stale offer decides.
  const authorized=await authorizeStorefrontPresentationIds(
    env.PRIMARY_DB,candidates.ids as string[],territory,currency
  );
  const books=authorized.flatMap(row=>{
    const b=metadata.get(row.product_id);
    if(!b||b.editionId!==row.edition_id||!row.offer_json) return [];
    const offer=JSON.parse(row.offer_json) as unknown;
    if(!offer||typeof offer!=="object") throw Error("catalog_invalid_authoritative_offer");
    return [{productId:row.product_id,editionId:row.edition_id,
      title:b.title,authors:b.authors,subjects:b.subjects,shelves:b.shelves,
      coverUrl:b.coverUrl,offer}];
  });
  return {source:"isolated-graph-live-primary",books,authoritative:true};
}
