import { syntheticClient } from "./synthetic-client";
import type { ThinStorefrontEnv } from "./env";
import { isolateWorkerCountry } from "../lib/cloudflare-country.server";
import {
  rejectUnauthenticatedStagingRequest,
  stageNoStore,
} from "../lib/cloudflare-ssr-stage-gate.server";
import { applySecurityHeaders } from "../lib/security-headers";
import {
  canUseLeanAnonymousBootstrap,
  serveLeanAnonymousBootstrap,
} from "../features/fore/storefront-anonymous-bootstrap.server";
import type { StorefrontBootstrap } from "../features/fore/storefront-bootstrap";
import { renderThinStorefront } from "./render";
import { bootstrapFailureKind } from "./failure";
import { loadThinPresentationContext } from "./presentation-cache";

// The shared app uses DOM Request/Response types. Adapt only Fetcher's
// structural web signature; generated configuration still owns every binding.
type ThinRuntimeEnv = Omit<ThinStorefrontEnv, "CORE"> & {
  CORE: { fetch(request: Request): Promise<Response> };
};

export default {
  async fetch(request: Request, env: ThinRuntimeEnv): Promise<Response> {
    // This first experiment cannot be enabled on production by a flag typo.
    if (env.COVE_SSR_STAGING !== "1" || env.COVE_THIN_STOREFRONT !== "synthetic-only")
      return new Response(null, { status: 503, headers: { "cache-control": "no-store" } });
    const rejected = await rejectUnauthenticatedStagingRequest(request, env);
    if (rejected) return rejected;
    const finish = (response: Response) =>
      stageNoStore(applySecurityHeaders(request, response, env), true);
    let failurePhase = "entry";
    try {
      const url = new URL(request.url);
      const diagnostic = url.pathname === "/__cove_perf/bootstrap" && !url.search;
      // Service binding preserves all existing auth, account, reader, API and
      // filtered navigation. No public HTTP hop or recursive homepage fetch.
      if (request.method !== "GET" || (!diagnostic && (url.pathname !== "/" || url.search)))
        return await env.CORE.fetch(request);
      const safe = isolateWorkerCountry(syntheticClient(request, env));
      if (!safe)
        return finish(new Response("Unable to verify storefront territory.", { status: 503 }));
      const headers = new Headers(safe.headers);
      headers.delete("authorization"); // staging gate credential is never an app identity
      const bootstrapRequest = new Request(new URL("/api/fore/storefront/bootstrap", request.url), {
        headers,
        signal: request.signal,
      });
      // Any cookie/identity hint uses the established application; preferences
      // and account state cannot leak into an anonymous response.
      if (!canUseLeanAnonymousBootstrap(bootstrapRequest, env))
        return await env.CORE.fetch(request);
      failurePhase = "bootstrap";
      const response = await serveLeanAnonymousBootstrap(
        bootstrapRequest,
        env,
        (phase) => {
          failurePhase = phase;
        },
        (read) => loadThinPresentationContext(bootstrapRequest, env, read),
      );
      if (!response.ok) return finish(new Response(null, { status: response.status }));
      const bootstrap = (await response.json()) as StorefrontBootstrap;
      if (bootstrap.context.rightsCountry !== headers.get("x-cove-client-country"))
        throw new Error("Thin storefront territorial mismatch");
      if (diagnostic) {
        if (!Array.isArray(bootstrap.context.availableMarkets) || !bootstrap.catalog.results.length)
          throw new Error("Anonymous market projection is unavailable.");
        return finish(
          new Response(
            JSON.stringify({
              stage: "bootstrap",
              ok: true,
              renderer: "thin",
              books: bootstrap.catalog.results.length,
              markets: bootstrap.context.availableMarkets.length,
            }),
            {
              headers: {
                "content-type": "application/json",
                "server-timing": response.headers.get("server-timing") || "",
              },
            },
          ),
        );
      }
      failurePhase = "render";
      return finish(
        new Response(
          renderThinStorefront(
            bootstrap,
            env.FORE_PUBLIC_URL || url.origin,
            (env as ThinRuntimeEnv & { COVE_THIN_EXPERIENCE?: string }).COVE_THIN_EXPERIENCE === "1",
          ),
          {
          headers: {
            "content-type": "text/html; charset=utf-8",
            "cache-control": "private, no-store",
            "x-cove-renderer": "thin-prototype",
            "server-timing": response.headers.get("server-timing") || "",
          },
        }),
      );
    } catch (error) {
      // A failed live-rights read never becomes a cached offer or success page.
      const status =
        typeof error === "object" && error !== null && "status" in error && error.status === 429
          ? 429
          : 503;
      console.error(
        JSON.stringify({
          event: "thin_storefront_failed",
          status,
          phase: failurePhase,
          kind: bootstrapFailureKind(error),
        }),
      );
      return finish(new Response("Storefront temporarily unavailable.", { status }));
    }
  },
};
