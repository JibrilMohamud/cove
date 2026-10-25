/* eslint-disable prettier/prettier -- Keep private catalog-authority boundary checks locally auditable. */
import { queryIsolatedCatalogIndex, queryIsolatedCatalogGraph, type CatalogQueryEnv } from "./catalog-index-query.server";

// Private service binding only. This worker has NO rights/commerce D1 binding.
export default {
  async fetch(request: Request, env: CatalogQueryEnv) {
    const pathname=new URL(request.url).pathname;
    if (request.method !== "POST" || !["/query","/graph"].includes(pathname))
      return new Response(null, { status: 404 });
    if (request.headers.get("content-type")?.split(";")[0]?.trim() !== "application/json")
      return new Response(null, { status: 415 });
    const body = await request.text();
    if (body.length > 4096) return new Response(null, { status: 413 });
    let params: { query?: unknown; page?: unknown; limit?: unknown; ids?: unknown };
    try { params = JSON.parse(body); }
    catch { return new Response(null, { status: 400 }); }
    if (!params || typeof params !== "object" || Array.isArray(params))
      return new Response(null, { status: 400 });
    try {
      const result=pathname==="/graph"
        ? await queryIsolatedCatalogGraph(env,params.ids)
        : await queryIsolatedCatalogIndex(env,params);
      return new Response(JSON.stringify(result), {
        status: 200,
        headers: { "content-type": "application/json", "cache-control": "no-store" },
      });
    } catch (error) {
      console.warn("isolated_catalog_query_unavailable", String(error));
      return new Response(null, { status: 503, headers: { "cache-control": "no-store" } });
    }
  },
};
