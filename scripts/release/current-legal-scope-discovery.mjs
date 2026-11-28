import { hashCurrentBaseline } from "./current-legal-baseline.mjs";

const identity = (value) => typeof value === "string" && value.length > 0;
const country = (value) => typeof value === "string" && /^[A-Z]{2}$/.test(value) && value !== "ZZ";
const channels = new Set(["retail", "subscription", "library"]);

/**
 * Enumerate the entire product population and all recorded grant scopes from
 * a private, consistent local canonical-schema snapshot. Never use only
 * active/allow rows: inactive products, deny/revoked grants and unresolved
 * scopes are part of the review workload. This is discovery, not authority.
 * The owner must separately attest current market scope, holds, current
 * source/artifact and policy digests, epoch and fresh withdrawal evidence.
 */
export function discoverLegalScopes(db) {
  db.exec("BEGIN");
  try {
    const products = db
      .prepare(
        "SELECT id productId,edition_id editionId,format,storefront_status status,source_name sourceName,source_external_id sourceItemId FROM products ORDER BY id",
      )
      .all();
    const grants = db
      .prepare(
        "SELECT g.id grantId,g.edition_id editionId,g.format,g.sales_channel channel,g.territory_code legacyTerritory,g.decision,g.status,g.subscription_permitted subscriptionPermitted,g.library_permitted libraryPermitted,t.territory_code resolvedTerritory FROM rights_grants g LEFT JOIN rights_grant_territories t ON t.grant_id=g.id ORDER BY g.id,t.territory_code",
      )
      .all();
    if (!products.length || products.length > 1000000) throw Error("scope_product_count");
    const byEdition = new Map();
    const ids = new Set();
    for (const product of products) {
      if (
        !identity(product.productId) ||
        !identity(product.editionId) ||
        !identity(product.format) ||
        !identity(product.sourceName) ||
        !identity(product.sourceItemId) ||
        ids.has(product.productId)
      )
        throw Error("scope_product_shape");
      ids.add(product.productId);
      const key = JSON.stringify([product.editionId, product.format.toLowerCase()]);
      if (!byEdition.has(key)) byEdition.set(key, []);
      byEdition.get(key).push(product);
    }
    const scopes = new Map();
    const unresolved = new Set();
    const covered = new Set();
    for (const grant of grants) {
      const key = JSON.stringify([grant.editionId, grant.format.toLowerCase()]);
      const matching = byEdition.get(key) || [];
      if (!matching.length || !channels.has(grant.channel) || !country(grant.resolvedTerritory)) {
        unresolved.add(grant.grantId);
        continue;
      }
      const effective = [grant.channel];
      if (grant.channel === "retail" && grant.subscriptionPermitted === 1)
        effective.push("subscription");
      if (grant.channel === "retail" && grant.libraryPermitted === 1) effective.push("library");
      for (const product of matching) {
        covered.add(product.productId);
        for (const channel of effective) {
          const scope = {
            productId: product.productId,
            territory: grant.resolvedTerritory,
            format: product.format,
            channel,
          };
          const scopeKey = JSON.stringify(Object.values(scope));
          if (!scopes.has(scopeKey)) scopes.set(scopeKey, { ...scope, grantIds: [] });
          scopes.get(scopeKey).grantIds.push(grant.grantId);
        }
      }
    }
    const manifest = {
      schema: "cove.legal-scope-discovery.v1",
      products,
      scopes: [...scopes.entries()]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([, row]) => row),
      unresolvedGrantIds: [...unresolved].sort(),
      productsWithoutRecordedScopes: products
        .filter((p) => !covered.has(p.productId))
        .map((p) => p.productId),
    };
    db.exec("COMMIT");
    return {
      manifest,
      manifestSha256: hashCurrentBaseline(manifest),
      authorizing: false,
      completeOwnerInventory: false,
    };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
