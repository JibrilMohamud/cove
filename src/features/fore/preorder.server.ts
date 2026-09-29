import { z } from "zod";
import type { CatalogDB } from "./catalog-model.server";
import { ApiError } from "./service";
import { resolvePricingDecision } from "./pricing.server";
import { emitNotification } from "./notifications.server";
import { ensureOwnershipSnapshot } from "./delivery.server";

const now = () => new Date().toISOString();
const uid = (p: string) => `${p}_${crypto.randomUUID()}`;
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

type Actor = { type: "customer" | "publisher" | "staff" | "automation"; id?: string | null };

async function event(db: CatalogDB, preorderId: string, eventType: string, actor: Actor, payload: Record<string, unknown> = {}) {
  await db.prepare("INSERT INTO preorder_events(id,preorder_id,event_type,actor_type,actor_id,event_json,created_at) VALUES(?,?,?,?,?,?,?)")
    .bind(uid("poevt"), preorderId, eventType, actor.type, actor.id || null, JSON.stringify(payload), now()).run();
}

async function member(db: CatalogDB, userId: string, accountId: string) {
  const row = await db.prepare("SELECT role FROM publishing_account_members WHERE user_id=? AND account_id=? AND status='active'").bind(userId, accountId).first<any>();
  if (!row) throw new ApiError(403, "You do not have access to this publishing account.");
  return row;
}

async function activePolicy(db: CatalogDB) {
  const row = await db.prepare("SELECT * FROM preorder_policy_versions WHERE status='active' ORDER BY version DESC LIMIT 1").first<any>();
  if (!row) throw new ApiError(503, "No active preorder policy is configured.");
  return row;
}

/** Create or refresh the operational preorder plan from an approved Cove publication. */
export async function ensurePreorderReleasePlan(db: CatalogDB, productId: string, actorUserId: string | null = null) {
  const current = await db.prepare("SELECT * FROM preorder_release_plans WHERE product_id=? ORDER BY updated_at DESC LIMIT 1").bind(productId).first<any>();
  const source = await db.prepare(`SELECT p.id publication_id,p.publishing_account_id,s.edition_id publishing_edition_id,e.release_date,e.preorder_date,e.release_status
    FROM publishing_publications p
    JOIN publishing_submission_snapshots s ON s.id=p.submission_id
    JOIN editions e ON e.id=p.edition_id
    WHERE p.product_id=? ORDER BY p.published_at DESC LIMIT 1`).bind(productId).first<any>();
  if (!source?.release_date) return current || null;
  const releaseAt = new Date(String(source.release_date));
  if (!Number.isFinite(releaseAt.getTime()) || releaseAt.getTime() <= Date.now()) return current || null;
  const policy = await activePolicy(db);
  const openAt = source.preorder_date ? new Date(String(source.preorder_date)) : new Date();
  if (!Number.isFinite(openAt.getTime())) throw new ApiError(409, "The preorder opening date is invalid.");
  const horizon = releaseAt.getTime() - openAt.getTime();
  if (horizon > Number(policy.max_horizon_days) * DAY) throw new ApiError(409, `This preorder exceeds Cove's ${policy.max_horizon_days}-day maximum horizon.`);
  const deadline = new Date(releaseAt.getTime() - Number(policy.manuscript_lead_hours) * HOUR).toISOString();
  const status = openAt.getTime() <= Date.now() ? "open" : "scheduled";
  const rules = (() => { try { return JSON.parse(String(policy.rules_json || "{}")); } catch { return {}; } })();
  const paymentTiming = rules.paymentTiming === "charge_at_release" ? "charge_at_release" : "charge_now";
  // Deferred capture needs a separately tokenized payment-method vault; do not silently pretend it exists.
  if (paymentTiming === "charge_at_release") throw new ApiError(503, "The active preorder policy requires charge-at-release, but deferred payment vaulting is not enabled on this deployment.");
  const id = current?.id || uid("poplan");
  if (current) {
    const changedRelease=String(current.release_at)!==releaseAt.toISOString()||String(current.manuscript_deadline_at)!==deadline;
    if(changedRelease){const affected=Number((await db.prepare("SELECT COUNT(*) n FROM preorders WHERE release_plan_id=? AND status IN ('paid_pending_release','cancellation_requested')").bind(current.id).first<any>())?.n||0);if(affected>0){const at=now();await db.prepare("INSERT INTO preorder_release_changes(id,release_plan_id,previous_release_at,new_release_at,previous_manuscript_deadline_at,new_manuscript_deadline_at,reason,actor_type,actor_id,affected_preorders,created_at) VALUES(?,?,?,?,?,?,?,'automation',?,?,?)").bind(uid("poreleasechg"),current.id,current.release_at,releaseAt.toISOString(),current.manuscript_deadline_at,deadline,"Approved publication revision changed the release schedule.",actorUserId,affected,at).run();await db.prepare("INSERT INTO publishing_outbox(id,event_type,aggregate_type,aggregate_id,payload_json,status,attempts,available_at,created_at) VALUES(?, 'preorder.release_date_changed','preorder_release_plan',?,?,'pending',0,?,?)").bind(uid("out"),current.id,JSON.stringify({releasePlanId:current.id,previousReleaseAt:current.release_at,newReleaseAt:releaseAt.toISOString(),affectedPreorders:affected}),at,at).run();if(new Date(String(current.release_at)).getTime()<releaseAt.getTime()){const acct=await db.prepare(`SELECT t.account_id FROM publishing_edition_drafts e JOIN publishing_titles t ON t.id=e.title_id WHERE e.id=?`).bind(current.publishing_edition_id).first<any>();if(acct)await db.prepare("INSERT INTO publishing_preorder_incidents(id,publishing_account_id,release_plan_id,incident_type,severity,preorder_count,status,notes,created_at) VALUES(?,?,?,'release_delay',? ,?,'open','Approved release date moved later after customer preorders existed.',?)").bind(uid("poincident"),acct.account_id,current.id,affected>=25?"restriction":"warning",affected,at).run();}}}
    await db.prepare(`UPDATE preorder_release_plans SET publication_id=?,opens_at=?,release_at=?,manuscript_deadline_at=?,payment_timing=?,price_guarantee_policy=?,policy_version_id=?,status=CASE WHEN status IN ('released','canceled','failed') THEN status ELSE ? END,updated_at=? WHERE id=?`)
      .bind(source.publication_id, openAt.toISOString(), releaseAt.toISOString(), deadline, paymentTiming, rules.priceGuarantee === "none" ? "none" : "lowest_price",policy.id,status, now(), id).run();
  } else {
    const at = now();
    await db.prepare(`INSERT INTO preorder_release_plans(id,publishing_edition_id,product_id,publication_id,opens_at,release_at,manuscript_deadline_at,payment_timing,price_guarantee_policy,cancellation_policy,failure_policy,status,created_by_user_id,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,'customer_until_release','auto_refund_and_penalty',?,?,?,?)`)
      .bind(id, source.publishing_edition_id, productId, source.publication_id, openAt.toISOString(), releaseAt.toISOString(), deadline, paymentTiming, rules.priceGuarantee === "none" ? "none" : "lowest_price", status, actorUserId, at, at).run();
    await db.prepare("UPDATE preorder_release_plans SET policy_version_id=? WHERE id=?").bind(policy.id,id).run();
  }
  return db.prepare("SELECT * FROM preorder_release_plans WHERE id=?").bind(id).first<any>();
}


export async function preorderPurchaseState(db: CatalogDB, userId: string | null, productId: string) {
  const product = await db.prepare("SELECT p.id,e.release_status,e.release_date,e.preorder_date FROM products p JOIN editions e ON e.id=p.edition_id WHERE p.id=?").bind(productId).first<any>();
  if (!product) throw new ApiError(404, "Product not found.");
  const releaseMs = product.release_date ? new Date(String(product.release_date)).getTime() : 0;
  const isPreorder = String(product.release_status) === "preorder" || (Number.isFinite(releaseMs) && releaseMs > Date.now());
  if (!isPreorder) return { isPreorder:false, accepting:true, reason:null, plan:null, existing:null };
  const plan = await ensurePreorderReleasePlan(db, productId);
  const existing = userId ? await db.prepare(`SELECT po.*,rp.release_at,rp.opens_at,rp.price_guarantee_policy,rp.cancellation_policy
    FROM preorders po JOIN preorder_release_plans rp ON rp.id=po.release_plan_id
    WHERE po.user_id=? AND po.product_id=? AND po.status IN ('reserved','payment_pending','paid_pending_release','cancellation_requested')
    ORDER BY po.created_at DESC LIMIT 1`).bind(userId,productId).first<any>() : null;
  if (!plan) return { isPreorder:true, accepting:false, reason:"not_configured", plan:null, existing };
  const opensMs = new Date(String(plan.opens_at)).getTime(), planReleaseMs = new Date(String(plan.release_at)).getTime();
  const status = String(plan.status);
  let reason:string|null = null;
  if (existing) reason = "already_preordered";
  else if (!Number.isFinite(opensMs) || opensMs > Date.now()) reason = "not_open";
  else if (!Number.isFinite(planReleaseMs) || planReleaseMs <= Date.now()) reason = "release_due";
  else if (!["open","locked"].includes(status)) reason = status === "scheduled" ? "not_open" : `plan_${status}`;
  return { isPreorder:true, accepting:reason===null, reason, plan, existing };
}

export async function assertPreorderPurchaseAllowed(db: CatalogDB, userId: string, productId: string) {
  const state = await preorderPurchaseState(db,userId,productId);
  if (!state.isPreorder) return state;
  if (state.existing) throw new ApiError(409,"You already have an active preorder for this title.");
  if (!state.plan) throw new ApiError(409,"This preorder is not configured for sale yet.");
  if (state.reason === "not_open") throw new ApiError(409,`Preorders open ${new Date(String(state.plan.opens_at)).toLocaleDateString()}.`);
  if (!state.accepting) throw new ApiError(409,"This title is not accepting preorders right now.");
  return state;
}

export async function registerPaidPreorder(db: CatalogDB, input: { orderId: string; orderItemId: string; userId: string; productId: string; currency: string; chargedMinor: number }) {
  const existing = await db.prepare("SELECT * FROM preorders WHERE order_item_id=?").bind(input.orderItemId).first<any>();
  if (existing) return existing;
  const duplicate = await db.prepare("SELECT * FROM preorders WHERE user_id=? AND product_id=? AND status IN ('reserved','payment_pending','paid_pending_release','cancellation_requested') ORDER BY created_at DESC LIMIT 1").bind(input.userId,input.productId).first<any>();
  if (duplicate) throw new ApiError(409,"This customer already has an active preorder for this title.");
  const product = await db.prepare("SELECT p.*,e.release_status,e.release_date,e.preorder_date FROM products p JOIN editions e ON e.id=p.edition_id WHERE p.id=?").bind(input.productId).first<any>();
  if (!product) throw new ApiError(404, "Product not found.");
  const future = product.release_date && new Date(String(product.release_date)).getTime() > Date.now();
  if (String(product.release_status) !== "preorder" && !future) return null;
  const plan = await ensurePreorderReleasePlan(db, input.productId);
  if (!plan || !["open", "scheduled", "locked"].includes(String(plan.status))) throw new ApiError(409, "This title is not accepting preorders.");
  if (new Date(String(plan.opens_at)).getTime() > Date.now()) throw new ApiError(409, "This preorder has not opened yet.");
  if (String(plan.payment_timing) !== "charge_now") throw new ApiError(503, "This preorder uses a payment mode that is not enabled.");
  const at = now(), preorderId = uid("preorder"), charged = Math.max(0, Math.round(input.chargedMinor));
  await db.prepare(`INSERT INTO preorders(id,release_plan_id,order_item_id,order_id,user_id,product_id,currency,original_price_minor,guaranteed_price_minor,charged_minor,payment_timing,status,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,'paid_pending_release',?,?)`).bind(preorderId, plan.id, input.orderItemId, input.orderId, input.userId, input.productId, input.currency.toUpperCase(), charged, charged, charged, plan.payment_timing, at, at).run();
  await db.prepare("UPDATE commerce_order_items SET fulfillment_type='preorder',fulfillment_status='pending_release',preorder_id=?,entitlement_status='pending' WHERE id=?").bind(preorderId, input.orderItemId).run();
  await event(db, preorderId, "paid_and_reserved", { type: "customer", id: input.userId }, { releaseAt: plan.release_at, chargedMinor: charged, currency: input.currency.toUpperCase() });
  await db.prepare("INSERT INTO publishing_outbox(id,event_type,aggregate_type,aggregate_id,payload_json,status,attempts,available_at,created_at) VALUES(?, 'preorder.confirmed','preorder',?,?,'pending',0,?,?)")
    .bind(uid("out"), preorderId, JSON.stringify({ preorderId, orderId: input.orderId, productId: input.productId, userId: input.userId, releaseAt: plan.release_at }), at, at).run();
  return db.prepare("SELECT * FROM preorders WHERE id=?").bind(preorderId).first<any>();
}

async function grantReleaseEntitlement(db: CatalogDB, preorder: any) {
  const at = now();
  const entId = uid("ent");
  await db.prepare(`INSERT INTO entitlements(id,user_id,product_id,entitlement_type,status,source,order_item_id,granted_at,updated_at)
    VALUES(?,?,?,'purchase','active','preorder',?,?,?)
    ON CONFLICT(user_id,product_id,entitlement_type) DO UPDATE SET status='active',order_item_id=excluded.order_item_id,updated_at=excluded.updated_at`)
    .bind(entId, preorder.user_id, preorder.product_id, preorder.order_item_id, at, at).run();
  const entitlement = await db.prepare("SELECT id FROM entitlements WHERE user_id=? AND product_id=? AND entitlement_type='purchase'").bind(preorder.user_id, preorder.product_id).first<any>();
  const product = await db.prepare("SELECT source_external_id FROM products WHERE id=?").bind(preorder.product_id).first<any>();
  if (product) await db.prepare(`INSERT INTO reading_states(user_id,product_id,external_book_id,in_library,status,progress,cfi,updated_at)
    VALUES(?,?,?,1,'want-to-read',0,COALESCE((SELECT cfi FROM preview_states WHERE user_id=? AND product_id=?),''),?)
    ON CONFLICT(user_id,product_id) DO UPDATE SET in_library=1,cfi=CASE WHEN reading_states.cfi='' THEN excluded.cfi ELSE reading_states.cfi END,updated_at=excluded.updated_at`)
    .bind(preorder.user_id, preorder.product_id, product.source_external_id, preorder.user_id, preorder.product_id, at).run();
  const lifecycle = await db.prepare(`SELECT l.id,l.owner_update_policy,l.current_publication_version_id FROM publishing_release_lifecycles l
    JOIN publishing_publication_versions pv ON pv.id=l.current_publication_version_id
    JOIN publishing_publications p ON p.id=pv.publication_id WHERE p.product_id=? LIMIT 1`).bind(preorder.product_id).first<any>();
  if (entitlement?.id && lifecycle?.current_publication_version_id && lifecycle.owner_update_policy !== "auto_update") {
    await db.prepare(`INSERT OR IGNORE INTO publishing_entitlement_version_pins(entitlement_id,lifecycle_id,publication_version_id,policy_at_grant,pinned_at,updated_at) VALUES(?,?,?,?,?,?)`)
      .bind(entitlement.id, lifecycle.id, lifecycle.current_publication_version_id, lifecycle.owner_update_policy, at, at).run();
    await db.prepare(`INSERT INTO publishing_owner_version_events(id,entitlement_id,lifecycle_id,from_publication_version_id,to_publication_version_id,action,actor_user_id,created_at)
      SELECT ?,?,?,?,?, 'grant_pin',?,? WHERE NOT EXISTS(SELECT 1 FROM publishing_owner_version_events WHERE entitlement_id=? AND action='grant_pin')`)
      .bind(uid("ownevt"), entitlement.id, lifecycle.id, null, lifecycle.current_publication_version_id, preorder.user_id, at, entitlement.id).run();
  }
  await ensureOwnershipSnapshot(db,String(preorder.user_id),String(preorder.product_id));
  await db.prepare("UPDATE commerce_order_items SET entitlement_status='granted',fulfillment_status='fulfilled' WHERE id=?").bind(preorder.order_item_id).run();
  await db.prepare("UPDATE preorders SET status='released',entitlement_id=?,released_at=?,updated_at=? WHERE id=? AND status='paid_pending_release'").bind(entitlement?.id || entId, at, at, preorder.id).run();
  await event(db, preorder.id, "released", { type: "automation" }, { entitlementId: entitlement?.id || entId });
  await db.prepare("INSERT INTO publishing_outbox(id,event_type,aggregate_type,aggregate_id,payload_json,status,attempts,available_at,created_at) VALUES(?, 'preorder.released','preorder',?,?,'pending',0,?,?)")
    .bind(uid("out"), preorder.id, JSON.stringify({ preorderId: preorder.id, userId: preorder.user_id, productId: preorder.product_id }), at, at).run();
  try{const product=await db.prepare("SELECT e.title,p.source_external_id FROM products p JOIN editions e ON e.id=p.edition_id WHERE p.id=?").bind(preorder.product_id).first<any>();await emitNotification(db,{userId:String(preorder.user_id),eventType:"preorder_released",dedupeKey:`preorder-released:${preorder.id}`,title:`Preorder released: ${product?.title||"Your book"}`,body:"Your preorder is now available in your Cove library.",productId:String(preorder.product_id),subjectType:"preorder",subjectId:String(preorder.id),actionUrl:product?.source_external_id?`/book/${encodeURIComponent(product.source_external_id)}`:"/library",payload:{preorderId:preorder.id,productId:preorder.product_id}});}catch(e){console.error("Preorder release notification enqueue failed",e);}
}

export async function updatePreorderLowestPrice(db: CatalogDB, productId: string, reason = "lowest_price_guarantee") {
  const rows = (await db.prepare(`SELECT po.*,rp.price_guarantee_policy FROM preorders po JOIN preorder_release_plans rp ON rp.id=po.release_plan_id
    WHERE po.product_id=? AND po.status='paid_pending_release' AND rp.price_guarantee_policy='lowest_price'`).bind(productId).all<any>()).results;
  let adjusted = 0;
  for (const po of rows) {
    const decision = await resolvePricingDecision(db, productId, "US", { userId: po.user_id, persist: false });
    if (!decision || String(decision.currency).toUpperCase() !== String(po.currency).toUpperCase()) continue;
    const next = Math.max(0, Number(decision.amountMinor));
    const previous = Number(po.guaranteed_price_minor);
    if (next >= previous) continue;
    const delta = previous - next, at = now(), jobId = uid("porefund");
    await db.prepare("INSERT INTO preorder_refund_jobs(id,preorder_id,order_id,amount_minor,currency,reason,status,attempt_count,created_at,updated_at) VALUES(?,?,?,?,?,?,'queued',0,?,?)")
      .bind(jobId, po.id, po.order_id, delta, po.currency, "preorder_price_guarantee", at, at).run();
    await db.prepare("INSERT INTO preorder_price_adjustments(id,preorder_id,previous_guaranteed_minor,new_guaranteed_minor,adjustment_minor,reason,refund_job_id,created_at) VALUES(?,?,?,?,?,?,?,?)")
      .bind(uid("poadj"), po.id, previous, next, delta, reason, jobId, at).run();
    await db.prepare("UPDATE preorders SET guaranteed_price_minor=?,updated_at=? WHERE id=?").bind(next, at, po.id).run();
    await event(db, po.id, "price_guarantee_lowered", { type: "automation" }, { previousMinor: previous, newMinor: next, refundMinor: delta, refundJobId: jobId });
    adjusted++;
  }
  return { productId, adjusted };
}

export async function customerCancelPreorder(db: CatalogDB, userId: string, preorderId: string) {
  const po = await db.prepare(`SELECT po.*,rp.release_at,rp.cancellation_policy FROM preorders po JOIN preorder_release_plans rp ON rp.id=po.release_plan_id WHERE po.id=? AND po.user_id=?`).bind(preorderId, userId).first<any>();
  if (!po) throw new ApiError(404, "Preorder not found.");
  if (["customer_canceled", "refunded"].includes(po.status)) return { preorderId, status: po.status };
  if (po.status !== "paid_pending_release") throw new ApiError(409, "This preorder can no longer be canceled.");
  if (String(po.cancellation_policy) !== "customer_until_release" || new Date(String(po.release_at)).getTime() <= Date.now()) throw new ApiError(409, "The cancellation window has closed.");
  const at = now(), jobId = uid("porefund"), amount = Number(po.guaranteed_price_minor);
  await db.prepare("UPDATE preorders SET status='cancellation_requested',canceled_at=?,updated_at=? WHERE id=?").bind(at, at, po.id).run();
  await db.prepare("INSERT INTO preorder_refund_jobs(id,preorder_id,order_id,amount_minor,currency,reason,status,attempt_count,created_at,updated_at) VALUES(?,?,?,?,?,'customer_preorder_cancellation','queued',0,?,?)")
    .bind(jobId, po.id, po.order_id, amount, po.currency, at, at).run();
  await event(db, po.id, "cancellation_requested", { type: "customer", id: userId }, { refundJobId: jobId, amountMinor: amount });
  return { preorderId, status: "cancellation_requested", refundJobId: jobId };
}

export async function publisherCancelReleasePlan(db: CatalogDB, userId: string, raw: unknown) {
  const x = z.object({ accountId: z.string().min(1), releasePlanId: z.string().min(1), reason: z.string().trim().min(3).max(1000) }).parse(raw);
  await member(db, userId, x.accountId);
  const plan = await db.prepare(`SELECT rp.*,t.account_id FROM preorder_release_plans rp JOIN publishing_edition_drafts e ON e.id=rp.publishing_edition_id JOIN publishing_titles t ON t.id=e.title_id WHERE rp.id=?`).bind(x.releasePlanId).first<any>();
  if (!plan || plan.account_id !== x.accountId) throw new ApiError(404, "Preorder release plan not found.");
  if (["released", "canceled", "failed"].includes(plan.status)) throw new ApiError(409, "This release plan is already closed.");
  const preorders = (await db.prepare("SELECT * FROM preorders WHERE release_plan_id=? AND status IN ('paid_pending_release','cancellation_requested')").bind(plan.id).all<any>()).results;
  const at = now();
  await db.prepare("UPDATE preorder_release_plans SET status='canceled',updated_at=? WHERE id=?").bind(at, plan.id).run();
  for (const po of preorders) {
    const amount = Number(po.guaranteed_price_minor), jobId = uid("porefund");
    await db.prepare("UPDATE preorders SET status='publisher_canceled',canceled_at=?,updated_at=? WHERE id=?").bind(at, at, po.id).run();
    await db.prepare("INSERT INTO preorder_refund_jobs(id,preorder_id,order_id,amount_minor,currency,reason,status,attempt_count,created_at,updated_at) VALUES(?,?,?,?,?,'publisher_preorder_cancellation','queued',0,?,?)")
      .bind(jobId, po.id, po.order_id, amount, po.currency, at, at).run();
    await event(db, po.id, "publisher_canceled", { type: "publisher", id: userId }, { reason: x.reason, refundJobId: jobId, amountMinor: amount });
  }
  await db.prepare("INSERT INTO publishing_preorder_incidents(id,publishing_account_id,release_plan_id,incident_type,severity,preorder_count,status,notes,created_at) VALUES(?,?,?,'publisher_cancellation',? ,?,'open',?,?)")
    .bind(uid("poincident"), x.accountId, plan.id, preorders.length >= 25 ? "severe" : "warning", preorders.length, x.reason, at).run();
  return { releasePlanId: plan.id, canceled: preorders.length };
}

export async function leasePreorderRefundJobs(db: CatalogDB, raw: unknown) {
  const x = z.object({ workerId: z.string().min(3).max(120), limit: z.number().int().min(1).max(100).default(20), leaseSeconds: z.number().int().min(30).max(1800).default(300) }).parse(raw);
  const at = now(), expiry = new Date(Date.now() + x.leaseSeconds * 1000).toISOString(), jobs: any[] = [];
  const candidates = (await db.prepare("SELECT * FROM preorder_refund_jobs WHERE status='queued' OR (status='leased' AND lease_expires_at<?) ORDER BY created_at LIMIT ?").bind(at, x.limit).all<any>()).results;
  for (const row of candidates) {
    const token = `${x.workerId}:${crypto.randomUUID()}`;
    const result: any = await db.prepare("UPDATE preorder_refund_jobs SET status='leased',lease_token=?,lease_expires_at=?,attempt_count=attempt_count+1,updated_at=? WHERE id=? AND (status='queued' OR (status='leased' AND lease_expires_at<?))")
      .bind(token, expiry, at, row.id, at).run();
    if (Number(result?.meta?.changes ?? result?.changes ?? 0) === 1) jobs.push({ ...row, status: "leased", lease_token: token, lease_expires_at: expiry });
  }
  return { jobs };
}

export async function completePreorderRefundJob(db: CatalogDB, raw: unknown) {
  const x = z.object({ jobId: z.string().min(1), leaseToken: z.string().min(1), success: z.boolean(), providerRefundId: z.string().nullable().optional(), error: z.string().max(2000).default("") }).parse(raw);
  const row = await db.prepare("SELECT * FROM preorder_refund_jobs WHERE id=? AND status='leased' AND lease_token=?").bind(x.jobId, x.leaseToken).first<any>();
  if (!row) throw new ApiError(409, "Preorder refund lease is no longer valid.");
  const at = now();
  if (x.success) {
    await db.prepare("UPDATE preorder_refund_jobs SET status='succeeded',provider_refund_id=?,lease_token=NULL,lease_expires_at=NULL,last_error='',updated_at=? WHERE id=?").bind(x.providerRefundId || null, at, row.id).run();
    await db.prepare("UPDATE preorders SET status='refunded',updated_at=? WHERE id=? AND status IN ('cancellation_requested','publisher_canceled','delivery_failed','paid_pending_release')").bind(at, row.preorder_id).run();
    await event(db, row.preorder_id, "refund_completed", { type: "automation" }, { refundJobId: row.id, providerRefundId: x.providerRefundId || null, amountMinor: row.amount_minor });
  } else {
    const terminal = Number(row.attempt_count) >= 8;
    await db.prepare("UPDATE preorder_refund_jobs SET status=?,lease_token=NULL,lease_expires_at=NULL,last_error=?,updated_at=? WHERE id=?").bind(terminal ? "failed" : "queued", x.error || "refund failed", at, row.id).run();
    await event(db, row.preorder_id, terminal ? "refund_failed_terminal" : "refund_retry_queued", { type: "automation" }, { refundJobId: row.id, error: x.error });
  }
  return { jobId: row.id, status: x.success ? "succeeded" : (Number(row.attempt_count) >= 8 ? "failed" : "queued") };
}

export async function advancePreorders(db: CatalogDB) {
  const at = now(), ts = Date.now(); let opened = 0, locked = 0, released = 0, failed = 0;
  const plans = (await db.prepare("SELECT * FROM preorder_release_plans WHERE status IN ('scheduled','open','locked') ORDER BY release_at LIMIT 500").all<any>()).results;
  for (const plan of plans) {
    const openMs = new Date(String(plan.opens_at)).getTime(), deadlineMs = new Date(String(plan.manuscript_deadline_at)).getTime(), releaseMs = new Date(String(plan.release_at)).getTime();
    if (plan.status === "scheduled" && openMs <= ts) { await db.prepare("UPDATE preorder_release_plans SET status='open',updated_at=? WHERE id=?").bind(at, plan.id).run(); opened++; }
    if (["scheduled", "open"].includes(plan.status) && deadlineMs <= ts && releaseMs > ts) { await db.prepare("UPDATE preorder_release_plans SET status='locked',updated_at=? WHERE id=?").bind(at, plan.id).run(); locked++; }
    if (releaseMs > ts) continue;
    const ready = await db.prepare(`SELECT 1 ok FROM publishing_publications p JOIN publishing_submission_snapshots s ON s.id=p.submission_id
      WHERE p.id=? AND s.status='published' LIMIT 1`).bind(plan.publication_id).first<any>();
    if (!ready) {
      const affected = (await db.prepare("SELECT * FROM preorders WHERE release_plan_id=? AND status='paid_pending_release'").bind(plan.id).all<any>()).results;
      await db.prepare("UPDATE preorder_release_plans SET status='failed',updated_at=? WHERE id=?").bind(at, plan.id).run();
      const account = await db.prepare(`SELECT t.account_id FROM publishing_edition_drafts e JOIN publishing_titles t ON t.id=e.title_id WHERE e.id=?`).bind(plan.publishing_edition_id).first<any>();
      if (account) await db.prepare("INSERT INTO publishing_preorder_incidents(id,publishing_account_id,release_plan_id,incident_type,severity,preorder_count,status,notes,created_at) VALUES(?,?,?,'delivery_failure',? ,?,'open','Release artifact was not publication-ready at release time.',?)")
        .bind(uid("poincident"), account.account_id, plan.id, affected.length >= 25 ? "severe" : "restriction", affected.length, at).run();
      for (const po of affected) {
        const jobId = uid("porefund"), amount = Number(po.guaranteed_price_minor);
        await db.prepare("UPDATE preorders SET status='delivery_failed',updated_at=? WHERE id=?").bind(at, po.id).run();
        await db.prepare("INSERT INTO preorder_refund_jobs(id,preorder_id,order_id,amount_minor,currency,reason,status,attempt_count,created_at,updated_at) VALUES(?,?,?,?,?,'preorder_delivery_failure','queued',0,?,?)").bind(jobId, po.id, po.order_id, amount, po.currency, at, at).run();
        await event(db, po.id, "delivery_failed", { type: "automation" }, { refundJobId: jobId });
      }
      failed++; continue;
    }
    const paid = (await db.prepare("SELECT * FROM preorders WHERE release_plan_id=? AND status='paid_pending_release'").bind(plan.id).all<any>()).results;
    for (const po of paid) await grantReleaseEntitlement(db, po);
    await db.prepare("UPDATE preorder_release_plans SET status='released',updated_at=? WHERE id=?").bind(at, plan.id).run();
    released += paid.length;
  }
  return { opened, locked, released, failed };
}

export async function publisherPreorderDashboard(db: CatalogDB, userId: string, accountId: string) {
  await member(db, userId, accountId);
  const [plans, statuses, incidents] = await Promise.all([
    db.prepare(`SELECT rp.*,e.title publishing_title,(SELECT COUNT(*) FROM preorders po WHERE po.release_plan_id=rp.id) preorder_count,(SELECT COALESCE(SUM(po.guaranteed_price_minor),0) FROM preorders po WHERE po.release_plan_id=rp.id AND po.status NOT IN ('refunded','customer_canceled')) booked_minor
      FROM preorder_release_plans rp JOIN publishing_edition_drafts e ON e.id=rp.publishing_edition_id JOIN publishing_titles t ON t.id=e.title_id WHERE t.account_id=? ORDER BY rp.release_at DESC`).bind(accountId).all<any>(),
    db.prepare(`SELECT po.status,COUNT(*) units,COALESCE(SUM(po.guaranteed_price_minor),0) value_minor,po.currency FROM preorders po JOIN preorder_release_plans rp ON rp.id=po.release_plan_id JOIN publishing_edition_drafts e ON e.id=rp.publishing_edition_id JOIN publishing_titles t ON t.id=e.title_id WHERE t.account_id=? GROUP BY po.status,po.currency`).bind(accountId).all<any>(),
    db.prepare("SELECT * FROM publishing_preorder_incidents WHERE publishing_account_id=? ORDER BY created_at DESC LIMIT 100").bind(accountId).all<any>(),
  ]);
  return { plans: plans.results, statusSummary: statuses.results, incidents: incidents.results };
}


export async function customerPreorders(db:CatalogDB,userId:string){const rows=(await db.prepare(`SELECT po.*,rp.release_at,rp.opens_at,rp.price_guarantee_policy,rp.cancellation_policy,e.title,p.format FROM preorders po JOIN preorder_release_plans rp ON rp.id=po.release_plan_id JOIN products p ON p.id=po.product_id JOIN editions e ON e.id=p.edition_id WHERE po.user_id=? ORDER BY po.created_at DESC LIMIT 250`).bind(userId).all<any>()).results;return{preorders:rows};}
