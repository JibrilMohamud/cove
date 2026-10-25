/* eslint-disable prettier/prettier -- Keep private catalog-authority boundary checks locally auditable. */
import { authorizeStorefrontPresentationIds, type CatalogDB } from "../features/fore/catalog-model.server";

// This is a private QA bridge: index results are only anonymous candidates.
// Primary D1 independently enforces the freshest retail rights, source
// suppression, market currency, release status, and active offer eligibility.
export type CatalogIndexVerifyEnv = {
  PRIMARY_DB: CatalogDB;
  CATALOG_QUERY: { fetch(request: Request): Promise<Response> };
  COVE_CATALOG_INDEX_VERIFY_ENABLED?: string;
};
export async function verifyIsolatedCatalogCandidates(
  env: CatalogIndexVerifyEnv,
  query: string,
  territory: string,
  currency = "USD",
) {
  if (env.COVE_CATALOG_INDEX_VERIFY_ENABLED !== "1")
    throw Error("catalog_index_verification_disabled");
  if (!/^[A-Z]{2}$/.test(territory) || !/^[A-Z]{3}$/.test(currency))
    throw Error("invalid_catalog_market");
  const response = await env.CATALOG_QUERY.fetch(
    new Request("https://catalog-index.internal/query", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query, page: 1, limit: 64 }),
    }),
  );
  if (!response.ok) throw Error("catalog_index_search_failed");
  const snapshot = (await response.json()) as {
    schema?: string;
    authoritative?: boolean;
    ids?: unknown;
  };
  if (snapshot.schema !== "cove.catalog.candidates.v1" ||
      snapshot.authoritative !== false || !Array.isArray(snapshot.ids) ||
      snapshot.ids.length > 64 ||
      snapshot.ids.some((id: unknown) => typeof id !== "string" ||
        !/^prd_gutenberg_[a-z0-9_]{1,120}$/.test(id)) ||
      new Set(snapshot.ids).size !== snapshot.ids.length)
    throw Error("catalog_index_untrusted_snapshot");
  // Never authorize an indexed book by absence of a tombstone or by
  // trusting an asynchronously replicated territory/price field.
  const live = await authorizeStorefrontPresentationIds(
    env.PRIMARY_DB, snapshot.ids as string[], territory, currency
  );
  return {
    source: "isolated-index-live-primary",
    productIds: live.map((r) => r.product_id),
    authoritative: true,
    // No total count or derived legal grant leaks into the result.
  };
}
