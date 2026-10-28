import "./lib/error-capture";

import { consumeLastCapturedError } from "./lib/error-capture";
import {
  withCoveRequestEnvironment,
  type CoveRequestExecution,
} from "./lib/cove-request-env.server";
import { isolateWorkerCountry } from "./lib/cloudflare-country.server";
import { resolveNativeWorkerBindings } from "./lib/cloudflare-native-bindings.server";
import {
  isStagingStaticAsset,
  rejectUnauthenticatedStagingRequest,
  stageNoStore,
} from "./lib/cloudflare-ssr-stage-gate.server";
import { renderErrorPage } from "./lib/error-page";
import { scopeStageLegalWriterEnv } from "./storefront-strangler/legal-primary-write-lock";
import { scopePublicationOwnerEnv } from "./storefront-strangler/publication-owner-routing.server";
import { cachePublicDocument } from "./lib/public-document-cache";
import { applySecurityHeaders, securityTxt } from "./lib/security-headers";
import { handleVercelIngestionControl, proxyPersistenceApi } from "./lib/persistence-backend";

type ServerEntry = {
  fetch: (request: Request, env: unknown, ctx: unknown) => Promise<Response> | Response;
};

let serverEntryPromise: Promise<ServerEntry> | undefined;

async function getServerEntry(): Promise<ServerEntry> {
  if (!serverEntryPromise) {
    serverEntryPromise = import("@tanstack/react-start/server-entry").then(
      (m) => (m.default ?? m) as ServerEntry,
    );
  }
  return serverEntryPromise;
}

// h3 swallows in-handler throws into a normal 500 Response with body
// {"unhandled":true,"message":"HTTPError"} — try/catch alone never fires for those.
async function normalizeCatastrophicSsrResponse(response: Response): Promise<Response> {
  if (response.status < 500) return response;
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) return response;

  const body = await response.clone().text();
  if (!isH3SwallowedErrorBody(body)) return response;

  console.error(consumeLastCapturedError() ?? new Error(`h3 swallowed SSR error: ${body}`));
  return new Response(renderErrorPage(), {
    status: 500,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

function isH3SwallowedErrorBody(body: string): boolean {
  try {
    const payload = JSON.parse(body) as { unhandled?: unknown; message?: unknown };
    return payload.unhandled === true && payload.message === "HTTPError";
  } catch {
    return false;
  }
}

export default {
  async fetch(request: Request, env: unknown, ctx: unknown) {
    const requestStarted = performance.now();
    try {
      const suppliedEnv =
        env && typeof env === "object" ? env : typeof process !== "undefined" ? process.env : {};
      const nativeEnv = await resolveNativeWorkerBindings(request, suppliedEnv);
      // Opt-in D1 legal mutation denial is deliberately staging-only.
      // A production attempt to turn this on without verified owner-first
      // writers fails closed rather than silently changing legal authority.
      // When disabled this branch has no effect on the production D1 binding.
      const runtimeEnv = scopePublicationOwnerEnv(
        (nativeEnv.COVE_CANONICAL_LEGAL_WRITE_LOCK === "1"
          ? scopeStageLegalWriterEnv(nativeEnv as any)
          : nativeEnv) as Parameters<typeof scopePublicationOwnerEnv>[0],
      );
      const foreEnv = runtimeEnv as {
        DB?: any;
        BUCKET?: any;
        ASSETS?: { fetch: (request: Request) => Promise<Response> };
        COVE_SSR_STAGING?: string;
        COVE_SSR_STAGING_GATE_KEY?: string;
        COVE_FAST_STOREFRONT_MODE?: string;
        COVE_FAST_STOREFRONT_RELEASE_CERTIFIED?: string;
        COVE_FAST_STOREFRONT_ORIGIN?: string;
        COVE_FAST_STOREFRONT_PERCENT?: string;
        COVE_FAST_RELAY_KEY?: string;
        VERCEL_ENV?: string;
        FORE_PUBLIC_URL?: string;
        FORE_ENVIRONMENT?: string;
        FORE_CSP_REPORT_URI?: string;
        FORE_SECURITY_CONTACT_EMAIL?: string;
        FORE_SECURITY_POLICY_URL?: string;
        FORE_BACKEND_URL?: string;
        FORE_BACKEND_TOKEN?: string;
        COVE_AUDIO_PIPELINE_URL?: string;
        CRON_SECRET?: string;
        FORE_INGESTION_TRIGGER_TOKEN?: string;
        FORE_INGESTION_VERIFY_JWK?: string;
      };
      // A real Cloudflare execution context keeps async observability alive
      // after the response. Never synthesize waitUntil on Vercel or without D1.
      const workerContext = ctx as { waitUntil?: (work: Promise<unknown>) => void } | null;
      const execution: CoveRequestExecution | undefined =
        foreEnv.DB &&
        typeof foreEnv.DB.prepare === "function" &&
        typeof workerContext?.waitUntil === "function"
          ? { waitUntil: (work) => workerContext.waitUntil!(work) }
          : undefined;
      const staging = foreEnv.COVE_SSR_STAGING === "1";
      // Only branch-scoped preview diagnostics may reveal a coarse fallback
      // category. Never attach these headers in production or on API paths.
      let qaFastFallbackReason: string | null = null;
      const rejected = await rejectUnauthenticatedStagingRequest(request, foreEnv);
      if (rejected) return rejected;
      // All static assets use Worker-first routing in staging so a missing
      // credential cannot bypass this gate via the assets service.
      if (staging && isStagingStaticAsset(new URL(request.url).pathname)) {
        const asset = foreEnv.ASSETS
          ? await foreEnv.ASSETS.fetch(request)
          : new Response(null, { status: 503 });
        return stageNoStore(applySecurityHeaders(request, asset, foreEnv), true);
      }
      // Production Cloudflare pilot requests have direct D1 bindings and must
      // never use HTTP-forgeable country headers to select licensed books.
      // Vercel's existing authenticated gateway remains unchanged.
      if (foreEnv.DB && typeof foreEnv.DB.prepare === "function") {
        const safe = isolateWorkerCountry(request);
        if (!safe)
          return stageNoStore(
            applySecurityHeaders(
              request,
              new Response("Unable to verify storefront territory.", {
                status: 503,
                headers: { "cache-control": "no-store", "content-type": "text/plain" },
              }),
              foreEnv,
            ),
            staging,
          );
        request = safe;
      }
      if (staging) {
        // Authenticated stage transport must never forward its ephemeral
        // bearer token into any application/session/backend handler.
        const headers = new Headers(request.headers);
        headers.delete("authorization");
        request = new Request(request, { headers });
      }
      // Only the anonymous homepage may use the optional verified-Country
      // Cloudflare renderer. Account/session, checkout, API, reader, and
      // media traffic always retain the established Vercel/CORE route.
      // Default OFF; a separately reviewed release certificate is required.
      if (
        !staging &&
        request.method === "GET" &&
        new URL(request.url).pathname === "/" &&
        foreEnv.COVE_FAST_STOREFRONT_RELEASE_CERTIFIED === "1"
      ) {
        const { maybeProxyFastHomepage } = await import("./lib/fast-storefront-proxy.server");
        const fast = await maybeProxyFastHomepage(request, foreEnv, (reason) => {
          qaFastFallbackReason = reason;
        });
        if (fast) return applySecurityHeaders(request, fast, foreEnv);
      }
      const ingestionControl = await handleVercelIngestionControl(request, foreEnv);
      if (ingestionControl)
        return stageNoStore(applySecurityHeaders(request, ingestionControl, foreEnv), staging);
      const persistenceResponse = await proxyPersistenceApi(request, foreEnv);
      if (persistenceResponse)
        return stageNoStore(applySecurityHeaders(request, persistenceResponse, foreEnv), staging);
      // A configured persistence gateway handles APIs without loading the entire
      // catalog, publishing, commerce and audio backend into the Vercel process.
      const apiResponse = new URL(request.url).pathname.startsWith("/api/fore/")
        ? await (
            await import("./features/fore/api.server")
          ).handleCoveApi(request, foreEnv as any, execution)
        : null;
      if (apiResponse) {
        return stageNoStore(applySecurityHeaders(request, apiResponse, foreEnv), staging);
      }
      const securityDocument = securityTxt(request, foreEnv);
      if (securityDocument)
        return stageNoStore(applySecurityHeaders(request, securityDocument, foreEnv), staging);
      if (foreEnv.DB) {
        const { handleSeoDocumentRequest } = await import("./features/fore/seo.server");
        const seo = await handleSeoDocumentRequest(request, foreEnv.DB, foreEnv.FORE_PUBLIC_URL);
        if (seo) return stageNoStore(applySecurityHeaders(request, seo, foreEnv), staging);
      }
      const publicOrigin = foreEnv.FORE_PUBLIC_URL
        ? new URL(foreEnv.FORE_PUBLIC_URL).origin
        : new URL(request.url).origin;
      const forwardedHeaders = new Headers(request.headers);
      forwardedHeaders.set("x-fore-public-origin", publicOrigin);
      // The dev server's lazy NodeRequest is Request-compatible but has no
      // Undici internal state. Forward public fields instead of cloning its brand.
      const routedInit: RequestInit & { duplex?: "half" } = {
        method: request.method,
        headers: forwardedHeaders,
        signal: request.signal,
        redirect: request.redirect,
      };
      if (request.method !== "GET" && request.method !== "HEAD" && request.body) {
        routedInit.body = request.body;
        routedInit.duplex = "half";
      }
      const routedRequest = new Request(request.url, routedInit);
      const entryStarted = performance.now();
      const handler = await getServerEntry();
      const entryDurationMs = performance.now() - entryStarted;
      const renderStarted = performance.now();
      const response = await withCoveRequestEnvironment(
        runtimeEnv,
        () => handler.fetch(routedRequest, runtimeEnv, ctx),
        execution,
      );
      const renderDurationMs = performance.now() - renderStarted;
      const secured = applySecurityHeaders(
        request,
        cachePublicDocument(request, await normalizeCatastrophicSsrResponse(response)),
        foreEnv,
      );
      // Server Timing exposes aggregate durations only, never cookies, paths,
      // visitor data, catalog contents or backend credentials. These timings
      // distinguish Vercel cold module loading from backend/SSR render work.
      // In particular, Vercel runtime logs may be unavailable to the audit.
      if (
        request.method === "GET" &&
        new URL(request.url).pathname === "/" &&
        secured.status === 200 &&
        secured.headers.get("content-type")?.includes("text/html")
      ) {
        const headers = new Headers(secured.headers);
        if (foreEnv.VERCEL_ENV === "preview" && qaFastFallbackReason)
          headers.set("x-cove-qa-fast-fallback", qaFastFallbackReason);
        headers.append(
          "Server-Timing",
          [
            `cove_entry;dur=${entryDurationMs.toFixed(1)}`,
            `cove_render;dur=${renderDurationMs.toFixed(1)}`,
            `cove_total;dur=${(performance.now() - requestStarted).toFixed(1)}`,
          ].join(", "),
        );
        return stageNoStore(
          new Response(secured.body, {
            status: secured.status,
            statusText: secured.statusText,
            headers,
          }),
          staging,
        );
      }
      return stageNoStore(secured, staging);
    } catch (error) {
      console.error(error);
      return stageNoStore(
        applySecurityHeaders(
          request,
          new Response(renderErrorPage(), {
            status: 500,
            headers: { "content-type": "text/html; charset=utf-8" },
          }),
          (env && typeof env === "object"
            ? env
            : typeof process !== "undefined"
              ? process.env
              : {}) as any,
        ),
        !!(
          env &&
          typeof env === "object" &&
          (env as { COVE_SSR_STAGING?: string }).COVE_SSR_STAGING === "1"
        ),
      );
    }
  },
};
