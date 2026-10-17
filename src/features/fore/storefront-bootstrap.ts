import type { CatalogResponse, StorefrontPage, TaxonomyResponse } from "./Store";
import type { StorefrontContext, storefrontMarkets } from "./localization.server";

export type StorefrontBootstrap = {
  context: StorefrontContext & { availableMarkets: Awaited<ReturnType<typeof storefrontMarkets>> };
  page: Omit<StorefrontPage, "query"> & {
    query: Record<string, string | number | boolean | null | string[]>;
  };
  // Taxonomy counts load separately after the first book shelf has rendered.
  // Older bootstrap payloads may still include taxonomy during a rolling deploy.
  taxonomy?: TaxonomyResponse;
  catalog: CatalogResponse;
  catalogQuery: string;
  at: number;
};
