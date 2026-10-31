/* Canonical preorder writers moved to the short-leased private QA owner.
 * The public server has no direct preorder finance/access mutation path. */
import type {CatalogDB} from "./catalog-model.server";
import {ApiError} from "./service";
import {dispatchPrivatePreorderAction} from "../../storefront-strangler/publication-owner-routing.server";

async function member(db: CatalogDB, userId: string, accountId: string) {
  const row = await db
    .prepare(
      "SELECT role FROM publishing_account_members WHERE user_id=? AND account_id=? AND status='active'",
    )
    .bind(userId, accountId)
    .first<any>();
  if (!row) throw new ApiError(403, "You do not have access to this publishing account.");
  return row;
}

export async function ensurePreorderReleasePlan(db:CatalogDB,productId:string,actorUserId:string|null=null) {
 return dispatchPrivatePreorderAction(db,"ensure-plan",{productId,actorUserId});
}

export async function preorderPurchaseState(
  db: CatalogDB,
  userId: string | null,
  productId: string,
) {
  const product = await db
    .prepare(
      "SELECT p.id,e.release_status,e.release_date,e.preorder_date FROM products p JOIN editions e ON e.id=p.edition_id WHERE p.id=?",
    )
    .bind(productId)
    .first<any>();
  if (!product) throw new ApiError(404, "Product not found.");
  const releaseMs = product.release_date ? new Date(String(product.release_date)).getTime() : 0;
  const isPreorder =
    String(product.release_status) === "preorder" ||
    (Number.isFinite(releaseMs) && releaseMs > Date.now());
  if (!isPreorder)
    return { isPreorder: false, accepting: true, reason: null, plan: null, existing: null };
  const plan = await ensurePreorderReleasePlan(db, productId);
  const existing = userId
    ? await db
        .prepare(
          `SELECT po.*,rp.release_at,rp.opens_at,rp.price_guarantee_policy,rp.cancellation_policy
    FROM preorders po JOIN preorder_release_plans rp ON rp.id=po.release_plan_id
    WHERE po.user_id=? AND po.product_id=? AND po.status IN ('reserved','payment_pending','paid_pending_release','cancellation_requested')
    ORDER BY po.created_at DESC LIMIT 1`,
        )
        .bind(userId, productId)
        .first<any>()
    : null;
  if (!plan)
    return { isPreorder: true, accepting: false, reason: "not_configured", plan: null, existing };
  const opensMs = new Date(String(plan.opens_at)).getTime(),
    planReleaseMs = new Date(String(plan.release_at)).getTime();
  const status = String(plan.status);
  let reason: string | null = null;
  if (existing) reason = "already_preordered";
  else if (!Number.isFinite(opensMs) || opensMs > Date.now()) reason = "not_open";
  else if (!Number.isFinite(planReleaseMs) || planReleaseMs <= Date.now()) reason = "release_due";
  else if (!["open", "locked"].includes(status))
    reason = status === "scheduled" ? "not_open" : `plan_${status}`;
  return { isPreorder: true, accepting: reason === null, reason, plan, existing };
}

export async function assertPreorderPurchaseAllowed(
  db: CatalogDB,
  userId: string,
  productId: string,
) {
  const state = await preorderPurchaseState(db, userId, productId);
  if (!state.isPreorder) return state;
  if (state.existing)
    throw new ApiError(409, "You already have an active preorder for this title.");
  if (!state.plan) throw new ApiError(409, "This preorder is not configured for sale yet.");
  if (state.reason === "not_open")
    throw new ApiError(
      409,
      `Preorders open ${new Date(String(state.plan.opens_at)).toLocaleDateString()}.`,
    );
  if (!state.accepting) throw new ApiError(409, "This title is not accepting preorders right now.");
  return state;
}

export async function registerPaidPreorder(db:CatalogDB,input:{
 orderId:string;orderItemId:string;userId:string;productId:string;currency:string;chargedMinor:number
}) {
 return dispatchPrivatePreorderAction(db,"register-paid",{input});
}

export async function updatePreorderLowestPrice(db:CatalogDB,productId:string,reason="lowest_price_guarantee") {
 return dispatchPrivatePreorderAction(db,"update-lowest",{productId,reason});
}

export async function customerCancelPreorder(db:CatalogDB,userId:string,preorderId:string) {
 return dispatchPrivatePreorderAction(db,"customer-cancel",{userId,preorderId});
}

export async function publisherCancelReleasePlan(db:CatalogDB,userId:string,raw:unknown) {
 return dispatchPrivatePreorderAction(db,"publisher-cancel",{userId,input:raw});
}

export async function leasePreorderRefundJobs(db:CatalogDB,raw:unknown) {
 return dispatchPrivatePreorderAction(db,"lease-refunds",{input:raw});
}

export async function completePreorderRefundJob(db:CatalogDB,raw:unknown) {
 return dispatchPrivatePreorderAction(db,"complete-refund",{input:raw});
}

export async function advancePreorders(db:CatalogDB) {
 return dispatchPrivatePreorderAction(db,"advance",{});
}

export async function publisherPreorderDashboard(db: CatalogDB, userId: string, accountId: string) {
  await member(db, userId, accountId);
  const [plans, statuses, incidents] = await Promise.all([
    db
      .prepare(
        `SELECT rp.*,e.title publishing_title,(SELECT COUNT(*) FROM preorders po WHERE po.release_plan_id=rp.id) preorder_count,(SELECT COALESCE(SUM(po.guaranteed_price_minor),0) FROM preorders po WHERE po.release_plan_id=rp.id AND po.status NOT IN ('refunded','customer_canceled')) booked_minor
      FROM preorder_release_plans rp JOIN publishing_edition_drafts e ON e.id=rp.publishing_edition_id JOIN publishing_titles t ON t.id=e.title_id WHERE t.account_id=? ORDER BY rp.release_at DESC`,
      )
      .bind(accountId)
      .all<any>(),
    db
      .prepare(
        `SELECT po.status,COUNT(*) units,COALESCE(SUM(po.guaranteed_price_minor),0) value_minor,po.currency FROM preorders po JOIN preorder_release_plans rp ON rp.id=po.release_plan_id JOIN publishing_edition_drafts e ON e.id=rp.publishing_edition_id JOIN publishing_titles t ON t.id=e.title_id WHERE t.account_id=? GROUP BY po.status,po.currency`,
      )
      .bind(accountId)
      .all<any>(),
    db
      .prepare(
        "SELECT * FROM publishing_preorder_incidents WHERE publishing_account_id=? ORDER BY created_at DESC LIMIT 100",
      )
      .bind(accountId)
      .all<any>(),
  ]);
  return { plans: plans.results, statusSummary: statuses.results, incidents: incidents.results };
}

export async function customerPreorders(db: CatalogDB, userId: string) {
  const rows = (
    await db
      .prepare(
        `SELECT po.*,rp.release_at,rp.opens_at,rp.price_guarantee_policy,rp.cancellation_policy,e.title,p.format FROM preorders po JOIN preorder_release_plans rp ON rp.id=po.release_plan_id JOIN products p ON p.id=po.product_id JOIN editions e ON e.id=p.edition_id WHERE po.user_id=? ORDER BY po.created_at DESC LIMIT 250`,
      )
      .bind(userId)
      .all<any>()
  ).results;
  return { preorders: rows };
}
