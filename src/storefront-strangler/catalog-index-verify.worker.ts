/* eslint-disable prettier/prettier -- Keep private catalog-authority boundary checks locally auditable. */
import {
  verifyIsolatedCatalogCandidates,
  verifyIsolatedCatalogBooks,
  type CatalogIndexVerifyEnv,
} from "./catalog-index-verify.server";

// Private staging only; never serve a public endpoint or use this for checkout.
export default {
  async fetch(request: Request, env: CatalogIndexVerifyEnv) {
    const pathname=new URL(request.url).pathname;
    if (request.method !== "POST" || !["/verify","/verify-books"].includes(pathname))
      return new Response(null, { status: 404 });
    if (request.headers.get("content-type")?.split(";")[0]?.trim() !== "application/json")
      return new Response(null, { status: 415 });
    const input = await request.text();
    if (input.length > 1024) return new Response(null, { status: 413 });
    let data: { query?: unknown; territory?: unknown; currency?: unknown };
    try { data = JSON.parse(input); } catch { return new Response(null, {status:400}); }
    if (!data || typeof data !== "object" || typeof data.query !== "string" ||
        typeof data.territory !== "string" ||
        (data.currency !== undefined && typeof data.currency !== "string"))
      return new Response(null,{status:400});
    try {
      const result = pathname==="/verify-books"
        ? await verifyIsolatedCatalogBooks(env,data.query,data.territory,data.currency||"USD")
        : await verifyIsolatedCatalogCandidates(env,data.query,data.territory,data.currency||"USD");
      return Response.json(result,{headers:{"cache-control":"no-store"}});
    } catch (err) {
      console.warn("catalog_index_authority_probe_failed",String(err));
      return new Response(null,{status:503,headers:{"cache-control":"no-store"}});
    }
  },
};
