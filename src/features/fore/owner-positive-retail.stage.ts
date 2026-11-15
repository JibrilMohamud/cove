import { resolveProductRights } from "./rights.server";
import type { CatalogDB, } from "./catalog-model.server";

/**
 * NOT PRODUCTION: isolated owner-positive materializer adapter.
 *
 * The positive decision is evaluated by Cove's actual resolveProductRights
 * implementation, not by a simplified 'allow' grant, and then written only
 * if all owner, market, product and territory versions are unchanged inside
 * ONE primary-D1 INSERT...SELECT. This module is not imported by the live
 * service and the target tables do not exist in production.
 *
 * This does not establish production exclusivity, complete legal parity,
 * settlement/entitlement or safe global catalog latency. No caller should
 * enable it outside an isolated synthetic Worker and synthetic-only DB.
 */
const EXPECTED_STAGE_DB = "e4cbb0ef-6288-4fa1-9dbb-fb42fe01d4f3";
const MAX_LEASE_MS = 30_000;

type DBWithMetadata = CatalogDB;
type OwnerStageEnv = {
  DB: DBWithMetadata;
  COVE_STAGE_OWNER_CAS_ONLY?: string;
  COVE_STAGE_OWNER_DB_ID?: string;
};
type Observed = {
  source_revision: number;
  territory_revision: number;
  market_revision: number;
  owner_epoch: number;
  us_fallback_revision: number;
};
type Offer = { id: string; amount_minor: number; currency: string };
type Boundary = { next_transition: string | null; invalid_times: number };

const OBSERVE = `SELECT src.revision source_revision,t.revision territory_revision,
 COALESCE(m.revision,0) market_revision,owner.epoch owner_epoch,
 owner.us_fallback_revision
 FROM cove_stage_owner_product_source_version src
 JOIN cove_stage_owner_territory_version t ON t.territory_code=?
 LEFT JOIN cove_stage_owner_market_version m ON m.territory_code=t.territory_code
 CROSS JOIN cove_stage_owner_authority_state owner
 WHERE src.product_id=? AND owner.id=1 AND owner.enabled=1`;

const ACTIVE_OFFER = `SELECT id,amount_minor,currency FROM offers
 WHERE product_id=? AND currency=? AND sales_channel='retail' AND active=1
 AND (starts_at IS NULL OR datetime(starts_at)<=datetime(?))
 AND (ends_at IS NULL OR datetime(ends_at)>datetime(?))
 ORDER BY created_at DESC LIMIT 1`;

// Includes future allow AND deny grants, contract/contract-version transitions,
// language restrictions, competitive offers and publication status dates.
// The SQL is fail-closed when a date cannot be normalized. Audit any newly
// introduced policy timing field before the materializer could be certified.
const NEXT_BOUNDARY = `WITH target AS MATERIALIZED (
 SELECT p.edition_id FROM products p WHERE p.id=?
), times AS (
 SELECT rg.starts_at at FROM rights_grants rg JOIN target t ON t.edition_id=rg.edition_id
 UNION ALL SELECT rg.ends_at FROM rights_grants rg JOIN target t ON t.edition_id=rg.edition_id
 UNION ALL SELECT rc.effective_from FROM rights_contracts rc JOIN rights_grants rg ON rg.contract_id=rc.id JOIN target t ON t.edition_id=rg.edition_id
 UNION ALL SELECT rc.effective_to FROM rights_contracts rc JOIN rights_grants rg ON rg.contract_id=rc.id JOIN target t ON t.edition_id=rg.edition_id
 UNION ALL SELECT rv.effective_from FROM rights_contract_versions rv JOIN rights_grants rg ON rg.contract_id=rv.contract_id JOIN target t ON t.edition_id=rg.edition_id
 UNION ALL SELECT rv.effective_to FROM rights_contract_versions rv JOIN rights_grants rg ON rg.contract_id=rv.contract_id JOIN target t ON t.edition_id=rg.edition_id
 UNION ALL SELECT cl.starts_at FROM rights_contract_languages cl JOIN rights_grants rg ON rg.contract_id=cl.contract_id JOIN target t ON t.edition_id=rg.edition_id
 UNION ALL SELECT cl.ends_at FROM rights_contract_languages cl JOIN rights_grants rg ON rg.contract_id=cl.contract_id JOIN target t ON t.edition_id=rg.edition_id
 UNION ALL SELECT o.starts_at FROM offers o WHERE o.product_id=?
 UNION ALL SELECT o.ends_at FROM offers o WHERE o.product_id=?
 UNION ALL SELECT e.release_date FROM editions e JOIN target t ON t.edition_id=e.id
 UNION ALL SELECT e.preorder_date FROM editions e JOIN target t ON t.edition_id=e.id
) SELECT
 (SELECT MIN(datetime(at)) FROM times WHERE at IS NOT NULL AND datetime(at)>datetime(?)) next_transition,
 (SELECT COUNT(*) FROM times WHERE at IS NOT NULL AND datetime(at) IS NULL) invalid_times`;

const CONDITIONAL_INSERT = `INSERT OR REPLACE INTO cove_stage_owner_retail_authority(
 product_id,territory_code,currency,amount_minor,current_offer_id,
 owner_epoch,source_revision,territory_revision,market_revision,
 us_fallback_revision,evidence_digest,valid_until
) SELECT p.id,?,?,o.amount_minor,o.id,owner.epoch,src.revision,t.revision,
 COALESCE(m.revision,0),owner.us_fallback_revision,?,?
 FROM products p
 JOIN editions e ON e.id=p.edition_id
 JOIN offers o ON o.product_id=p.id AND o.id=?
 JOIN cove_stage_owner_product_source_version src ON src.product_id=p.id
 JOIN cove_stage_owner_territory_version t ON t.territory_code=?
 LEFT JOIN cove_stage_owner_market_version m ON m.territory_code=t.territory_code
 CROSS JOIN cove_stage_owner_authority_state owner
 JOIN territories territory ON territory.code=t.territory_code
 WHERE p.id=? AND owner.id=1 AND owner.enabled=1
 AND p.storefront_status='active' AND e.release_status='available'
 AND territory.is_sellable=1
 AND owner.epoch=? AND owner.us_fallback_revision=?
 AND src.revision=? AND t.revision=? AND COALESCE(m.revision,0)=?
 AND o.amount_minor=? AND o.currency=? AND o.sales_channel='retail' AND o.active=1
 AND (o.starts_at IS NULL OR datetime(o.starts_at)<=datetime(?))
 AND (o.ends_at IS NULL OR datetime(o.ends_at)>datetime(?))
 AND (o.ends_at IS NULL OR datetime(o.ends_at)>=datetime(?))
 AND datetime(?)>datetime('now')
 AND EXISTS (SELECT 1 FROM retail_product_availability_rows rights
   WHERE rights.product_id=p.id AND rights.territory_code=?)
 AND NOT EXISTS (SELECT 1 FROM offers future_offer
   WHERE future_offer.product_id=p.id AND future_offer.currency=o.currency
   AND future_offer.sales_channel='retail' AND future_offer.active=1
   AND future_offer.id<>o.id AND datetime(future_offer.starts_at)>datetime(?)
   AND datetime(future_offer.starts_at)<datetime(?))`;

function sqlTime(date: Date): string {
  if (!Number.isFinite(date.getTime())) throw new Error("Invalid stage authority time");
  return date.toISOString().slice(0, 19).replace("T", " ");
}

async function denyStagePositive(
  db: CatalogDB,
  productId: string,
  territory: string,
  currency: string,
): Promise<void> {
  await db
    .prepare(
      "DELETE FROM cove_stage_owner_retail_authority WHERE product_id=? AND territory_code=? AND currency=?",
    )
    .bind(productId, territory, currency)
    .run();
}

export async function stageRecomputeOwnerPositiveRetail(
  env: OwnerStageEnv,
  productId: string,
  territory: string,
  currency = "USD",
  now = new Date(),
): Promise<{ published: boolean; reason: string }> {
  if (
    env.COVE_STAGE_OWNER_CAS_ONLY !== "1" ||
    env.COVE_STAGE_OWNER_DB_ID !== EXPECTED_STAGE_DB
  )
    throw new Error("Stage-only canonical owner DB binding is not certified");
  if (
    !/^[A-Za-z0-9_-]{2,160}$/.test(productId) ||
    !/^[A-Z]{2}$/.test(territory) ||
    !/^[A-Z]{3}$/.test(currency)
  )
    throw new Error("Invalid owner projection identity");

  const observed = await env.DB.prepare(OBSERVE).bind(territory, productId).first<Observed>();
  if (
    !observed ||
    !Number.isSafeInteger(observed.source_revision) ||
    !Number.isSafeInteger(observed.owner_epoch)
  )
    return { published: false, reason: "owner-or-source-unavailable" };

  // This call deliberately resolves the full current contract/version,
  // language, DRM and deny-first policy through Cove's existing decision
  // engine. It must never be replaced with a bare positive grants lookup.
  const canonical = await resolveProductRights(env.DB, productId, territory, {
    salesChannel: "retail",
    at: now.toISOString(),
    persist: false,
  });
  if (
    !canonical.allowed ||
    canonical.salesChannel !== "retail" ||
    canonical.territory !== territory ||
    canonical.productId !== productId ||
    !canonical.grantId
  ) {
    await denyStagePositive(env.DB, productId, territory, currency);
    return { published: false, reason: "canonical-rights-denied" };
  }
  const evaluatedAt = sqlTime(now);
  const offer = await env.DB
    .prepare(ACTIVE_OFFER)
    .bind(productId, currency, evaluatedAt, evaluatedAt)
    .first<Offer>();
  if (
    !offer ||
    !Number.isSafeInteger(offer.amount_minor) ||
    offer.amount_minor < 0 ||
    offer.currency !== currency
  ) {
    await denyStagePositive(env.DB, productId, territory, currency);
    return { published: false, reason: "current-retail-offer-unavailable" };
  }
  const schedule = await env.DB
    .prepare(NEXT_BOUNDARY)
    .bind(productId, productId, productId, evaluatedAt)
    .first<Boundary>();
  if (!schedule || schedule.invalid_times !== 0) {
    await denyStagePositive(env.DB, productId, territory, currency);
    return { published: false, reason: "unproven-legal-time-boundary" };
  }
  const nextEvent = schedule.next_transition
    ? Date.parse(schedule.next_transition.replace(" ", "T") + "Z")
    : Infinity;
  if (Number.isNaN(nextEvent)) {
    await denyStagePositive(env.DB, productId, territory, currency);
    return { published: false, reason: "invalid-legal-time-boundary" };
  }
  const expiresAtMs = Math.min(now.getTime() + MAX_LEASE_MS, nextEvent);
  if (!(expiresAtMs > now.getTime())) {
    await denyStagePositive(env.DB, productId, territory, currency);
    return { published: false, reason: "legal-transition-imminent" };
  }
  const expiresAt = sqlTime(new Date(expiresAtMs));
  const material = JSON.stringify({
    v: 1,
    productId,
    territory,
    currency,
    grantId: canonical.grantId,
    contractId: canonical.contractId,
    contractVersionId: canonical.contractVersionId,
    rightsReason: canonical.reasonCode,
    offerId: offer.id,
    amountMinor: offer.amount_minor,
    observed,
    expiresAt,
  });
  const digestBytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(material)));
  const digest = [...digestBytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  const response = (await env.DB
    .prepare(CONDITIONAL_INSERT)
    .bind(
      territory, currency, digest, expiresAt,
      offer.id, territory, productId,
      observed.owner_epoch, observed.us_fallback_revision,
      observed.source_revision, observed.territory_revision, observed.market_revision,
      offer.amount_minor, currency, evaluatedAt, evaluatedAt, expiresAt, expiresAt,
      territory, evaluatedAt, expiresAt,
    )
    .run()) as { meta?: { changes?: number } };
  if (response.meta?.changes !== 1)
    return { published: false, reason: "conditional-owner-write-rejected" };
  return { published: true, reason: "short-lived-canonical-authority" };
}
