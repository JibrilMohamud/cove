import { createServerFn } from "@tanstack/react-start";
import { getRequest, setResponseHeader } from "@tanstack/react-start/server";
import { z } from "zod";
import { requestStorefrontBootstrap } from "./storefront-bootstrap-fetch";
import { recoverStorefrontBootstrap } from "./storefront-bootstrap-recovery";

export const loadStorefrontBootstrap = createServerFn({ method: "GET" })
  .inputValidator((value: string) => z.string().max(2000).parse(value))
  .handler(async ({ data }): Promise<string | null> => {
    // Filters and searches always resolve against their live rights-scoped APIs.
    if (new URLSearchParams(data).size) return null;
    const request = getRequest();
    const url = new URL("/api/fore/storefront/bootstrap", request.url);
    const source = new Request(url, { headers: request.headers, signal: request.signal });
    const { proxyPersistenceApi } = await import("@/lib/persistence-backend");
    const env: Record<string, string | undefined> =
      typeof process === "undefined" ? {} : process.env;
    const remoteRequired =
      Boolean(env.FORE_BACKEND_URL && env.FORE_BACKEND_TOKEN) || env.VERCEL_ENV === "production";
    const fetchApi = async (forwarded: Request): Promise<Response> => {
      const response = await proxyPersistenceApi(forwarded, env);
      if (response) return response;
      // On production backend errors, never let split-endpoint recovery read
      // Vercel's public-domain seed instead of the live D1 rights authority.
      if (remoteRequired) return new Response(null, { status: 503 });
      return fetch(forwarded);
    };
    const started = performance.now();
    const phase: {
      splitMs: number | null;
      splitSucceeded: boolean;
      firstFailureMs: number | null;
    } = {
      splitMs: null,
      splitSucceeded: false,
      firstFailureMs: null,
    };
    const result = await requestStorefrontBootstrap(source, fetchApi, {
      firstAttemptMs: 3_500,
      timeoutMs: 10_000,
      recover: (request, api) =>
        recoverStorefrontBootstrap(
          request,
          remoteRequired
            ? (forwarded) => fetch(new Request(forwarded, { redirect: "manual", cache: "no-store" }))
            : api,
          remoteRequired,
          remoteRequired,
        ),
      onRecovery: ({ success, durationMs }) => {
        phase.splitMs = durationMs;
        phase.splitSucceeded = success;
        console.info("storefront_ssr_split_recovery", {
          success,
          durationMs: Math.round(durationMs),
        });
      },
      onFailure: ({ attempt, kind, status }) => {
        // Failure classifications only: do not log IP, locale, cookies or book data.
        if (attempt === 1 && phase.firstFailureMs === null) {
          phase.firstFailureMs = performance.now() - started;
        }
        console.warn("storefront_ssr_bootstrap_retry", { attempt, kind, status });
      },
    });
    // These duration-only metrics survive when Vercel runtime logs are unavailable.
    // No location, IP, book, identity, cookie or authorizable data is included.
    const timing = [`cove_ssr_bootstrap;dur=${(performance.now() - started).toFixed(1)}`];
    if (phase.firstFailureMs !== null)
      timing.push(`cove_ssr_primary_failure;dur=${phase.firstFailureMs.toFixed(1)}`);
    if (phase.splitMs !== null) {
      timing.push(`cove_ssr_split;dur=${phase.splitMs.toFixed(1)}`);
      if (phase.splitSucceeded) timing.push("cove_ssr_split_success;dur=0");
    }
    if (result === null) timing.push("cove_ssr_empty;dur=0");
    setResponseHeader("Server-Timing", timing.join(", "));
    return result;
  });
