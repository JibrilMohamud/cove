import { createServerFn } from "@tanstack/react-start";
import { getRequest, setResponseHeader } from "@tanstack/react-start/server";
import { z } from "zod/v3";
import {
  currentCoveRequestEnvironment,
  currentCoveRequestExecutionContext,
} from "@/lib/cove-request-env.server";
import { hedgedStorefrontBootstrap } from "./storefront-hedged-fetch";

// Only parameters that change catalog selection, ordering, pagination or the
// rights/locale context may suppress the verified first-page SSR shelf.
// Unknown query keys are inert to StorePage, so blocking SSR for them makes
// infrastructure and marketing links render needless placeholders.
function hasCatalogChangingQuery(search: string): boolean {
  const catalogKeys = new Set([
    "q",
    "search",
    "sort",
    "page",
    "taxonomy",
    "category",
    "language",
    "format",
    "publisher",
    "series",
    "authorid",
    "seriesid",
    "publisherid",
    "imprintid",
    "deals",
    "preorder",
    "newrelease",
    "subscription",
    "library",
    "minrating",
    "minprice",
    "maxprice",
    "publishedafter",
    "publishedbefore",
    "currency",
    "territory",
    "country",
    "market",
    "locale",
    "lang",
  ]);
  return [...new URLSearchParams(search).keys()].some((key) => catalogKeys.has(key.toLowerCase()));
}

export const loadStorefrontBootstrap = createServerFn({ method: "GET" })
  .inputValidator((value: string) => z.string().max(2000).parse(value))
  .handler(async ({ data }): Promise<string | null> => {
    if (hasCatalogChangingQuery(data)) {
      setResponseHeader("Server-Timing", "cove_ssr_query_filtered;dur=0");
      return null;
    }
    const request = getRequest();
    const source = new Request(new URL("/api/fore/storefront/bootstrap", request.url), {
      headers: request.headers,
      signal: request.signal,
    });
    const { proxyPersistenceApi } = await import("@/lib/persistence-backend");
    const env: Record<string, string | undefined> =
      typeof process === "undefined" ? {} : process.env;
    const remoteRequired =
      Boolean(env.FORE_BACKEND_URL && env.FORE_BACKEND_TOKEN) || env.VERCEL_ENV === "production";
    const localEnvironment = currentCoveRequestEnvironment();
    const localDatabase = localEnvironment?.DB as { prepare?: unknown } | undefined;
    const localRightsAuthority = typeof localDatabase?.prepare === "function";
    const primary = async (forwarded: Request): Promise<Response> => {
      if (localRightsAuthority) {
        // A public, cookie-free Worker homepage can use the much smaller
        // read-only bootstrap without dynamically loading account, commerce,
        // ingest, audio and other API modules on the first SSR.
        // Any hint of a login/session or missing trusted country/IP falls
        // straight back to the exact existing full authenticated adapter.
        if (
          !forwarded.headers.has("authorization") &&
          !forwarded.headers.has("cookie") &&
          forwarded.headers.get("cf-connecting-ip") &&
          forwarded.headers.get("x-cove-client-country")
        ) {
          const { canUseLeanAnonymousBootstrap, serveLeanAnonymousBootstrap } =
            await import("./storefront-anonymous-bootstrap.server");
          if (
            canUseLeanAnonymousBootstrap(
              forwarded,
              localEnvironment as Parameters<typeof canUseLeanAnonymousBootstrap>[1],
            )
          )
            return serveLeanAnonymousBootstrap(
              forwarded,
              localEnvironment as Parameters<typeof serveLeanAnonymousBootstrap>[1],
            );
        }
        // Cloudflare SSR and the live rights database share one Worker invocation.
        // Authenticated and fallback paths always retain their full adapter.
        const { handleCoveApi } = await import("./api.server");
        const response = await handleCoveApi(
          forwarded,
          localEnvironment as Parameters<typeof handleCoveApi>[1],
          // Cloudflare can finish bounded request telemetry after the HTML
          // becomes available. Live book rights and D1 reads remain awaited.
          currentCoveRequestExecutionContext(),
        );
        return response ?? new Response(null, { status: 503 });
      }
      const response = await proxyPersistenceApi(forwarded, env);
      if (response) return response;
      // Never use an unverified seed when Vercel-to-D1 is unreachable.
      if (remoteRequired) return new Response(null, { status: 503 });
      return fetch(forwarded);
    };
    const alternate = (forwarded: Request) =>
      fetch(new Request(forwarded, { redirect: "manual", cache: "no-store" }));

    const started = performance.now();
    const phase: {
      primaryFailureMs: number | null;
      alternateMs: number | null;
      alternateSucceeded: boolean;
    } = {
      primaryFailureMs: null,
      alternateMs: null,
      alternateSucceeded: false,
    };
    const backendTimings: string[] = [];
    const deadline = {
      expired: null as {
        countryAsserted: boolean;
        primaryCompleted: boolean;
        alternateStarted: boolean;
        alternateCompleted: boolean;
      } | null,
    };
    const result = await hedgedStorefrontBootstrap(source, primary, alternate, {
      hedgeAfterMs: 1_650,
      timeoutMs: 8_000,
      onDeadline: (state) => {
        deadline.expired = state;
      },
      onVerifiedTimings: (_phase, values) => {
        // Never expose raw backend headers. Only hardcoded numeric D1 phase
        // names from a territory-validated result reach Server-Timing.
        backendTimings.splice(0, backendTimings.length, ...values);
      },
      onPhase: (channel, outcome, durationMs) => {
        // Aggregate timings/status ONLY: no locale, location, cookies, book data or IP.
        if (channel === "primary" && outcome !== "ok") phase.primaryFailureMs = durationMs;
        if (channel === "alternate") {
          phase.alternateMs = durationMs;
          phase.alternateSucceeded = outcome === "ok";
        }
      },
    });
    const timing = [`cove_ssr_bootstrap;dur=${(performance.now() - started).toFixed(1)}`];
    if (localRightsAuthority) timing.push("cove_ssr_local_rights;dur=0");
    if (phase.primaryFailureMs !== null)
      timing.push(`cove_ssr_primary_failure;dur=${phase.primaryFailureMs.toFixed(1)}`);
    if (phase.alternateMs !== null) {
      timing.push(`cove_ssr_split;dur=${phase.alternateMs.toFixed(1)}`);
      if (phase.alternateSucceeded) timing.push("cove_ssr_split_success;dur=0");
    }
    if (deadline.expired) {
      timing.push("cove_ssr_deadline;dur=0");
      if (!deadline.expired.countryAsserted) timing.push("cove_ssr_country_unasserted;dur=0");
      if (!deadline.expired.primaryCompleted) timing.push("cove_ssr_primary_pending;dur=0");
      if (!deadline.expired.alternateStarted) timing.push("cove_ssr_alternate_not_started;dur=0");
      else if (!deadline.expired.alternateCompleted)
        timing.push("cove_ssr_alternate_pending;dur=0");
    }
    if (result !== null) timing.push(...backendTimings);
    if (result === null) timing.push("cove_ssr_empty;dur=0");
    setResponseHeader("Server-Timing", timing.join(", "));
    return result;
  });
