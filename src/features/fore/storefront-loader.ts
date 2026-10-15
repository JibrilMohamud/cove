import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { z } from "zod";
import type { StorefrontBootstrap } from "./storefront-bootstrap";

export const loadStorefrontBootstrap = createServerFn({ method: "GET" })
  .inputValidator((value: string) => z.string().max(2000).parse(value))
  .handler(async ({ data }): Promise<string | null> => {
    // Filtered/auth URLs retain their normal query behavior. Never substitute a
    // popular first page for a requested search, category or authentication link.
    if (new URLSearchParams(data).size) return null;
    const request = getRequest();
    const url = new URL("/api/fore/storefront/bootstrap", request.url);
    const signal = AbortSignal.timeout(5000);
    const forwarded = new Request(url, { headers: request.headers, signal });
    try {
      const { proxyPersistenceApi } = await import("@/lib/persistence-backend");
      const env = typeof process === "undefined" ? {} : process.env;
      // On Vercel, call the configured backend directly rather than invoking a
      // second frontend function through the public site. Dev uses its local API.
      const response = (await proxyPersistenceApi(forwarded, env)) ?? (await fetch(forwarded));
      if (!response.ok) return null;
      const value: StorefrontBootstrap = await response.json();
      if (
        !value.context?.rightsCountry ||
        !value.context.locale ||
        !Array.isArray(value.catalog?.results) ||
        !Number.isFinite(value.at)
      )
        return null;
      // The backend contract is JSON; transfer that explicit wire representation
      // rather than claiming optional third-party metadata has a narrower type.
      return JSON.stringify(value);
    } catch {
      // A slow/unavailable bootstrap cannot strand the document; the existing
      // client query still exposes its normal retry/error/recovery interface.
      return null;
    }
  });
