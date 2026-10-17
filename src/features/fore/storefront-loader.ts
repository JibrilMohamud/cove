import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
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
    const env = typeof process === "undefined" ? {} : process.env;
    const remoteConfigured = Boolean(env.FORE_BACKEND_URL && env.FORE_BACKEND_TOKEN);
    const fetchApi = async (forwarded: Request): Promise<Response> => {
      const response = await proxyPersistenceApi(forwarded, env);
      if (response) return response;
      // On production backend errors, never let split-endpoint recovery read
      // Vercel's public-domain seed instead of the live D1 rights authority.
      if (remoteConfigured) return new Response(null, { status: 503 });
      return fetch(forwarded);
    };
    return requestStorefrontBootstrap(source, fetchApi, {
        firstAttemptMs: 3_500,
        timeoutMs: 10_000,
        recover: (request, api) => recoverStorefrontBootstrap(request, api, remoteConfigured),
        onFailure: ({ attempt, kind, status }) => {
          // Failure classifications only: do not log IP, locale, cookies or book data.
          console.warn("storefront_ssr_bootstrap_retry", { attempt, kind, status });
        },
    });
  });
