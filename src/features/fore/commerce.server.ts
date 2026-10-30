import { z } from "zod/v3";
import { formatMinorCurrency } from "./currency";
import { postRefundAccounting } from "./refund-accounting.server";
import { ApiError } from "./service";
import type { CoveEnv } from "./api.server";
import { canonicalBooksByProductIds, type CatalogDB } from "./catalog-model.server";
import { cartSnapshot, effectiveOffer } from "./retail.server";
import { resolvePricingDecision } from "./pricing.server";
import {
  accrueRoyaltiesForOrder,
  reverseRoyaltiesForChargeback,
  reverseRoyaltiesForRefund,
} from "./finance.server";
import { promotionPermitted } from "./rights.server";
import { requireStageLegalConsumerProof } from "../../storefront-strangler/legal-consumer-fence.server";
import { revokePaidOrderAccess } from "../../storefront-strangler/paid-order-revocation.server";
import { postStageOwnerRefundAccounting } from "../../storefront-strangler/owner-refund-accounting.server";
import { reserveStageOwnerRefundIntent } from "../../storefront-strangler/owner-refund-reservation.server";
import {
  claimStageOwnerStripeWebhook,
  finishStageOwnerStripeWebhook,
} from "../../storefront-strangler/owner-stripe-webhook.server";
import { updateStageOwnerPaymentState } from "../../storefront-strangler/owner-stripe-payment-status.server";
import { syncStageOwnerStripeDispute } from "../../storefront-strangler/owner-stripe-dispute.server";
import {
  cancelStageOwnerUnpaidCheckout,
  recordStageOwnerReconciliation,
} from "../../storefront-strangler/owner-checkout-reconciliation.server";
import { attachStageOwnerCheckoutPayment } from "../../storefront-strangler/owner-checkout-payment.server";
import {
  materializeStageCheckoutDraft,
  prepareStageCheckoutDraft,
} from "../../storefront-strangler/owner-checkout-creation.server";
import { registerStageOwnerStripeCustomer } from "../../storefront-strangler/owner-stripe-customer.server";
import { recordStageOwnerRefundProvider } from "../../storefront-strangler/owner-refund-provider.server";
import {
  settleStageOwnerPaidOrder,
  recoverStageOwnerPaidSettlements,
} from "../../storefront-strangler/owner-paid-settlement.server";
import {
  assertStagePaidOrderNotWithdrawn,
  certifyStagePaidSettlement,
} from "../../storefront-strangler/paid-settlement-publication.server";
import {
  assertPreorderPurchaseAllowed,
  completePreorderRefundJob,
  leasePreorderRefundJobs,
  registerPaidPreorder,
} from "./preorder.server";
import { recordPromotionAttribution } from "./promotions.server";
import { recordRetailEvent } from "./retail-intelligence.server";
import { stationBySlug } from "./cove-sounds-stations";
import { emitNotification } from "./notifications.server";
import { ensureOwnershipSnapshot } from "./delivery.server";
import {
  assessBuyerOrderRisk,
  ingestStripeRiskSignal,
  recordCheckoutTaxEvidence,
  recordCustomerTaxCalculation,
  commitCustomerTaxRecord,
  recordCustomerTaxReversal,
} from "./risk-tax.server";

const now = () => new Date().toISOString();
const LIVE_PUBLISHABLE_KEY =
  "pk_live_51U2mLeI83hMSbuqG7AlyoMIwkMiRnXAOzhu1xUWHQmgIyHIQ5CQbulG18lclVtV5taR9LFAecdJ0OQYt57028FdQ00UwZsetPA";
const EBOOK_TAX_CODE = "txcd_10302000";
const PLACEHOLDER_RE = /REPLACE|YOUR_|CHANGEME|example/i;

type User = { id: string; email?: string; name?: string };
type AnyRow = Record<string, any>;

function publishableKey(env: CoveEnv) {
  return String(env.STRIPE_PUBLISHABLE_KEY || LIVE_PUBLISHABLE_KEY).trim();
}
function expectedLivemode(env: CoveEnv) {
  const pk = publishableKey(env);
  return env.STRIPE_LIVEMODE == null
    ? pk.startsWith("pk_live_")
    : String(env.STRIPE_LIVEMODE).toLowerCase() !== "false";
}
function secretMatchesMode(key: string, live: boolean) {
  return live ? /^(sk|rk)_live_/.test(key) : /^(sk|rk|rkcs)_test_/.test(key);
}
function stripeSecret(env: CoveEnv) {
  const key = String(env.STRIPE_SECRET_KEY || "").trim(),
    live = expectedLivemode(env);
  if (!key || PLACEHOLDER_RE.test(key))
    throw new ApiError(
      503,
      "Stripe checkout is configured with a placeholder secret key. Set STRIPE_SECRET_KEY on the server before accepting payments.",
    );
  if (!/^(sk|rk|rkcs)_/.test(key))
    throw new ApiError(503, "STRIPE_SECRET_KEY is not a Stripe secret or restricted API key.");
  if (!secretMatchesMode(key, live))
    throw new ApiError(
      503,
      `Stripe key mode mismatch: Cove is configured for ${live ? "live" : "test"} mode but STRIPE_SECRET_KEY is for the other mode.`,
    );
  return key;
}
function stripeReady(env: CoveEnv) {
  const key = String(env.STRIPE_SECRET_KEY || "").trim(),
    pk = publishableKey(env),
    live = expectedLivemode(env);
  return (
    pk.startsWith(live ? "pk_live_" : "pk_test_") &&
    !!key &&
    !PLACEHOLDER_RE.test(key) &&
    secretMatchesMode(key, live)
  );
}
export function commerceConfig(env: CoveEnv) {
  const key = publishableKey(env),
    live = expectedLivemode(env);
  return {
    publishableKey: key,
    stripeReady: stripeReady(env),
    taxEnabled: String(env.STRIPE_TAX_ENABLED || "true").toLowerCase() !== "false",
    captureMethod: ["manual", "automatic", "automatic_async"].includes(
      String(env.STRIPE_CAPTURE_METHOD),
    )
      ? String(env.STRIPE_CAPTURE_METHOD)
      : "automatic_async",
    livemode: live,
    merchantName: "Cove",
  };
}

function append(params: URLSearchParams, key: string, value: any) {
  if (value === undefined || value === null) return;
  if (Array.isArray(value)) {
    value.forEach((v, i) => append(params, `${key}[${i}]`, v));
    return;
  }
  if (typeof value === "object") {
    Object.entries(value).forEach(([k, v]) => append(params, key ? `${key}[${k}]` : k, v));
    return;
  }
  params.append(key, String(value));
}
async function stripeRequest(
  env: CoveEnv,
  path: string,
  options: { method?: "GET" | "POST"; params?: Record<string, any>; idempotencyKey?: string } = {},
) {
  const method = options.method || "POST",
    params = new URLSearchParams();
  Object.entries(options.params || {}).forEach(([k, v]) => append(params, k, v));
  const url =
    "https://api.stripe.com/v1/" +
    path.replace(/^\//, "") +
    (method === "GET" && params.size ? `?${params}` : "");
  const headers: Record<string, string> = { Authorization: `Bearer ${stripeSecret(env)}` };
  if (env.STRIPE_API_VERSION) headers["Stripe-Version"] = String(env.STRIPE_API_VERSION);
  if (options.idempotencyKey) headers["Idempotency-Key"] = options.idempotencyKey;
  if (method === "POST") headers["Content-Type"] = "application/x-www-form-urlencoded";
  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers,
      body: method === "POST" ? params : undefined,
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    throw new ApiError(
      502,
      "Stripe is temporarily unreachable. Your order was not charged; please try again.",
    );
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = data?.error?.message || "Stripe could not process this request.";
    const err = new ApiError(response.status >= 500 ? 502 : 400, message);
    (err as any).stripeCode = data?.error?.code;
    throw err;
  }
  return data as AnyRow;
}
async function sha256(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}
function normalizeCode(v: string) {
  return v.trim().replace(/\s+/g, "").toUpperCase();
}
const addressSchema = z.object({
  name: z.string().trim().min(1).max(120),
  line1: z.string().trim().min(1).max(180),
  line2: z.string().trim().max(180).default(""),
  city: z.string().trim().min(1).max(120),
  state: z.string().trim().max(120).default(""),
  postalCode: z.string().trim().min(1).max(30),
  country: z
    .string()
    .trim()
    .regex(/^[A-Za-z]{2}$/)
    .transform((x) => x.toUpperCase()),
});
function moneySplit(total: number, weights: number[]) {
  if (total <= 0) return weights.map(() => 0);
  const sum = weights.reduce((a, b) => a + b, 0);
  if (!sum) return weights.map(() => 0);
  const raw = weights.map((w) => (total * w) / sum),
    out = raw.map(Math.floor);
  let left = total - out.reduce((a, b) => a + b, 0);
  raw
    .map((x, i) => ({ i, f: x - Math.floor(x) }))
    .sort((a, b) => b.f - a.f)
    .forEach((x) => {
      if (left-- > 0) out[x.i]++;
    });
  return out;
}

async function cartPricing(db: CatalogDB, userId: string, territory: string, env?: CoveEnv) {
  const snap = await cartSnapshot(db, userId, territory);
  if (!snap.items.length) throw new ApiError(409, "Your cart is empty.");
  const bad = snap.items.filter((x: any) => !x.available || !x.offer || !x.book?.productId);
  if (bad.length)
    throw new ApiError(
      409,
      "One or more cart items are no longer available in your storefront. Remove them before checkout.",
    );
  const currencies = new Set(snap.items.map((x: any) => String(x.offer.currency).toUpperCase()));
  if (currencies.size !== 1)
    throw new ApiError(409, "All items in an order must use the same currency.");
  const currency = [...currencies][0];
  const items = [] as any[];
  for (const x of snap.items as any[]) {
    await assertPreorderPurchaseAllowed(db, userId, String(x.book.productId));
    const d = await resolvePricingDecision(db, String(x.book.productId), territory, {
      userId,
      // The staged primary-D1 lock denies legacy rights-decision writes.
      persist: env?.COVE_LEGAL_CONSUMER_STAGE_ENABLED !== "1",
    });
    if (!d) throw new ApiError(409, "A cart item is no longer purchasable in your storefront.");
    items.push({
      productId: String(x.book.productId),
      externalId: String(x.book.sourceExternalId || x.book.id),
      title: String(x.book.title),
      sku: String(x.book.sku || x.book.productId),
      offerId: d.offerId,
      pricingDecisionId: d.id || null,
      rightsDecisionId: d.rights.decisionId || null,
      rightsGrantId: d.rights.grantId,
      rightsSnapshot: {
        grantId: d.rights.grantId,
        editionId: d.rights.editionId,
        territory: d.rights.territory,
        format: d.rights.format,
        salesChannel: d.rights.salesChannel,
        rightsholderName: d.rights.rightsholderName,
        licenseType: d.rights.licenseType,
        contractId: d.rights.contractId,
        contractVersionId: d.rights.contractVersionId,
        contractPolicy: d.rights.contractPolicy,
        contractReference: d.rights.contractReference,
        exclusivity: d.rights.exclusivity,
        scopeSummary: d.rights.scopeSummary,
        languageRights: d.rights.languageRights,
        sourceEvidenceId: d.rights.sourceEvidenceId,
        drmRequirement: d.rights.drmRequirement,
        promotionRestrictions: d.rights.promotionRestrictions,
        startsAt: d.rights.startsAt,
        endsAt: d.rights.endsAt,
      },
      amountMinor: Number(d.amountMinor),
      listAmountMinor: Number(d.listAmountMinor),
      currency: d.currency,
      promotionCampaignId: d.promotion?.campaignId || null,
      pricingPromotion: d.promotion || null,
      sourceSurface: String(x.sourceSurface || "cart"),
      sourceRequestId: x.sourceRequestId || null,
      taxBehavior: d.taxBehavior,
      taxCode: d.taxCode,
    });
  }
  const finalCurrencies = new Set(items.map((x) => x.currency));
  if (finalCurrencies.size !== 1)
    throw new ApiError(409, "All items in an order must resolve to the same currency.");
  const resolvedCurrency = [...finalCurrencies][0];
  if (env) {
    await requireStageLegalConsumerProof(
      env,
      items.map((item) => ({
        id: item.productId,
        source_name:
          item.productId === "prd_gutenberg_" + item.externalId ? "gutenberg" : "commercial",
        source_external_id: item.externalId,
        expectedEditionId: item.rightsSnapshot.editionId,
        expectedGrantId: item.rightsGrantId,
        expectedContractVersionId: item.rightsSnapshot.contractVersionId,
      })),
      territory.toUpperCase(),
      resolvedCurrency,
    );
  }
  const fingerprint = await sha256(
    JSON.stringify(
      items.map((x) => [
        x.productId,
        x.offerId,
        x.amountMinor,
        x.currency,
        x.taxBehavior,
        x.taxCode,
        x.rightsGrantId,
        x.rightsSnapshot?.endsAt || null,
        x.rightsSnapshot?.contractId || null,
        x.rightsSnapshot?.contractVersionId || null,
        x.rightsSnapshot?.contractPolicy || {},
        x.rightsSnapshot?.scopeSummary || "",
        x.rightsSnapshot?.languageRights || {},
        x.rightsSnapshot?.sourceEvidenceId || null,
        x.rightsSnapshot?.drmRequirement || "none",
        x.rightsSnapshot?.promotionRestrictions || {},
      ]),
    ),
  );
  return {
    items,
    currency: resolvedCurrency,
    subtotalMinor: items.reduce((s, x) => s + x.amountMinor, 0),
    fingerprint,
    stalePrice: snap.items.some((x: any) => x.stalePrice),
  };
}

async function promoFor(
  db: CatalogDB,
  userId: string,
  code: string,
  subtotal: number,
  currency: string,
) {
  if (!code) return null;
  const hash = await sha256(normalizeCode(code)),
    at = now();
  const row = await db
    .prepare(
      `SELECT * FROM commerce_promo_codes WHERE code_hash=? AND active=1 AND (starts_at IS NULL OR starts_at<=?) AND (ends_at IS NULL OR ends_at>?)`,
    )
    .bind(hash, at, at)
    .first<any>();
  if (!row) throw new ApiError(400, "That promotional code is invalid or expired.");
  if (row.currency && String(row.currency).toUpperCase() !== currency)
    throw new ApiError(400, "That promotional code does not apply to this currency.");
  if (subtotal < Number(row.minimum_subtotal_minor || 0))
    throw new ApiError(400, "Your cart does not meet this promotion's minimum purchase amount.");
  const total = Number(
      (
        await db
          .prepare(
            "SELECT COUNT(*) n FROM commerce_promo_redemptions WHERE code_hash=? AND status IN ('reserved','applied')",
          )
          .bind(hash)
          .first<any>()
      )?.n || 0,
    ),
    mine = Number(
      (
        await db
          .prepare(
            "SELECT COUNT(*) n FROM commerce_promo_redemptions WHERE code_hash=? AND user_id=? AND status IN ('reserved','applied')",
          )
          .bind(hash, userId)
          .first<any>()
      )?.n || 0,
    );
  if (row.max_redemptions != null && total >= Number(row.max_redemptions))
    throw new ApiError(409, "That promotion has reached its redemption limit.");
  if (mine >= Number(row.max_per_user || 1))
    throw new ApiError(409, "You have already used that promotion.");
  const amount =
    row.kind === "percent"
      ? Math.floor((subtotal * Math.min(100, Number(row.value))) / 100)
      : Math.min(subtotal, Number(row.value));
  let eligibleProducts: string[] = [];
  try {
    eligibleProducts = JSON.parse(String(row.eligible_products_json || "[]"));
  } catch {}
  return {
    hash,
    label: String(row.code_label),
    amountMinor: Math.max(0, amount),
    campaignId: row.campaign_id || null,
    fundingSource: String(row.funding_source || "fore"),
    publisherFundingBps: Number(row.publisher_funding_bps || 0),
    eligibleProducts,
    stackable: Number(row.stackable || 0) === 1,
    kind: String(row.kind),
    value: Number(row.value),
  };
}
async function giftAvailability(db: CatalogDB, code: string, currency: string) {
  if (!code) return null;
  const normalized = normalizeCode(code),
    hash = await sha256(normalized),
    at = now();
  const row = await db
    .prepare(
      `SELECT * FROM commerce_gift_cards WHERE code_hash=? AND status='active' AND (expires_at IS NULL OR expires_at>?)`,
    )
    .bind(hash, at)
    .first<any>();
  if (!row) throw new ApiError(400, "That Cove gift card is invalid or unavailable.");
  if (String(row.currency).toUpperCase() !== currency)
    throw new ApiError(400, "That gift card uses a different currency.");
  const reserved = Number(
    (
      await db
        .prepare(
          "SELECT COALESCE(SUM(amount_minor),0) n FROM commerce_balance_reservations WHERE source_type='gift_card' AND source_key=? AND status='reserved'",
        )
        .bind(hash)
        .first<any>()
    )?.n || 0,
  );
  return {
    hash,
    last4: String(row.last4),
    available: Math.max(0, Number(row.balance_minor) - reserved),
  };
}
async function storeCreditAvailable(db: CatalogDB, userId: string, currency: string) {
  const ledger = Number(
      (
        await db
          .prepare(
            "SELECT COALESCE(SUM(amount_minor),0) n FROM commerce_store_credit_ledger WHERE user_id=? AND currency=?",
          )
          .bind(userId, currency)
          .first<any>()
      )?.n || 0,
    ),
    reserved = Number(
      (
        await db
          .prepare(
            "SELECT COALESCE(SUM(amount_minor),0) n FROM commerce_balance_reservations WHERE source_type='store_credit' AND source_key=? AND currency=? AND status='reserved'",
          )
          .bind(userId, currency)
          .first<any>()
      )?.n || 0,
    );
  return Math.max(0, ledger - reserved);
}

export async function checkoutQuote(_env: CoveEnv, _user: User, _raw: unknown) {
  throw new ApiError(503, "Checkout quotes require the private commerce owner.");
}

async function ensureStripeCustomer(env: CoveEnv, user: User) {
  if (env.COVE_LEGAL_CONSUMER_STAGE_ENABLED !== "1")
    throw new ApiError(503, "Stripe customer registration requires the private commerce owner.");
  const db = env.DB;
  const row = await db
    .prepare("SELECT stripe_customer_id FROM commerce_customers WHERE user_id=?")
    .bind(user.id)
    .first<any>();
  if (row?.stripe_customer_id) return String(row.stripe_customer_id);
  const customer = await stripeRequest(env, "customers", {
    params: {
      email: user.email || undefined,
      name: user.name || undefined,
      metadata: { fore_user_id: user.id },
    },
    idempotencyKey: `fore-customer-${user.id}`,
  });
  await registerStageOwnerStripeCustomer(env, {
    userId: user.id,
    customerId: String(customer.id),
  });
  return String(customer.id);
}
function invoiceNumber() {
  const d = new Date(),
    ym = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  return `FORE-${ym}-${crypto.randomUUID().replace(/-/g, "").slice(0, 10).toUpperCase()}`;
}
async function existingOrderSetup(env: CoveEnv, existing: any) {
  if (existing.stripe_payment_intent_id) {
    const pi = await stripeRequest(
      env,
      `payment_intents/${encodeURIComponent(existing.stripe_payment_intent_id)}`,
      { method: "GET" },
    );
    return {
      orderId: existing.id,
      status: existing.status,
      clientSecret: pi.client_secret || null,
      paymentIntentId: pi.id,
      stripeDueMinor: Number(existing.stripe_due_minor),
      currency: existing.currency,
    };
  }
  if (Number(existing.stripe_due_minor) === 0 || existing.status === "paid")
    return {
      orderId: existing.id,
      status: existing.status,
      clientSecret: null,
      stripeDueMinor: Number(existing.stripe_due_minor),
      currency: existing.currency,
    };
  throw new ApiError(
    409,
    "This checkout is already being initialized. Open Orders in a moment instead of submitting it again.",
  );
}
// Tender and promotion reservations are executed solely by the private owner.

// Synthetic staging checkout is exclusively enrolled behind the private legal
// owner. There is NO fallback to direct commercial D1 writes on owner refusal.
async function createStageOwnerCheckoutPayment(
  env: CoveEnv,
  user: User,
  input: {
    quoteId: string;
    idempotencyKey: string;
    soundsStation?: string;
    soundsRecording?: string;
  },
  quote: AnyRow,
  reprice: boolean,
) {
  const db = env.DB;
  if (reprice) {
    const cart = await cartPricing(db, user.id, String(quote.territory_code), env);
    if (cart.fingerprint !== quote.cart_fingerprint)
      throw new ApiError(409, "Your cart changed. Recalculate checkout before paying.");
  }
  const captureMethod = (
    ["manual", "automatic", "automatic_async"].includes(String(env.STRIPE_CAPTURE_METHOD))
      ? String(env.STRIPE_CAPTURE_METHOD)
      : "automatic_async"
  ) as "manual" | "automatic" | "automatic_async";
  const station =
    input.soundsStation && stationBySlug(input.soundsStation) ? input.soundsStation : undefined;
  const draft = await materializeStageCheckoutDraft(env, {
    userId: user.id,
    quoteId: input.quoteId,
    idempotencyKey: input.idempotencyKey,
    cartFingerprint: String(quote.cart_fingerprint),
    captureMethod,
    ...(station ? { soundsStation: station, soundsRecording: input.soundsRecording } : {}),
  });
  const orderId = String(draft.orderId);
  // Durable legal denials are checked before any monetary reservation;
  // settlement independently rechecks in case rights are withdrawn later.
  await assertStagePaidOrderNotWithdrawn(env, orderId);
  const prep = await prepareStageCheckoutDraft(env, {
    userId: user.id,
    orderId,
    quoteId: input.quoteId,
  });
  if (prep.ready !== true || prep.blocked === true)
    throw new ApiError(
      403,
      "This checkout requires manual verification before it can be completed.",
    );
  const order = await db
    .prepare(
      "SELECT id,invoice_number,status,currency,stripe_due_minor,quote_id,stripe_payment_intent_id FROM commerce_orders WHERE id=? AND user_id=?",
    )
    .bind(orderId, user.id)
    .first<any>();
  if (
    !order ||
    order.quote_id !== input.quoteId ||
    order.status !== "pending_payment" ||
    Number(order.stripe_due_minor) !== Number(draft.stripeDueMinor)
  )
    throw new ApiError(503, "Checkout owner receipt differs from canonical order.");
  // Original analytics remain idempotent; a failed best-effort event must not
  // convert an owner-prepared order into a second monetary reservation.
  if (draft.created) {
    let items: AnyRow[] = [];
    try {
      items = JSON.parse(String(quote.items_json || "[]"));
    } catch {
      items = [];
    }
    for (const item of items)
      await recordRetailEvent(db, user.id, {
        eventType: "checkout_started",
        productId: String(item.productId),
        externalBookId: String(item.externalId || ""),
        sourceSurface: String(item.sourceSurface || "checkout"),
        sourceRequestId: item.sourceRequestId || null,
        territory: String(quote.territory_code),
        currency: String(quote.currency),
        amountMinor: Number(item.amountMinor || 0) - Number(item.discountMinor || 0),
        properties: { orderId, quoteId: input.quoteId },
        dedupeKey: `checkout:${orderId}:${item.productId}`,
      }).catch(() => undefined);
  }
  if (Number(order.stripe_due_minor) === 0) {
    await finalizePaidOrder(env, orderId, {
      provider: "internal",
      paymentIntentId: null,
      chargeId: null,
      receiptUrl: null,
      paymentMethod: "Cove balance",
    });
    return {
      orderId,
      status: "paid",
      clientSecret: null,
      stripeDueMinor: 0,
      currency: order.currency,
    };
  }
  const customer = await ensureStripeCustomer(env, user);
  const pi = await stripeRequest(env, "payment_intents", {
    idempotencyKey: `fore-pi-${orderId}`,
    params: {
      amount: Number(order.stripe_due_minor),
      currency: String(order.currency).toLowerCase(),
      customer,
      receipt_email: user.email || undefined,
      automatic_payment_methods: { enabled: true },
      capture_method: String(prep.captureMethod),
      description: `Cove order ${order.invoice_number}`,
      metadata: {
        fore_order_id: orderId,
        fore_user_id: user.id,
        fore_invoice: order.invoice_number,
      },
      ...(prep.riskAction === "challenge"
        ? { payment_method_options: { card: { request_three_d_secure: "any" } } }
        : {}),
    },
  });
  await attachStageOwnerCheckoutPayment(env, {
    orderId,
    userId: user.id,
    paymentIntentId: String(pi.id),
    customerId: String(customer),
  });
  return {
    orderId,
    status: "pending_payment",
    clientSecret: pi.client_secret,
    paymentIntentId: pi.id,
    stripeDueMinor: Number(order.stripe_due_minor),
    currency: order.currency,
  };
}

export async function createCheckoutPayment(env: CoveEnv, user: User, raw: unknown) {
  if (env.COVE_LEGAL_CONSUMER_STAGE_ENABLED !== "1")
    throw new ApiError(503, "Checkout requires the private commerce owner.");
  const input = z
      .object({
        quoteId: z.string().min(8).max(120),
        idempotencyKey: z.string().min(16).max(200),
        soundsStation: z.string().max(80).optional(),
        soundsRecording: z
          .string()
          .regex(/^(?:cm_[0-9]{1,15}|ex_[0-9a-f-]{36})$/)
          .optional(),
      })
      .parse(raw),
    db = env.DB;
  let existing = await db
    .prepare("SELECT * FROM commerce_orders WHERE idempotency_key=? AND user_id=?")
    .bind(input.idempotencyKey, user.id)
    .first<any>();
  if (existing) {
    if (
      env.COVE_LEGAL_CONSUMER_STAGE_ENABLED === "1" &&
      existing.status === "pending_payment" &&
      !existing.stripe_payment_intent_id
    ) {
      const q = await db
        .prepare("SELECT * FROM commerce_checkout_quotes WHERE id=? AND user_id=?")
        .bind(existing.quote_id, user.id)
        .first<any>();
      if (!q) throw new ApiError(409, "The checkout quote is unavailable.");
      return createStageOwnerCheckoutPayment(env, user, input, q, false);
    }
    return existingOrderSetup(env, existing);
  }
  existing = await db
    .prepare("SELECT * FROM commerce_orders WHERE quote_id=? AND user_id=?")
    .bind(input.quoteId, user.id)
    .first<any>();
  if (existing) {
    if (
      env.COVE_LEGAL_CONSUMER_STAGE_ENABLED === "1" &&
      existing.status === "pending_payment" &&
      !existing.stripe_payment_intent_id
    ) {
      const q = await db
        .prepare("SELECT * FROM commerce_checkout_quotes WHERE id=? AND user_id=?")
        .bind(existing.quote_id, user.id)
        .first<any>();
      if (!q) throw new ApiError(409, "The checkout quote is unavailable.");
      return createStageOwnerCheckoutPayment(env, user, input, q, false);
    }
    return existingOrderSetup(env, existing);
  }
  const quote = await db
    .prepare(
      "SELECT * FROM commerce_checkout_quotes WHERE id=? AND user_id=? AND consumed_at IS NULL AND expires_at>?",
    )
    .bind(input.quoteId, user.id, now())
    .first<any>();
  if (!quote) throw new ApiError(409, "This checkout quote expired. Recalculate your total.");
  const cart = await cartPricing(db, user.id, String(quote.territory_code), env),
    currentFingerprint = cart.fingerprint;
  if (currentFingerprint !== quote.cart_fingerprint)
    throw new ApiError(409, "Your cart changed. Recalculate checkout before paying.");
  if (env.COVE_LEGAL_CONSUMER_STAGE_ENABLED === "1")
    return createStageOwnerCheckoutPayment(env, user, input, quote, false);
  throw new ApiError(503, "Checkout requires the private commerce owner.");
}

async function recordTaxTransaction(env: CoveEnv, order: AnyRow) {
  if (
    !order.stripe_tax_calculation_id ||
    order.stripe_tax_transaction_id ||
    String(env.STRIPE_TAX_ENABLED || "true").toLowerCase() === "false"
  )
    return null;
  const tx = await stripeRequest(env, "tax/transactions/create_from_calculation", {
    idempotencyKey: `fore-tax-${order.id}`,
    params: {
      calculation: order.stripe_tax_calculation_id,
      reference: order.id,
      metadata: { fore_order_id: order.id },
    },
  });
  await env.DB.prepare(
    "UPDATE commerce_orders SET stripe_tax_transaction_id=?,updated_at=? WHERE id=?",
  )
    .bind(tx.id, now(), order.id)
    .run();
  await commitCustomerTaxRecord(env.DB, order.id, String(tx.id));
  return tx.id;
}
export async function finalizePaidOrder(
  env: CoveEnv,
  orderId: string,
  payment: {
    provider: string;
    paymentIntentId: string | null;
    chargeId: string | null;
    receiptUrl: string | null;
    paymentMethod?: string;
  },
) {
  if (env.COVE_LEGAL_CONSUMER_STAGE_ENABLED !== "1")
    throw new ApiError(503, "Paid settlement requires the private commerce owner.");
  const db = env.DB,
    order = await db.prepare("SELECT * FROM commerce_orders WHERE id=?").bind(orderId).first<any>();
  if (!order) throw new ApiError(404, "Order not found.");
  if (["paid", "partially_refunded", "refunded"].includes(order.status)) {
    if (order.status === "paid") {
      // Existing purchases predate the atomic-receipt migration. They retain
      // read-only owner certification; a new receipt may never be invented
      // for a partially written historical sale.
      if (
        env.COVE_LEGAL_CONSUMER_STAGE_ENABLED === "1" &&
        (await db
          .prepare("SELECT order_id FROM commerce_settlement_receipts WHERE order_id=?")
          .bind(orderId)
          .first())
      )
        return settleStageOwnerPaidOrder(env, orderId);
      await certifyStagePaidSettlement(env, String(order.id), String(order.user_id));
    }
    return order;
  }
  // A valid, signed and correctly linked success event can arrive after
  // cancellation, dispute or other terminal revocation. Never issue paid
  // entitlements, consume tender or accrue royalties for those orders.
  if (!["pending_payment", "processing", "authorized", "payment_failed"].includes(order.status))
    throw new ApiError(409, "Terminal or invalid order cannot be settled.");
  // Enrolled new settlements have NO caller-side mutation or fallback.
  if (env.COVE_LEGAL_CONSUMER_STAGE_ENABLED === "1") return settleStageOwnerPaidOrder(env, orderId);
  throw new ApiError(503, "Paid settlement requires the private commerce owner.");
}

/** Retryable owner-side obligations. The atomic receipt is the outbox: a
 * committed order is not acknowledged for access until these obligations
 * finish. A provider/royalty/notification outage retains the pending marker. */
export async function reconcileOwnerPaidSettlementEffects(env: CoveEnv, orderId: string) {
  const db = env.DB;
  const receipt = await db
    .prepare("SELECT effects_completed_at FROM commerce_settlement_receipts WHERE order_id=?")
    .bind(orderId)
    .first<AnyRow>();
  if (!receipt) throw new ApiError(409, "Atomic settlement receipt is missing.");
  if (receipt.effects_completed_at) return;
  const order = await db
    .prepare("SELECT * FROM commerce_orders WHERE id=?")
    .bind(orderId)
    .first<AnyRow>();
  if (!order || order.status !== "paid")
    throw new ApiError(409, "Settlement was revoked before reconciliation.");
  const items = await db
    .prepare("SELECT * FROM commerce_order_items WHERE order_id=? ORDER BY id")
    .bind(orderId)
    .all<AnyRow>();
  const purchaseEvents: AnyRow[] = [];
  for (const item of items.results) {
    const pricingCampaign = await db
      .prepare(
        `SELECT pr.campaign_id,pd.promotion_amount_minor FROM pricing_decisions pd JOIN promotions pr ON pr.id=pd.promotion_id WHERE pd.id=?`,
      )
      .bind(item.pricing_decision_id || "")
      .first<AnyRow>();
    const campaignFunding = new Map<string, number>();
    if (item.promotion_campaign_id)
      campaignFunding.set(
        String(item.promotion_campaign_id),
        Number(item.publisher_discount_funding_minor || 0) +
          Number(item.fore_discount_funding_minor || 0),
      );
    if (pricingCampaign?.campaign_id)
      campaignFunding.set(
        String(pricingCampaign.campaign_id),
        (campaignFunding.get(String(pricingCampaign.campaign_id)) || 0) +
          Number(pricingCampaign.promotion_amount_minor || 0),
      );
    for (const [campaignId, fundingMinor] of campaignFunding)
      await recordPromotionAttribution(db, {
        campaignId,
        productId: item.product_id,
        userId: order.user_id,
        eventType: "order",
        orderId: order.id,
        orderItemId: item.id,
        amountMinor: Number(item.total_minor || 0),
        fundingMinor,
        currency: order.currency,
        sourceSurface: item.source_surface || "checkout",
        dedupeKey: `order:${order.id}:${item.id}:${campaignId}`,
      });
    purchaseEvents.push({
      eventType: "purchase_completed",
      productId: String(item.product_id),
      sourceSurface: String(item.source_surface || "checkout"),
      sourceRequestId: item.source_request_id || null,
      territory: String(order.territory_code || "US"),
      currency: String(order.currency),
      amountMinor: Number(item.total_minor || 0),
      properties: {
        orderId: order.id,
        orderItemId: item.id,
        preorder: !!item.preorder_id,
        promotionCampaignId: item.promotion_campaign_id || null,
      },
      dedupeKey: `purchase:${order.id}:${item.id}`,
    });
  }
  for (const event of purchaseEvents) await recordRetailEvent(db, order.user_id, event);
  await recordTaxTransaction(env, order);
  await emitNotification(db, {
    userId: String(order.user_id),
    eventType: "purchase_receipt",
    dedupeKey: `purchase-receipt:${orderId}`,
    title: `Receipt ${order.invoice_number}`,
    body: `Your Cove order is complete. Total ${formatMinorCurrency(Number(order.total_minor || 0), String(order.currency || "USD"))}.`,
    subjectType: "order",
    subjectId: orderId,
    actionUrl: `/orders/${encodeURIComponent(orderId)}`,
    payload: {
      orderId,
      invoiceNumber: order.invoice_number,
      currency: order.currency,
      totalMinor: Number(order.total_minor || 0),
    },
  });
}

export async function recoverPayment(env: CoveEnv, userId: string, orderId: string) {
  const order = await env.DB.prepare("SELECT * FROM commerce_orders WHERE id=? AND user_id=?")
    .bind(orderId, userId)
    .first<any>();
  if (!order) throw new ApiError(404, "Order not found.");
  if (!order.stripe_payment_intent_id) return { orderId, status: order.status, clientSecret: null };
  const pi = await stripeRequest(
    env,
    `payment_intents/${encodeURIComponent(order.stripe_payment_intent_id)}`,
    { method: "GET" },
  );
  return {
    orderId,
    status: order.status,
    paymentStatus: pi.status,
    clientSecret: ["requires_payment_method", "requires_action", "requires_confirmation"].includes(
      pi.status,
    )
      ? pi.client_secret
      : null,
    amountMinor: order.stripe_due_minor,
    currency: order.currency,
  };
}
export async function cancelCheckoutOrder(env: CoveEnv, userId: string, orderId: string) {
  if (env.COVE_LEGAL_CONSUMER_STAGE_ENABLED !== "1")
    throw new ApiError(503, "Order cancellation requires the private commerce owner.");
  const db = env.DB,
    o = await db
      .prepare("SELECT * FROM commerce_orders WHERE id=? AND user_id=?")
      .bind(orderId, userId)
      .first<any>();
  if (!o) throw new ApiError(404, "Order not found.");
  if (o.status === "canceled") return { orderId, status: "canceled" };
  if (!["pending_payment", "payment_failed"].includes(o.status))
    throw new ApiError(409, "This order can no longer be canceled from checkout.");
  if (o.stripe_payment_intent_id) {
    const pi = await stripeRequest(
      env,
      `payment_intents/${encodeURIComponent(o.stripe_payment_intent_id)}`,
      { method: "GET" },
    );
    if (["succeeded", "processing", "requires_capture"].includes(String(pi.status)))
      throw new ApiError(
        409,
        "Stripe has already accepted this payment; wait for the order status to update.",
      );
    if (pi.status !== "canceled")
      await stripeRequest(
        env,
        `payment_intents/${encodeURIComponent(o.stripe_payment_intent_id)}/cancel`,
        {
          idempotencyKey: `fore-cancel-${o.id}`,
          params: { cancellation_reason: "requested_by_customer" },
        },
      );
  }
  if (env.COVE_LEGAL_CONSUMER_STAGE_ENABLED === "1") {
    // Only the private owner independently verifies Stripe's CANCELED state
    // and atomically releases the checkout's tender/promo reservations.
    // A failed owner acknowledgment has no legacy D1 fallback.
    await cancelStageOwnerUnpaidCheckout(env, {
      orderId: String(o.id),
      userId: String(o.user_id),
      source: "customer",
    });
    return { orderId: o.id, status: "canceled" };
  }
  throw new ApiError(503, "Order cancellation requires the private commerce owner.");
}

export async function orderHistory(db: CatalogDB, userId: string) {
  const rows = await db
    .prepare("SELECT * FROM commerce_orders WHERE user_id=? ORDER BY created_at DESC LIMIT 200")
    .bind(userId)
    .all<any>();
  return { orders: rows.results.map(orderPublic) };
}
function orderPublic(o: any) {
  return {
    id: o.id,
    invoiceNumber: o.invoice_number,
    status: o.status,
    currency: o.currency,
    subtotalMinor: o.subtotal_minor,
    promoDiscountMinor: o.promo_discount_minor,
    taxMinor: o.tax_minor,
    taxInclusiveMinor: o.tax_inclusive_minor,
    giftCardMinor: o.gift_card_minor,
    storeCreditMinor: o.store_credit_minor,
    totalMinor: o.total_minor,
    stripeDueMinor: o.stripe_due_minor,
    refundedMinor: o.refunded_minor,
    receiptUrl: o.receipt_url,
    createdAt: o.created_at,
    paidAt: o.paid_at,
  };
}
export async function orderDetail(db: CatalogDB, userId: string, orderId: string) {
  const o = await db
    .prepare("SELECT * FROM commerce_orders WHERE id=? AND user_id=?")
    .bind(orderId, userId)
    .first<any>();
  if (!o) throw new ApiError(404, "Order not found.");
  const items = await db
    .prepare(
      "SELECT id,product_id,title_snapshot,sku_snapshot,unit_amount_minor,discount_minor,tax_minor,total_minor,entitlement_status,fulfillment_type,fulfillment_status,preorder_id,promotion_campaign_id,publisher_discount_funding_minor,fore_discount_funding_minor,processor_fee_minor,distributor_fee_minor,rights_decision_id,rights_grant_id FROM commerce_order_items WHERE order_id=? ORDER BY created_at",
    )
    .bind(orderId)
    .all<any>();
  const refunds = await db
    .prepare(
      "SELECT id,amount_minor,stripe_amount_minor,gift_card_amount_minor,store_credit_amount_minor,currency,reason,status,created_at,succeeded_at FROM commerce_refunds WHERE order_id=? ORDER BY created_at DESC",
    )
    .bind(orderId)
    .all<any>();
  return {
    ...orderPublic(o),
    items: items.results,
    refunds: refunds.results,
    billingAddress: JSON.parse(o.billing_address_json || "{}"),
    taxBreakdown: o.quote_id
      ? JSON.parse(
          String(
            (
              await db
                .prepare("SELECT tax_breakdown_json FROM commerce_checkout_quotes WHERE id=?")
                .bind(o.quote_id)
                .first<any>()
            )?.tax_breakdown_json || "[]",
          ),
        )
      : [],
  };
}
export async function invoiceRecord(db: CatalogDB, userId: string, orderId: string) {
  const detail: any = await orderDetail(db, userId, orderId);
  if (
    !["paid", "partially_refunded", "refunded", "disputed", "chargeback_lost"].includes(
      detail.status,
    )
  )
    throw new ApiError(409, "An invoice is available after payment is completed.");
  return {
    seller: { name: "Cove" },
    invoiceNumber: detail.invoiceNumber,
    orderId: detail.id,
    issuedAt: detail.paidAt || detail.createdAt,
    currency: detail.currency,
    billingAddress: detail.billingAddress,
    items: detail.items,
    subtotalMinor: detail.subtotalMinor,
    discountMinor: detail.promoDiscountMinor,
    taxMinor: detail.taxMinor,
    taxInclusiveMinor: detail.taxInclusiveMinor,
    totalMinor: detail.totalMinor,
    refundedMinor: detail.refundedMinor,
  };
}
function htmlEscape(v: any) {
  return String(v ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] || c,
  );
}
export async function invoiceHtml(db: CatalogDB, userId: string, orderId: string) {
  const x: any = await invoiceRecord(db, userId, orderId),
    money = (n: number) => formatMinorCurrency(Number(n || 0), x.currency),
    a = x.billingAddress || {},
    items = (x.items || [])
      .map(
        (i: any) =>
          `<tr><td>${htmlEscape(i.title_snapshot)}</td><td>${htmlEscape(i.sku_snapshot)}</td><td class="num">${htmlEscape(money(i.unit_amount_minor))}</td><td class="num">-${htmlEscape(money(i.discount_minor))}</td><td class="num">${htmlEscape(money(i.tax_minor))}</td><td class="num">${htmlEscape(money(i.total_minor))}</td></tr>`,
      )
      .join("");
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${htmlEscape(x.invoiceNumber)} · Cove</title><style>body{font-family:ui-sans-serif,system-ui,sans-serif;color:#17202b;margin:0;background:#f5f3ee}.sheet{max-width:900px;margin:32px auto;background:#fff;padding:48px;box-shadow:0 8px 35px #0001}.top{display:flex;justify-content:space-between;gap:24px}.brand{font-family:Georgia,serif;font-size:34px}.muted{color:#687381}.address{line-height:1.5}.meta{text-align:right}.meta strong{display:block;font-size:20px;margin-bottom:5px}table{width:100%;border-collapse:collapse;margin:35px 0 20px;font-size:13px}th,td{padding:10px 8px;border-bottom:1px solid #dfe3e7;text-align:left}.num{text-align:right;white-space:nowrap}.totals{max-width:370px;margin-left:auto}.row{display:flex;justify-content:space-between;padding:6px 0}.total{font-size:18px;font-weight:700;border-top:2px solid #17202b;margin-top:8px;padding-top:12px}.print{margin-top:28px}@media print{body{background:#fff}.sheet{box-shadow:none;margin:0;max-width:none}.print{display:none}}</style></head><body><main class="sheet"><div class="top"><div><div class="brand">fore.</div><p class="muted">Digital bookstore receipt / invoice record</p></div><div class="meta"><strong>${htmlEscape(x.invoiceNumber)}</strong><span>${htmlEscape(new Date(x.issuedAt).toLocaleString("en-US", { dateStyle: "long" }))}</span><br><span>Order ${htmlEscape(x.orderId)}</span></div></div><section><h3>Bill to</h3><div class="address">${htmlEscape(a.name)}<br>${htmlEscape(a.line1)}${a.line2 ? `<br>${htmlEscape(a.line2)}` : ""}<br>${htmlEscape(a.city)}${a.state ? `, ${htmlEscape(a.state)}` : ""} ${htmlEscape(a.postalCode)}<br>${htmlEscape(a.country)}</div></section><table><thead><tr><th>Title</th><th>SKU</th><th class="num">Price</th><th class="num">Discount</th><th class="num">Tax</th><th class="num">Total</th></tr></thead><tbody>${items}</tbody></table><div class="totals"><div class="row"><span>Subtotal</span><strong>${htmlEscape(money(x.subtotalMinor))}</strong></div>${x.discountMinor ? `<div class="row"><span>Promotion</span><strong>-${htmlEscape(money(x.discountMinor))}</strong></div>` : ""}<div class="row"><span>Tax added</span><strong>${htmlEscape(money(x.taxMinor))}</strong></div>${x.taxInclusiveMinor ? `<div class="row"><span>Tax included in item prices</span><strong>${htmlEscape(money(x.taxInclusiveMinor))}</strong></div>` : ""}<div class="row total"><span>Total</span><strong>${htmlEscape(money(x.totalMinor))}</strong></div>${x.refundedMinor ? `<div class="row"><span>Refunded</span><strong>-${htmlEscape(money(x.refundedMinor))}</strong></div>` : ""}</div><p class="muted">This document reflects Cove's immutable order record. Stripe payment receipts remain available separately when a Stripe payment method was used.</p><p class="print muted">Use your browser’s Print command to print or save this invoice as PDF.</p></main></body></html>`;
}

export async function captureAuthorizedOrder(env: CoveEnv, orderId: string) {
  const o = await env.DB.prepare("SELECT * FROM commerce_orders WHERE id=?")
    .bind(orderId)
    .first<any>();
  if (!o || !o.stripe_payment_intent_id) throw new ApiError(404, "Authorized payment not found.");
  if (o.status !== "authorized") throw new ApiError(409, "This order is not awaiting capture.");
  const pi = await stripeRequest(
    env,
    `payment_intents/${encodeURIComponent(o.stripe_payment_intent_id)}/capture`,
    { idempotencyKey: `fore-capture-${orderId}` },
  );
  if (pi.status === "succeeded")
    await finalizePaidOrder(env, orderId, {
      provider: "stripe",
      paymentIntentId: pi.id,
      chargeId: typeof pi.latest_charge === "string" ? pi.latest_charge : null,
      receiptUrl: null,
    });
  return { orderId, status: pi.status };
}

type RefundIntent = {
  id: string;
  order_id: string;
  status: string;
  reason: string;
  idempotency_key: string;
  provider_refund_id: string | null;
  succeeded_at: string | null;
  amount_minor: number;
  stripe_amount_minor: number;
  gift_card_amount_minor: number;
  store_credit_amount_minor: number;
};
type RefundOrder = {
  id: string;
  status: string;
  currency: string;
  stripe_payment_intent_id: string | null;
};

export async function refundOrder(env: CoveEnv, raw: unknown) {
  // Owner-disabled production MUST stop before any Stripe API call or refund
  // intent mutation. Zero production refunds does not authorize a split
  // provider/ledger transaction; an owner outage must never be best-effort.
  if (env.COVE_LEGAL_CONSUMER_STAGE_ENABLED !== "1")
    throw new ApiError(503, "Refunds require the private financial owner.");
  const input = z
      .object({
        orderId: z.string().min(8).max(120),
        amountMinor: z.number().int().positive().optional(),
        reason: z.string().max(500).default("requested_by_customer"),
        idempotencyKey: z.string().min(16).max(200),
      })
      .parse(raw),
    db = env.DB;
  if (env.COVE_LEGAL_CONSUMER_STAGE_ENABLED === "1") {
    // Enrolled requests never write a refund intent through caller-owned D1.
    // The owner atomically reserves the original tender and returns a strictly
    // verified receipt before the caller may contact Stripe.
    const ack = await reserveStageOwnerRefundIntent(env, input);
    const intent = await db
      .prepare("SELECT * FROM commerce_refunds WHERE id=?")
      .bind(ack.refundId)
      .first<RefundIntent>();
    if (
      !intent ||
      intent.id !== ack.refundId ||
      intent.order_id !== input.orderId ||
      intent.idempotency_key !== input.idempotencyKey ||
      intent.reason !== input.reason ||
      Number(intent.amount_minor) !== ack.amountMinor ||
      Number(intent.stripe_amount_minor) !== ack.stripeAmountMinor ||
      Number(intent.gift_card_amount_minor) !== ack.giftCardAmountMinor ||
      Number(intent.store_credit_amount_minor) !== ack.storeCreditAmountMinor
    )
      throw new ApiError(503, "Canonical refund reservation projection does not match the owner.");
    const order = await db
      .prepare("SELECT * FROM commerce_orders WHERE id=?")
      .bind(intent.order_id)
      .first<RefundOrder>();
    if (!order) throw new ApiError(503, "Canonical refund order is unavailable.");
    if (intent.succeeded_at) {
      await applyRefundSuccess(env, intent.id, null);
      return refundResponse(intent);
    }
    if (!["pending", "succeeded"].includes(intent.status)) return refundResponse(intent);
    return completeRequestedRefund(env, order, intent);
  }
  throw new ApiError(503, "Refunds require the private financial owner.");
}

function refundResponse(refund: RefundIntent) {
  return {
    id: refund.id,
    providerRefundId: refund.provider_refund_id || null,
    status: refund.status,
    amountMinor: Number(refund.amount_minor),
    stripeAmountMinor: Number(refund.stripe_amount_minor || 0),
    giftCardAmountMinor: Number(refund.gift_card_amount_minor || 0),
    storeCreditAmountMinor: Number(refund.store_credit_amount_minor || 0),
  };
}

// Stripe API responses and verified signed webhook events share a single
// strict provider evidence envelope. The enrolled owner validates it against
// canonical tender, payment-intent and immutable refund IDs before persisting.
async function recordOwnerStripeRefundReceipt(
  env: CoveEnv,
  orderId: string,
  refundId: string,
  refund: any,
) {
  const paymentIntent =
    typeof refund?.payment_intent === "string"
      ? refund.payment_intent
      : refund?.payment_intent?.id || "";
  await recordStageOwnerRefundProvider(env, {
    orderId,
    refundId,
    providerRefundId: String(refund?.id || ""),
    paymentIntentId: String(paymentIntent),
    amountMinor: Number(refund?.amount),
    currency: String(refund?.currency || "").toUpperCase(),
    status: refund?.status,
  });
}

async function completeRequestedRefund(env: CoveEnv, o: RefundOrder, intent: RefundIntent) {
  if (env.COVE_LEGAL_CONSUMER_STAGE_ENABLED !== "1")
    throw new ApiError(503, "Refund completion requires the private commerce owner.");
  const db = env.DB,
    id = String(intent.id),
    amount = Number(intent.amount_minor),
    stripeAmount = Number(intent.stripe_amount_minor || 0),
    giftAmount = Number(intent.gift_card_amount_minor || 0),
    storeAmount = Number(intent.store_credit_amount_minor || 0),
    reason = String(intent.reason || "requested_by_customer");
  if (
    String(intent.order_id) !== String(o.id) ||
    !["paid", "partially_refunded", "disputed", "refunded", "chargeback_lost"].includes(o.status)
  )
    throw new ApiError(409, "Refund recovery does not match its original order.");
  // With the private owner enabled, deny buyer access BEFORE contacting
  // Stripe for an external refund. Replaying the same refund ID is safe.
  await stageRevokeRefundEntitlements(env, String(o.id), id);
  if (stripeAmount === 0) {
    await applyRefundSuccess(env, id, { id: `internal_${id}` });
    return {
      id,
      providerRefundId: null,
      status: "succeeded",
      amountMinor: amount,
      stripeAmountMinor: 0,
      giftCardAmountMinor: giftAmount,
      storeCreditAmountMinor: storeAmount,
    };
  }
  try {
    // If Stripe already accepted the refund, read that exact provider
    // object. Otherwise retry creation with the ORIGINAL idempotency key;
    // a lost provider response cannot produce a second external refund.
    const refund = intent.provider_refund_id
      ? await stripeRequest(
          env,
          `refunds/${encodeURIComponent(String(intent.provider_refund_id))}`,
          {
            method: "GET",
          },
        )
      : await stripeRequest(env, "refunds", {
          idempotencyKey: String(intent.idempotency_key),
          params: {
            payment_intent: o.stripe_payment_intent_id,
            amount: stripeAmount,
            reason: ["duplicate", "fraudulent", "requested_by_customer"].includes(reason)
              ? reason
              : "requested_by_customer",
            metadata: { fore_order_id: o.id, fore_refund_id: id, fore_total_refund_minor: amount },
          },
        });
    await recordOwnerStripeRefundReceipt(env, String(o.id), id, refund);
    if (refund.status === "succeeded") await applyRefundSuccess(env, id, refund);
    return {
      id,
      providerRefundId: refund.id,
      status: refund.status,
      amountMinor: amount,
      stripeAmountMinor: stripeAmount,
      giftCardAmountMinor: giftAmount,
      storeCreditAmountMinor: storeAmount,
    };
  } catch (e) {
    // A transport or reconciliation failure does not prove the provider
    // rejected the refund. Retain its tender reservation until retry can
    // reconcile the same key; a second request cannot spend that budget.
    // The enrolled owner is the only writer of provider state. Its
    // interrupted request must never fall back to caller-owned D1 SQL.
    // Owner retains pending reservation on loss of provider receipt.
    throw e;
  }
}

async function stageRevokeRefundEntitlements(env: CoveEnv, orderId: string, refundId: string) {
  await revokePaidOrderAccess(env, orderId, refundId);
}

async function applyRefundSuccess(env: CoveEnv, refundId: string, refundPayload: any) {
  if (env.COVE_LEGAL_CONSUMER_STAGE_ENABLED !== "1")
    throw new ApiError(503, "Refund accounting requires the private commerce owner.");
  const db = env.DB,
    r = await db.prepare("SELECT * FROM commerce_refunds WHERE id=?").bind(refundId).first<any>();
  if (!r) return;
  const o = await db
    .prepare("SELECT * FROM commerce_orders WHERE id=?")
    .bind(r.order_id)
    .first<any>();
  if (!o) throw new ApiError(404, "Refund order not found.");
  const at = now(),
    previousRefunded = Number(o.refunded_minor || 0),
    refundAmount = Number(r.amount_minor),
    newRefunded = r.succeeded_at
      ? previousRefunded
      : Math.min(Number(o.total_minor), previousRefunded + refundAmount),
    full = newRefunded >= Number(o.total_minor);
  // Stripe's refund is not acknowledged as canonical until the private
  // owner has tombstoned every affected paid entitlement. Partial external
  // refunds deny the entire order in this staged proof until item-scoped
  // owner revocation is implemented.
  if (full || env.COVE_LEGAL_CONSUMER_STAGE_ENABLED === "1")
    await stageRevokeRefundEntitlements(env, String(o.id), refundId);
  await postStageOwnerRefundAccounting(env, String(o.id), refundId);
  const refundItems = await db
    .prepare(
      "SELECT id,product_id,total_minor,source_surface,source_request_id FROM commerce_order_items WHERE order_id=? ORDER BY id",
    )
    .bind(o.id)
    .all<any>();
  const refundShares = moneySplit(
    refundAmount,
    refundItems.results.map((item: any) => Math.max(0, Number(item.total_minor || 0))),
  );
  for (let i = 0; i < refundItems.results.length; i++) {
    const item = refundItems.results[i],
      share = refundShares[i] || 0;
    if (share <= 0) continue;
    await recordRetailEvent(db, o.user_id, {
      eventType: "refund_completed",
      productId: String(item.product_id),
      sourceSurface: String(item.source_surface || "refund"),
      sourceRequestId: item.source_request_id || null,
      territory: String(o.territory_code || "US"),
      currency: String(o.currency),
      amountMinor: -share,
      quantity: -1,
      properties: { orderId: o.id, orderItemId: item.id, refundId: r.id, fullOrderRefund: full },
      dedupeKey: `refund:${r.id}:${item.id}`,
    });
  }
  try {
    const ratio = Math.min(1, refundAmount / Math.max(1, Number(o.total_minor))),
      items = (
        await db
          .prepare(
            `SELECT oi.*,pd.promotion_amount_minor,pr.campaign_id pricing_campaign_id FROM commerce_order_items oi LEFT JOIN pricing_decisions pd ON pd.id=oi.pricing_decision_id LEFT JOIN promotions pr ON pr.id=pd.promotion_id WHERE oi.order_id=?`,
          )
          .bind(o.id)
          .all<any>()
      ).results;
    for (const item of items) {
      const maps = new Map<string, number>();
      if (item.promotion_campaign_id)
        maps.set(
          String(item.promotion_campaign_id),
          Math.round(
            (Number(item.publisher_discount_funding_minor || 0) +
              Number(item.fore_discount_funding_minor || 0)) *
              ratio,
          ),
        );
      if (item.pricing_campaign_id)
        maps.set(
          String(item.pricing_campaign_id),
          (maps.get(String(item.pricing_campaign_id)) || 0) +
            Math.round(Number(item.promotion_amount_minor || 0) * ratio),
        );
      for (const [campaignId, fundingMinor] of maps)
        await recordPromotionAttribution(db, {
          campaignId,
          productId: item.product_id,
          userId: o.user_id,
          eventType: "refund",
          orderId: o.id,
          orderItemId: item.id,
          amountMinor: Math.round(Number(item.total_minor || 0) * ratio),
          fundingMinor,
          currency: o.currency,
          sourceSurface: "refund",
          dedupeKey: `refund:${r.id}:${item.id}:${campaignId}`,
        });
    }
  } catch (e) {
    console.error("Promotion refund attribution failed", e);
  }
  if (o.stripe_tax_transaction_id && !r.tax_reversal_id && refundAmount > 0) {
    try {
      const rev = await stripeRequest(env, "tax/transactions/create_reversal", {
        idempotencyKey: `fore-tax-reversal-${r.id}`,
        params: {
          original_transaction: o.stripe_tax_transaction_id,
          mode: full ? "full" : "partial",
          reference: `${o.id}-${r.id}`,
          ...(full ? {} : { flat_amount: -refundAmount }),
          metadata: { fore_order_id: o.id, fore_refund_id: r.id },
        },
      });
      await db
        .prepare("UPDATE commerce_refunds SET tax_reversal_id=?,updated_at=? WHERE id=?")
        .bind(rev.id, now(), r.id)
        .run();
      await recordCustomerTaxReversal(db, r.id, String(rev.id), refundAmount, {
        mode: full ? "full" : "partial",
      });
    } catch (e) {
      console.error("Stripe Tax reversal failed", e);
    }
  }
}

function hexToBytes(hex: string) {
  if (hex.length % 2) return new Uint8Array();
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}
function constantEqual(a: Uint8Array, b: Uint8Array) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}
async function verifyStripeSignature(raw: string, header: string, secret: string) {
  const parts = header.split(",").map((x) => x.split("=")),
    timestamp = parts.find((x) => x[0] === "t")?.[1],
    signatures = parts.filter((x) => x[0] === "v1").map((x) => x[1]);
  if (!timestamp || !signatures.length) return false;
  const t = Number(timestamp);
  if (!Number.isFinite(t) || Math.abs(Date.now() / 1000 - t) > 300) return false;
  const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    ),
    sig = new Uint8Array(
      await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${timestamp}.${raw}`)),
    );
  return signatures.some((x) => constantEqual(sig, hexToBytes(x)));
}
async function boundedStripeWebhookText(request: Request): Promise<string> {
  // Public Stripe webhook ingress cannot trust Content-Length, so cap actual
  // streamed bytes BEFORE signature verification or JSON deserialization.
  const limit = 1_048_576;
  const declared = Number(request.headers.get("content-length") || 0);
  if (!Number.isSafeInteger(declared) || declared < 0 || declared > limit)
    throw new ApiError(413, "Stripe webhook payload exceeds the limit.");
  const reader = request.body?.getReader();
  if (!reader) throw new ApiError(400, "Stripe webhook payload is required.");
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > limit) {
        await reader.cancel();
        throw new ApiError(413, "Stripe webhook payload exceeds the limit.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

export async function stripeWebhook(env: CoveEnv, request: Request) {
  if (env.COVE_LEGAL_CONSUMER_STAGE_ENABLED !== "1")
    throw new ApiError(503, "Stripe webhook requires the private commerce owner.");
  const secret = String(env.STRIPE_WEBHOOK_SECRET || "");
  if (!secret || PLACEHOLDER_RE.test(secret))
    throw new ApiError(503, "Stripe webhook signing secret is not configured.");
  const raw = await boundedStripeWebhookText(request),
    signature = request.headers.get("stripe-signature") || "";
  if (!(await verifyStripeSignature(raw, signature, secret)))
    throw new ApiError(400, "Invalid Stripe webhook signature.");
  const event = JSON.parse(raw),
    db = env.DB,
    id = String(event.id || "");
  if (!id) throw new ApiError(400, "Stripe event ID missing.");
  const expectedLive = commerceConfig(env).livemode;
  if (Boolean(event.livemode) !== expectedLive)
    throw new ApiError(
      400,
      `Stripe webhook mode mismatch: expected ${expectedLive ? "live" : "test"} events.`,
    );
  const hash = await sha256(raw),
    at = now(),
    token = crypto.randomUUID();
  const leaseUntil = new Date(Date.now() + 5 * 60_000).toISOString();
  if (env.COVE_LEGAL_CONSUMER_STAGE_ENABLED === "1") {
    // A validated HMAC event cannot mutate the canonical journal using this
    // caller's D1 binding. The isolated owner leases, fences and completes
    // its event by immutable payload digest, event identity and lease token.
    // There is deliberately no fallback on an unavailable private owner.
    const claimed = await claimStageOwnerStripeWebhook(env, {
      eventId: id,
      eventType: String(event.type),
      livemode: Boolean(event.livemode),
      payloadSha256: hash,
    });
    if (claimed.duplicate) return { received: true, duplicate: true };
    if (!claimed.claimed || !claimed.token)
      throw new ApiError(503, "Canonical webhook claim was not acknowledged.");
    const completion = {
      eventId: id,
      payloadSha256: hash,
      token: claimed.token,
    };
    try {
      await processStripeEvent(env, event);
      await finishStageOwnerStripeWebhook(env, { ...completion, outcome: "processed" });
      return { received: true };
    } catch (error) {
      // The owner retains the failed event for replay with the same digest.
      // Failure to acknowledge is a 503, NEVER a caller-owned D1 update.
      await finishStageOwnerStripeWebhook(env, { ...completion, outcome: "failed" });
      throw error;
    }
  }
  throw new ApiError(503, "Stripe webhook requires the private commerce owner.");
}
async function orderFromPI(db: CatalogDB, pi: any) {
  const id = pi?.metadata?.fore_order_id;
  if (id) {
    const order = await db
      .prepare("SELECT * FROM commerce_orders WHERE id=?")
      .bind(id)
      .first<any>();
    // A signed Stripe event is not proof that its caller-controlled metadata
    // references the matching canonical order. Apply this identity invariant
    // to *every* PI event (processing, failed, canceled, captured, succeeded),
    // not just the final paid settlement handler. A mismatch is retryable and
    // never counted as a processed webhook or used to change another order.
    if (order && String(order.stripe_payment_intent_id || "") !== String(pi?.id || ""))
      throw new ApiError(409, "Stripe PaymentIntent does not match the canonical order.");
    return order;
  }
  if (pi?.id)
    return db
      .prepare("SELECT * FROM commerce_orders WHERE stripe_payment_intent_id=?")
      .bind(pi.id)
      .first<any>();
  return null;
}
// Signed Stripe events can arrive out of order. A stale failure/cancel event
// must not move a terminal buyer order backwards or release its reservations.
const PAYMENT_FAILURE_MUTABLE_STATES = new Set([
  "pending_payment",
  "processing",
  "authorized",
  "payment_failed",
]);
const PAYMENT_CANCEL_MUTABLE_STATES = new Set(PAYMENT_FAILURE_MUTABLE_STATES);
async function processStripeEvent(env: CoveEnv, event: any) {
  const db = env.DB,
    obj = event.data?.object || {},
    type = String(event.type || "");
  if (
    env.COVE_LEGAL_CONSUMER_STAGE_ENABLED === "1" &&
    [
      "payment_intent.amount_capturable_updated",
      "payment_intent.processing",
      "payment_intent.payment_failed",
      "payment_intent.canceled",
    ].includes(type)
  ) {
    // One typed owner command handles each non-settlement transition.
    // The owner rechecks exact order/Stripe-intent identity, terminal-state
    // immutability and atomic cancellation of reserved tender.
    const order = await orderFromPI(db, obj);
    if (!order) return;
    const state =
      type === "payment_intent.amount_capturable_updated"
        ? "authorized"
        : type === "payment_intent.payment_failed"
          ? "payment_failed"
          : type === "payment_intent.canceled"
            ? "canceled"
            : "processing";
    const ack = await updateStageOwnerPaymentState(env, {
      orderId: String(order.id),
      paymentIntentId: String(obj.id),
      state,
      failureCode: state === "payment_failed" ? String(obj.last_payment_error?.code || "") : null,
    });
    if (state === "payment_failed" && ack.applied) {
      try {
        await emitNotification(db, {
          userId: String(order.user_id),
          eventType: "payment_failed",
          dedupeKey: `payment-failed:${order.id}:${obj.id}`,
          title: "Payment failed",
          body: String(
            obj.last_payment_error?.message ||
              "Your payment method was declined or could not be charged.",
          ),
          urgency: "high",
          subjectType: "order",
          subjectId: order.id,
          actionUrl: `/checkout?order=${encodeURIComponent(order.id)}`,
          payload: {
            orderId: order.id,
            paymentIntentId: obj.id,
            errorCode: obj.last_payment_error?.code || null,
          },
        });
      } catch {
        // Notification delivery is best effort; the owner already persisted payment failure.
      }
    }
    return;
  }
  if (type === "payment_intent.succeeded") {
    const o = await orderFromPI(db, obj);
    // Never acknowledge a Cove-tagged captured payment as processed when its
    // canonical order has not become readable. Stripe can retry this event;
    // a 2xx would permanently lose the buyer's fulfillment trigger.
    if (!o && obj?.metadata?.fore_order_id)
      throw new ApiError(409, "Cove payment order not yet available. Retry delivery.");
    if (o) {
      if (
        obj.id !== o.stripe_payment_intent_id ||
        !Number.isSafeInteger(obj.amount_received) ||
        obj.amount_received !== Number(o.stripe_due_minor) ||
        String(obj.currency || "").toUpperCase() !== String(o.currency).toUpperCase()
      )
        throw new ApiError(
          409,
          "Stripe payment does not match the order's payment, amount and currency.",
        );

      let charge: any = null;
      if (obj.latest_charge) {
        try {
          charge = await stripeRequest(
            env,
            `charges/${encodeURIComponent(typeof obj.latest_charge === "string" ? obj.latest_charge : obj.latest_charge.id)}`,
            { method: "GET" },
          );
        } catch {}
      }
      if (charge?.outcome)
        await ingestStripeRiskSignal(db, o.id, charge, String(event.id || charge.id));
      await finalizePaidOrder(env, o.id, {
        provider: "stripe",
        paymentIntentId: obj.id,
        chargeId: charge?.id || (typeof obj.latest_charge === "string" ? obj.latest_charge : null),
        receiptUrl: charge?.receipt_url || null,
        paymentMethod: charge?.payment_method_details?.type || "Stripe",
      });
    }
  } else if (type === "charge.succeeded") {
    // Only the owner may settle a captured charge after Stripe verification.
    const pi = typeof obj.payment_intent === "string" ? obj.payment_intent : obj.payment_intent?.id;
    if (pi) {
      const order = await db.prepare("SELECT id FROM commerce_orders WHERE stripe_payment_intent_id=?").bind(pi).first<any>();
      if (order) await finalizePaidOrder(env, String(order.id), {
        provider: "stripe", paymentIntentId: String(pi), chargeId: String(obj.id), receiptUrl: obj.receipt_url || null,
      });
    }
  } else if (type === "invoice.paid" || type === "invoice.payment_succeeded") {
    const customer = typeof obj.customer === "string" ? obj.customer : obj.customer?.id,
      user = customer
        ? await db
            .prepare("SELECT user_id FROM commerce_customers WHERE stripe_customer_id=?")
            .bind(customer)
            .first<any>()
        : null;
    if (user?.user_id)
      try {
        await emitNotification(db, {
          userId: String(user.user_id),
          eventType: "subscription_billing",
          dedupeKey: `subscription-billing:${obj.id}`,
          title: "Subscription payment received",
          body: `Your Cove subscription payment of ${formatMinorCurrency(Number(obj.amount_paid || 0), String(obj.currency || "USD"))} was received.`,
          subjectType: "stripe_invoice",
          subjectId: String(obj.id),
          actionUrl: "/account",
          payload: {
            invoiceId: obj.id,
            subscriptionId:
              typeof obj.subscription === "string"
                ? obj.subscription
                : obj.subscription?.id || null,
            currency: String(obj.currency || "usd").toUpperCase(),
            amountPaidMinor: Number(obj.amount_paid || 0),
            periodStart: obj.period_start || null,
            periodEnd: obj.period_end || null,
          },
        });
      } catch (e) {
        console.error("Subscription billing notification enqueue failed", e);
      }
  } else if (type === "invoice.payment_failed") {
    const customer = typeof obj.customer === "string" ? obj.customer : obj.customer?.id,
      user = customer
        ? await db
            .prepare("SELECT user_id FROM commerce_customers WHERE stripe_customer_id=?")
            .bind(customer)
            .first<any>()
        : null;
    if (user?.user_id)
      try {
        await emitNotification(db, {
          userId: String(user.user_id),
          eventType: "payment_failed",
          dedupeKey: `subscription-payment-failed:${obj.id}:${Number(obj.attempt_count || 0)}`,
          title: "Subscription payment failed",
          body: "Cove could not collect your subscription payment. Update your billing method to avoid interruption.",
          urgency: "high",
          subjectType: "stripe_invoice",
          subjectId: String(obj.id),
          actionUrl: "/account",
          payload: {
            invoiceId: obj.id,
            subscriptionId:
              typeof obj.subscription === "string"
                ? obj.subscription
                : obj.subscription?.id || null,
            attemptCount: Number(obj.attempt_count || 0),
            nextPaymentAttempt: obj.next_payment_attempt || null,
          },
        });
      } catch (e) {
        console.error("Subscription payment-failure notification enqueue failed", e);
      }
  } else if (type === "refund.updated" || type === "refund.created") {
    const r = await db
      .prepare("SELECT * FROM commerce_refunds WHERE provider_refund_id=?")
      .bind(obj.id)
      .first<any>();
    if (r) {
      await recordOwnerStripeRefundReceipt(env, String(r.order_id), String(r.id), obj);
      if (obj.status === "succeeded") await applyRefundSuccess(env, r.id, obj);
    }
  } else if (type.startsWith("charge.dispute.")) {
    await syncDispute(db, obj, type, env);
  }
}
async function syncDispute(_db: CatalogDB, d: any, eventType: string, env: CoveEnv) {
  if (env.COVE_LEGAL_CONSUMER_STAGE_ENABLED !== "1")
    throw new ApiError(503, "Dispute resolution requires the private commerce owner.");
  if (!d || typeof d.id !== "string" || !/^dp_[a-zA-Z0-9_-]{4,150}$/.test(d.id))
    throw new ApiError(409, "Stripe dispute identity is invalid.");
  await syncStageOwnerStripeDispute(env, {
    disputeId: d.id,
    eventType: eventType as Parameters<typeof syncStageOwnerStripeDispute>[1]["eventType"],
  });
}

export async function createPromoCode(_db: CatalogDB, _raw: unknown) {
  throw new ApiError(503, "Promotion creation requires the private commerce owner.");
}
export async function issueGiftCard(_db: CatalogDB, _raw: unknown) {
  throw new ApiError(503, "Gift-card issuance requires the private commerce owner.");
}
export async function adjustStoreCredit(_db: CatalogDB, _raw: unknown) {
  throw new ApiError(503, "Store-credit adjustment requires the private commerce owner.");
}

export async function commerceAdminSnapshot(db: CatalogDB) {
  const [orders, refunds, disputes, reconciliation, promos, giftCards, ledgerImbalances] =
    await Promise.all([
      db
        .prepare(
          "SELECT id,invoice_number,status,currency,total_minor,stripe_due_minor,refunded_minor,risk_level,risk_score,created_at,paid_at FROM commerce_orders ORDER BY created_at DESC LIMIT 100",
        )
        .all<any>(),
      db
        .prepare(
          "SELECT id,order_id,provider_refund_id,amount_minor,stripe_amount_minor,gift_card_amount_minor,store_credit_amount_minor,currency,reason,status,created_at,succeeded_at FROM commerce_refunds ORDER BY created_at DESC LIMIT 100",
        )
        .all<any>(),
      db
        .prepare(
          "SELECT provider_dispute_id,order_id,amount_minor,currency,reason,status,evidence_due_at,created_at,updated_at FROM commerce_disputes ORDER BY updated_at DESC LIMIT 100",
        )
        .all<any>(),
      db
        .prepare("SELECT * FROM commerce_reconciliation_runs ORDER BY started_at DESC LIMIT 25")
        .all<any>(),
      db
        .prepare(
          "SELECT code_label,kind,value,currency,minimum_subtotal_minor,max_redemptions,max_per_user,redemptions,active,starts_at,ends_at FROM commerce_promo_codes ORDER BY updated_at DESC LIMIT 100",
        )
        .all<any>(),
      db
        .prepare(
          "SELECT last4,currency,original_balance_minor,balance_minor,status,expires_at,issued_by,created_at FROM commerce_gift_cards ORDER BY created_at DESC LIMIT 100",
        )
        .all<any>(),
      db
        .prepare(
          "SELECT order_id,currency,SUM(amount_minor) AS balance_minor,COUNT(*) AS entries,MAX(created_at) AS last_posted_at FROM commerce_ledger_entries WHERE order_id IS NOT NULL GROUP BY order_id,currency HAVING SUM(amount_minor)<>0 ORDER BY last_posted_at DESC LIMIT 100",
        )
        .all<any>(),
    ]);
  return {
    orders: orders.results,
    refunds: refunds.results,
    disputes: disputes.results,
    reconciliation: reconciliation.results,
    promos: promos.results,
    giftCards: giftCards.results,
    ledgerImbalances: ledgerImbalances.results,
  };
}

export async function reconcileStripe(env: CoveEnv, limit = 100) {
  if (env.COVE_LEGAL_CONSUMER_STAGE_ENABLED !== "1")
    throw new ApiError(503, "Stripe reconciliation requires the private commerce owner.");
  return reconcileStageOwnerStripe(env, limit);
}
/** An enrolled cron never writes any commerce or royalty row itself.
 * Its only writes are fixed, verified owner RPCs; all other legacy
 * reconciliation statements below remain production compatibility only. */
async function reconcileStageOwnerStripe(env: CoveEnv, limit: number) {
  const id = `recon_${crypto.randomUUID()}`,
    started = now(),
    bound = Math.max(1, Math.min(500, limit)),
    details: Array<Record<string, string>> = [];
  await recoverStageOwnerPaidSettlements(env, Math.min(25, bound));
  const rows = await env.DB.prepare(
    "SELECT id,user_id,status,stripe_payment_intent_id,updated_at,created_at FROM commerce_orders WHERE stripe_payment_intent_id IS NOT NULL ORDER BY updated_at DESC LIMIT ?",
  )
    .bind(bound)
    .all<{
      id: string;
      user_id: string;
      status: string;
      stripe_payment_intent_id: string;
      updated_at: string;
      created_at: string;
    }>();
  let mismatches = 0,
    repaired = 0;
  for (const o of rows.results) {
    try {
      const pi = await stripeRequest(
        env,
        `payment_intents/${encodeURIComponent(o.stripe_payment_intent_id)}`,
        { method: "GET", params: { expand: ["latest_charge.balance_transaction"] } },
      );
      // A settled order's fee/receipt/royalty reconciliation belongs to the
      // owner settlement outbox; NEVER to the scheduled caller's D1.
      if (
        ["paid", "partially_refunded", "refunded", "disputed", "chargeback_lost"].includes(o.status)
      ) {
        if (o.status === "paid") {
          await settleStageOwnerPaidOrder(env, String(o.id));
          repaired++;
          details.push({ orderId: String(o.id), action: "owner_settlement_reconciled" });
        }
        continue;
      }
      const stripePaid = pi.status === "succeeded";
      if (stripePaid) {
        mismatches++;
        // Owner independently verifies Stripe, each line's rights snapshot,
        // tender consumption and settlement publication.
        await finalizePaidOrder(env, String(o.id), {
          provider: "stripe",
          paymentIntentId: String(pi.id),
          chargeId: null,
          receiptUrl: null,
        });
        repaired++;
        details.push({ orderId: String(o.id), action: "owner_settlement_repaired" });
        continue;
      }
      const ageMs = Date.now() - Date.parse(String(o.updated_at || o.created_at || 0)),
        staleRecoverable =
          ["pending_payment", "payment_failed"].includes(o.status) &&
          ageMs > 24 * 60 * 60_000 &&
          [
            "requires_payment_method",
            "requires_confirmation",
            "requires_action",
            "canceled",
          ].includes(String(pi.status));
      if (staleRecoverable) {
        if (pi.status !== "canceled")
          await stripeRequest(
            env,
            `payment_intents/${encodeURIComponent(o.stripe_payment_intent_id)}/cancel`,
            {
              idempotencyKey: `fore-expire-${o.id}`,
              params: { cancellation_reason: "abandoned" },
            },
          );
        await cancelStageOwnerUnpaidCheckout(env, {
          orderId: String(o.id),
          userId: String(o.user_id),
          source: "reconciliation",
        });
        repaired++;
        details.push({ orderId: String(o.id), action: "owner_stale_checkout_canceled" });
      }
    } catch (error) {
      details.push({
        orderId: String(o.id).slice(0, 160),
        error: String((error as Error).message || error).slice(0, 200),
      });
    }
  }
  const finished = now();
  const reportDetails = details.slice(0, 100);
  await recordStageOwnerReconciliation(env, {
    runId: id,
    startedAt: started,
    finishedAt: finished,
    checked: rows.results.length,
    mismatches,
    repaired,
    details: reportDetails,
  });
  return { id, checked: rows.results.length, mismatches, repaired, details: reportDetails };
}

export async function accountingCsv(db: CatalogDB, from: string, to: string) {
  const rows = await db
      .prepare(
        "SELECT * FROM commerce_ledger_entries WHERE created_at>=? AND created_at<? ORDER BY created_at,id",
      )
      .bind(from, to)
      .all<any>(),
    headers = [
      "created_at",
      "order_id",
      "refund_id",
      "user_id",
      "entry_type",
      "account_code",
      "amount_minor",
      "currency",
      "external_reference",
      "metadata_json",
    ],
    escape = (v: any) => `"${String(v ?? "").replaceAll('"', '""')}"`;
  return [
    headers.join(","),
    ...rows.results.map((r) => headers.map((h) => escape(r[h])).join(",")),
  ].join("\n");
}

/**
 * Executes durable preorder-refund jobs through the same refund path used by customer service.
 * Jobs are leased before provider calls and completion is idempotently recorded back on the
 * preorder ledger. A provider failure requeues (or terminally fails) through the job policy.
 */
export async function processPreorderRefundJobs(env: CoveEnv, raw: unknown) {
  const input = z
    .object({
      workerId: z.string().min(3).max(120).default("fore-preorder-refund-worker"),
      limit: z.number().int().min(1).max(50).default(20),
      leaseSeconds: z.number().int().min(30).max(1800).default(300),
    })
    .parse(raw ?? {});
  const leased = await leasePreorderRefundJobs(env.DB, input);
  const results: Array<Record<string, unknown>> = [];
  for (const job of leased.jobs as any[]) {
    try {
      const refund = await refundOrder(env, {
        orderId: String(job.order_id),
        amountMinor: Number(job.amount_minor),
        reason: "requested_by_customer",
        idempotencyKey: `preorder-refund-${String(job.id)}-v1`,
      });
      await completePreorderRefundJob(env.DB, {
        jobId: String(job.id),
        leaseToken: String(job.lease_token),
        success: true,
        providerRefundId: refund.providerRefundId || null,
      });
      results.push({ jobId: job.id, status: "succeeded", refundId: refund.id });
    } catch (error) {
      const message = String((error as Error)?.message || error).slice(0, 2000);
      await completePreorderRefundJob(env.DB, {
        jobId: String(job.id),
        leaseToken: String(job.lease_token),
        success: false,
        error: message,
      });
      results.push({ jobId: job.id, status: "failed_or_requeued", error: message });
    }
  }
  return { leased: leased.jobs.length, results };
}

export async function createBillingPortal(env: CoveEnv, user: User, returnUrl: string) {
  const customer = await ensureStripeCustomer(env, user);
  const portal = await stripeRequest(env, "billing_portal/sessions", {
    params: { customer, return_url: returnUrl },
    idempotencyKey: `fore-billing-portal-${user.id}-${Math.floor(Date.now() / 60000)}`,
  });
  if (!portal?.url)
    throw new ApiError(502, "Stripe billing management is temporarily unavailable.");
  return { url: String(portal.url) };
}

export async function syncCustomerBillingMethods(env: CoveEnv, user: User) {
  const customer = await ensureStripeCustomer(env, user),
    db = env.DB,
    at = now();
  const cards = await stripeRequest(env, "payment_methods", {
    method: "GET",
    params: { customer, type: "card", limit: 100 },
  });
  const methods = Array.isArray(cards?.data) ? cards.data : [];
  for (const pm of methods) {
    const card = pm.card || {},
      billing = pm.billing_details || {};
    await db
      .prepare(
        `INSERT INTO account_billing_methods(id,user_id,provider,provider_customer_id,provider_payment_method_id,brand,last4,exp_month,exp_year,billing_name,is_default,status,created_at,updated_at) VALUES(?,?,'stripe',?,?,?,?,?,?,?,0,'active',?,?) ON CONFLICT(provider,provider_payment_method_id) DO UPDATE SET brand=excluded.brand,last4=excluded.last4,exp_month=excluded.exp_month,exp_year=excluded.exp_year,billing_name=excluded.billing_name,status='active',updated_at=excluded.updated_at`,
      )
      .bind(
        `bill_${crypto.randomUUID()}`,
        user.id,
        customer,
        pm.id,
        String(card.brand || ""),
        String(card.last4 || ""),
        card.exp_month ?? null,
        card.exp_year ?? null,
        String(billing.name || ""),
        at,
        at,
      )
      .run();
  }
  if (methods.length)
    await db
      .prepare(
        `UPDATE account_billing_methods SET status='detached',updated_at=? WHERE user_id=? AND provider='stripe' AND provider_payment_method_id NOT IN (${methods.map(() => "?").join(",")})`,
      )
      .bind(at, user.id, ...methods.map((m: any) => m.id))
      .run();
  else
    await db
      .prepare(
        "UPDATE account_billing_methods SET status='detached',updated_at=? WHERE user_id=? AND provider='stripe'",
      )
      .bind(at, user.id)
      .run();
  return { synced: methods.length };
}
