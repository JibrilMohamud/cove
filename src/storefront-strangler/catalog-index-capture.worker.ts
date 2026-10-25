import { captureIsolatedCatalogIndex, type CatalogCaptureEnv } from "./catalog-index-capture.server";

// Deploy only as a non-routable, service-bound, disabled-by-default Worker.
// It has READ access to canonical source rows and WRITE access only to the
// independent catalog-index D1; customer rights are never imported.
export default {
  async fetch(request: Request, env: CatalogCaptureEnv) {
    if (request.method !== "POST" || new URL(request.url).pathname !== "/run")
      return new Response(null, { status: 404 });
    return Response.json(await captureIsolatedCatalogIndex(env));
  },
  scheduled(_controller: unknown, env: CatalogCaptureEnv, ctx: { waitUntil(job: Promise<unknown>): void }) {
    ctx.waitUntil(captureIsolatedCatalogIndex(env).then((result) =>
      console.info(JSON.stringify({ event: "isolated_catalog_capture", result }))));
  },
};
