import type { CatalogResponse, StorefrontPage, TaxonomyResponse } from "./Store";
import type { StorefrontContext, storefrontMarkets } from "./localization.server";

export type StorefrontBootstrap = {
  context: StorefrontContext & { availableMarkets: Awaited<ReturnType<typeof storefrontMarkets>> };
  page: Omit<StorefrontPage, "query"> & {
    query: Record<string, string | number | boolean | null | string[]>;
  };
  taxonomy: TaxonomyResponse;
  catalog: CatalogResponse;
  catalogQuery: string;
  at: number;
};
