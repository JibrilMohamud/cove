/**
 * Disposable browser-QA-only positive owner stub. Never imported by any
 * deployed entrypoint, never trusted as a production rights verifier.
 * The private owner is still mandatory on every real API request.
 */
import { randomUUID } from "node:crypto";

export function createSyntheticFreeLibraryOwner(db, users, secret) {
  if (!/^[a-f0-9]{64}$/.test(secret)) throw Error("Invalid synthetic QA secret");
  return {
    async fetch(request) {
      if (new URL(request.url).pathname !== "/catalog/private-grant-free-library")
        return new Response(null, { status: 404 });
      if (request.method !== "POST" || request.headers.get("authorization") !== "Bearer " + secret)
        return new Response(null, { status: 401 });
      const input = await request.json();
      if (
        !input ||
        Object.keys(input).sort().join(",") !== "productId,territory,userId" ||
        !users.has(input.userId) ||
        input.territory !== "US" ||
        !/^prd_gutenberg_[0-9]{1,10}$/.test(input.productId)
      )
        return new Response(null, { status: 409 });
      const sourceId = input.productId.slice("prd_gutenberg_".length);
      // The fixture must contain the historical approved US source proof,
      // not just user-supplied or externally fetched catalog metadata.
      const source = await db
        .prepare(
          `SELECT p.id FROM products p JOIN gutenberg_source_cache c ON c.id=?
          WHERE p.id=? AND p.source_name='gutenberg'
          AND c.source_item_id=p.source_external_id
          AND c.source_id='pg_us' AND c.copyright=0
          AND c.rights_status='public-domain'
          AND c.commercial_use_status='approved'
          AND c.ingest_status='active'
          AND c.rights_evidence_id IS NOT NULL
          AND EXISTS(
            SELECT 1 FROM gutenberg_rights_evidence e
            WHERE e.id=c.rights_evidence_id AND e.cache_id=c.id
              AND e.status='approved' AND e.determination='public-domain'
              AND e.territory_code='US'
          )
          AND EXISTS(SELECT 1 FROM json_each(c.rights_territories_json) t WHERE t.value='US')`,
        )
        .bind(sourceId, input.productId)
        .first();
      if (!source) return new Response(null, { status: 409 });
      const denied = await db
        .prepare(
          "SELECT 1 AS denied FROM entitlements WHERE user_id=? AND product_id=? AND entitlement_type='public-domain' AND status='revoked' LIMIT 1",
        )
        .bind(input.userId, input.productId)
        .first();
      if (denied) return new Response(null, { status: 409 });
      const at = new Date().toISOString();
      await db
        .prepare(
          "INSERT INTO entitlements(id,user_id,product_id,entitlement_type,status,source,granted_at,updated_at) VALUES(?,?,?,'public-domain','active','browser-qa-only',?,?) ON CONFLICT(user_id,product_id,entitlement_type) WHERE status='active' DO NOTHING",
        )
        .bind(randomUUID(), input.userId, input.productId, at, at)
        .run();
      const saved = await db
        .prepare(
          "SELECT 1 AS ok FROM entitlements WHERE user_id=? AND product_id=? AND entitlement_type='public-domain' AND status='active' LIMIT 1",
        )
        .bind(input.userId, input.productId)
        .first();
      if (!saved) return new Response(null, { status: 409 });
      return Response.json({
        schema: "cove.owner-free-library-entitlement.v1",
        ownerFirst: true,
        saved: true,
        userId: input.userId,
        productId: input.productId,
      });
    },
  };
}
