import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { z } from "zod";
import { requestStorefrontBootstrap } from "./storefront-bootstrap-fetch";

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
    return requestStorefrontBootstrap(
      source,
      async (forwarded) => (await proxyPersistenceApi(forwarded, env)) ?? (await fetch(forwarded)),
      {
        onFailure: ({ attempt, kind, status }) => {
          // Failure classifications only: do not log IP, locale, cookies or book data.
          console.warn("storefront_ssr_bootstrap_retry", { attempt, kind, status });
        },
      },
    );
  });
