import type { CoveEnv } from "../features/fore/api.server";
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
import { renderStranglerStorefront } from "./render";
import { bootstrapFailureKind } from "./failure";

/** Build-isolated serving boundary. No auth, orders, reader or background code.
 * Existing domain logic is reused through type-only references. This pilot is
 * deliberately non-routable: no production DNS, no customer credentials.
 */
export type StorefrontStranglerEnv = CoveEnv & {
  COVE_STRANGLER_MODE?: string;
  COVE_STRANGLER_DATABASE_ID?: string;
  COVE_SSR_STAGING_GATE_KEY?: string;
  COVE_INTERNAL_CORE_STAGE_GATE_KEY?: string;
  CORE: { fetch(request: Request): Promise<Response> };
};

export default {
  async fetch(request: Request, env: StorefrontStranglerEnv): Promise<Response> {
    // Fail closed even under an accidental deployment or config substitution.
    // The reviewed config must also contain only the dedicated synthetic D1.
    if (
      env.COVE_SSR_STAGING !== "1" ||
      env.COVE_STRANGLER_MODE !== "isolated-evaluation" ||
      env.COVE_STRANGLER_DATABASE_ID !== "e4cbb0ef-6288-4fa1-9dbb-fb42fe01d4f3"
    )
      return new Response(null, { status: 503, headers: { "cache-control": "no-store" } });
    const rejected = await rejectUnauthenticatedStagingRequest(request, env);
    if (rejected) return rejected;
    const finish = (response: Response) =>
      stageNoStore(applySecurityHeaders(request, response, env), true);
    // Stage bearer authorizes this gateway, not a customer session at CORE.
    const delegate = () => {
      const headers = new Headers(request.headers);
      // The operator's ingress token is NEVER a backend identity.
      // A different service-only secret can be provisioned for the private
      // real CORE Worker; never reuse or reflect the outer bearer.
      headers.delete("authorization");
      const internal = env.COVE_INTERNAL_CORE_STAGE_GATE_KEY;
      if (internal) {
        if (!/^[a-f0-9]{64}$/.test(internal) || internal === env.COVE_SSR_STAGING_GATE_KEY)
          return Promise.resolve(new Response(null, { status: 503 }));
        headers.set("authorization", "Bearer " + internal);
      }
      return env.CORE.fetch(new Request(request, { headers }));
    };
    let failurePhase = "entry";
    try {
      const url = new URL(request.url);
      const diagnostic = url.pathname === "/__cove_perf/bootstrap" && !url.search;
      const transportControl = url.pathname === "/__cove_perf/transport" && !url.search;
      // Authenticated transport control intentionally bypasses D1 and R2.
      // It establishes a same-gateway transport/runtime floor, not a claim
      // that the residual latency is all network time.
      if (
        request.method !== "GET" ||
        (!diagnostic && !transportControl && (url.pathname !== "/" || url.search))
      )
        return await delegate();
      if (transportControl)
        return finish(
          new Response("ok", {
            headers: {
              "content-type": "text/plain; charset=utf-8",
              "x-cove-renderer": "transport-control",
            },
          }),
        );
      const safe = isolateWorkerCountry(request);
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
      if (!canUseLeanAnonymousBootstrap(bootstrapRequest, env)) return await delegate();
      failurePhase = "bootstrap";
      // The current main-branch canonical bootstrap has a two-argument API.
      // Preserve it unchanged; all failures remain fail-closed and classified.
      // No presentation cache or independent authorizer is activated here.
      // Main's authoritative live territorial-rights bootstrap remains unchanged.
      const response = await serveLeanAnonymousBootstrap(bootstrapRequest, env);
      if (!response.ok) return finish(new Response(null, { status: response.status }));
      const bootstrap = (await response.json()) as StorefrontBootstrap;
      if (bootstrap.context.rightsCountry !== headers.get("x-cove-client-country"))
        throw new Error("Thin storefront territorial mismatch");
      if (diagnostic) {
        if (
          !Array.isArray(bootstrap.context.availableMarkets) ||
          !Array.isArray(bootstrap.catalog.results)
        )
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
        new Response(renderStranglerStorefront(bootstrap, env.FORE_PUBLIC_URL || url.origin), {
          headers: {
            "content-type": "text/html; charset=utf-8",
            "cache-control": "private, no-store",
            "x-cove-renderer": "strangler-evaluation",
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
      // Only a small allowlist of error-phase labels is visible in this
      // authenticated synthetic stage; never send SQL, book IDs, or secrets.
      const code = "bootstrap";
      return finish(
        new Response("Storefront temporarily unavailable.", {
          status,
          headers: { "x-cove-stage-failure": code },
        }),
      );
    }
  },
};
