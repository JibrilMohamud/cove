import { createServerFn } from "@tanstack/react-start";
import { getRequest, setResponseHeader } from "@tanstack/react-start/server";
import { z } from "zod";
import { hedgedStorefrontBootstrap } from "./storefront-hedged-fetch";

export const loadStorefrontBootstrap = createServerFn({ method: "GET" })
  .inputValidator((value: string) => z.string().max(2000).parse(value))
  .handler(async ({ data }): Promise<string | null> => {
    if (new URLSearchParams(data).size) return null;
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
    const primary = async (forwarded: Request): Promise<Response> => {
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
    const result = await hedgedStorefrontBootstrap(source, primary, alternate, {
      hedgeAfterMs: 1_650,
      timeoutMs: 8_000,
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
    if (phase.primaryFailureMs !== null)
      timing.push(`cove_ssr_primary_failure;dur=${phase.primaryFailureMs.toFixed(1)}`);
    if (phase.alternateMs !== null) {
      timing.push(`cove_ssr_split;dur=${phase.alternateMs.toFixed(1)}`);
      if (phase.alternateSucceeded) timing.push("cove_ssr_split_success;dur=0");
    }
    if (result === null) timing.push("cove_ssr_empty;dur=0");
    setResponseHeader("Server-Timing", timing.join(", "));
    return result;
  });
