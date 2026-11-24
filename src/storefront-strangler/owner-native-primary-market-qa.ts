import {
  authorizeStorefrontPresentationIds,
  type CatalogDB,
  type FirstPaintD1QueryMetrics,
} from "../features/fore/catalog-model.server";

type Statement = ReturnType<CatalogDB["prepare"]>;

/**
 * Private synthetic QA only. Reuse the source-controlled canonical catalog
 * SELECT verbatim inside one statement with an independent exact-market
 * receipt. A sentinel exists even for an empty shelf: absence of products
 * is not evidence that a market is launched. No cached market or SQL RPC.
 */
export async function readNativePrimaryMarketQa(
  primary: CatalogDB,
  ids: string[],
  territory: string,
  currency: string,
  measurements: FirstPaintD1QueryMetrics,
) {
  const native = primary as CatalogDB & {
    withSession?: (constraint: "first-primary") => CatalogDB;
  };
  if (typeof native.withSession !== "function")
    throw Error("qa_native_primary_session_unavailable");
  const session = native.withSession("first-primary");
  let activeMarket = false;
  let reads = 0;
  const deny = async (): Promise<never> => {
    throw Error("qa_native_market_read_only");
  };
  // Adapt exactly the canonical function's prepare/bind/all protocol. The
  // SQL string comes only from its static source, never from a request.
  const adapter: CatalogDB = {
    prepare(sql) {
      if (
        !sql.startsWith("WITH market(currency) AS MATERIALIZED (") ||
        !sql.endsWith("FROM authorized a ORDER BY a.position")
      )
        throw Error("qa_native_catalog_sql_drift");
      const statement = session.prepare(`WITH cove_native_catalog AS MATERIALIZED (
        ${sql}
      ), cove_native_market AS MATERIALIZED (
        SELECT EXISTS(SELECT 1 FROM storefront_markets
          WHERE country_code=? AND market_status='active' AND default_currency=?) active_market
      )
      SELECT product_id,product_public_id,edition_id,edition_public_id,offer_json,
        NULL AS cove_market_receipt FROM cove_native_catalog
      UNION ALL SELECT NULL,NULL,NULL,NULL,NULL,active_market FROM cove_native_market`);
      return {
        bind(...args: unknown[]): Statement {
          if (reads !== 0 || args.length !== 5) throw Error("qa_native_catalog_bind_drift");
          const bound = statement.bind(...args, territory, currency);
          return {
            bind: () => {
              throw Error("qa_native_catalog_rebind_denied");
            },
            first: deny,
            run: deny,
            async all<T>() {
              if (++reads !== 1) throw Error("qa_native_catalog_replay_denied");
              const result = await bound.all<Record<string, unknown>>();
              const receipts = result.results.filter((row) => row.cove_market_receipt !== null);
              if (
                receipts.length !== 1 ||
                receipts[0].product_id !== null ||
                ![0, 1].includes(Number(receipts[0].cove_market_receipt)) ||
                typeof receipts[0].cove_market_receipt !== "number"
              )
                throw Error("qa_native_market_receipt_invalid");
              activeMarket = receipts[0].cove_market_receipt === 1;
              const rows = result.results
                .filter((row) => row.cove_market_receipt === null)
                .map(({ cove_market_receipt: _receipt, ...row }) => row);
              return { ...result, results: rows as T[] };
            },
          };
        },
        first: deny,
        all: deny,
        run: deny,
      };
    },
    batch: deny,
  };
  const rows = await authorizeStorefrontPresentationIds(
    adapter,
    ids,
    territory,
    currency,
    measurements,
  );
  if (reads !== 1) throw Error("qa_native_market_receipt_missing");
  return { rows, servedByPrimary: measurements.servedByPrimary === true, activeMarket };
}
