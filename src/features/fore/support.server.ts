import { z } from "zod/v3";
import type { CoveEnv } from "./api.server";
import { ApiError, now } from "./service";
import { refundOrder } from "./commerce.server";
import { dispatchSupportOwnerAction } from "../../storefront-strangler/publication-owner-routing.server";
import type { StaffContext } from "./moderation.server";

const id = (p: string) => `${p}_${crypto.randomUUID()}`;
const parse = (s: any) => {
  try {
    return JSON.parse(String(s || "{}"));
  } catch {
    return {};
  }
};
export async function sha256(value: string) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, "0")).join("");
}
async function event(
  db: CoveEnv["DB"],
  caseId: string,
  type: string,
  staffUserId: string,
  note = "",
  payload: any = {},
) {
  await db
    .prepare(
      "INSERT INTO support_case_events(id,case_id,event_type,staff_user_id,note,event_json,created_at) VALUES(?,?,?,?,?,?,?)",
    )
    .bind(id("supevt"), caseId, type, staffUserId, note, JSON.stringify(payload), now())
    .run();
}

export async function supportSearch(
  db: CoveEnv["DB"],
  query: string,
  includePaymentDetails = false,
) {
  const q = query.trim();
  if (q.length < 2) throw new ApiError(400, "Enter at least 2 characters.");
  const like = `%${q.slice(0, 160)}%`;
  const [users, orders, products, publishers, refunds, devices, entitlements, offline, payments] =
    await Promise.all([
      db
        .prepare(
          "SELECT app_id id,email,username,created_at FROM auth_accounts WHERE app_id LIKE ? OR email LIKE ? OR username LIKE ? ORDER BY created_at DESC LIMIT 25",
        )
        .bind(like, like, like)
        .all<any>(),
      db
        .prepare(
          "SELECT id,user_id,invoice_number,status,currency,total_minor,refunded_minor,stripe_payment_intent_id,payment_method_summary,created_at FROM commerce_orders WHERE id LIKE ? OR invoice_number LIKE ? OR user_id LIKE ? OR stripe_payment_intent_id LIKE ? ORDER BY created_at DESC LIMIT 25",
        )
        .bind(like, like, like, like)
        .all<any>(),
      db
        .prepare(
          "SELECT p.id,p.sku,p.format,p.storefront_status,p.source_external_id,e.title,e.publisher_id FROM products p JOIN editions e ON e.id=p.edition_id WHERE p.id LIKE ? OR p.sku LIKE ? OR p.source_external_id LIKE ? OR e.title LIKE ? ORDER BY p.updated_at DESC LIMIT 25",
        )
        .bind(like, like, like, like)
        .all<any>(),
      db
        .prepare(
          "SELECT id,display_name,legal_name,status,country_code FROM publishing_accounts WHERE id LIKE ? OR display_name LIKE ? OR legal_name LIKE ? ORDER BY updated_at DESC LIMIT 25",
        )
        .bind(like, like, like)
        .all<any>(),
      db
        .prepare(
          "SELECT r.id,r.order_id,r.amount_minor,r.currency,r.reason,r.status,r.provider_refund_id,r.created_at,o.user_id FROM commerce_refunds r JOIN commerce_orders o ON o.id=r.order_id WHERE r.id LIKE ? OR r.provider_refund_id LIKE ? OR r.order_id LIKE ? ORDER BY r.created_at DESC LIMIT 25",
        )
        .bind(like, like, like)
        .all<any>(),
      db
        .prepare(
          "SELECT id,user_id,device_key,name,platform,last_seen_at,revoked_at,created_at FROM devices WHERE id LIKE ? OR user_id LIKE ? OR device_key LIKE ? OR name LIKE ? ORDER BY last_seen_at DESC LIMIT 25",
        )
        .bind(like, like, like, like)
        .all<any>(),
      db
        .prepare(
          "SELECT id,user_id,product_id,entitlement_type,status,source,order_item_id,granted_at,updated_at FROM entitlements WHERE id LIKE ? OR user_id LIKE ? OR product_id LIKE ? OR order_item_id LIKE ? ORDER BY updated_at DESC LIMIT 25",
        )
        .bind(like, like, like, like)
        .all<any>(),
      db
        .prepare(
          "SELECT id,user_id,product_id,entitlement_id,device_id,status,issued_at,expires_at,revoked_at,revocation_reason FROM audio_offline_licenses WHERE id LIKE ? OR user_id LIKE ? OR product_id LIKE ? OR device_id LIKE ? ORDER BY issued_at DESC LIMIT 25",
        )
        .bind(like, like, like, like)
        .all<any>(),
      includePaymentDetails
        ? db
            .prepare(
              "SELECT pa.id,pa.order_id,pa.provider,pa.provider_payment_id,pa.status,pa.amount_minor,pa.currency,pa.failure_code,pa.failure_message,pa.created_at,pa.updated_at,o.user_id FROM commerce_payment_attempts pa JOIN commerce_orders o ON o.id=pa.order_id WHERE pa.id LIKE ? OR pa.provider_payment_id LIKE ? OR pa.order_id LIKE ? ORDER BY pa.updated_at DESC LIMIT 25",
            )
            .bind(like, like, like)
            .all<any>()
        : Promise.resolve({ results: [] }),
    ]);
  return {
    users: users.results,
    orders: orders.results,
    products: products.results,
    publishers: publishers.results,
    refunds: refunds.results,
    devices: devices.results,
    entitlements: entitlements.results,
    offlineLicenses: offline.results,
    payments: payments.results,
  };
}

export async function createSupportCase(db: CoveEnv["DB"], staff: StaffContext, raw: unknown) {
  const x = z
      .object({
        userId: z.string().max(240).nullable().optional(),
        orderId: z.string().max(240).nullable().optional(),
        productId: z.string().max(240).nullable().optional(),
        publisherAccountId: z.string().max(240).nullable().optional(),
        category: z.enum([
          "billing",
          "refund",
          "entitlement",
          "download",
          "account",
          "publication",
          "subscription",
          "device",
          "other",
        ]),
        priority: z.enum(["low", "normal", "high", "urgent"]).default("normal"),
        subject: z.string().trim().min(3).max(500),
      })
      .parse(raw),
    caseId = id("support"),
    at = now();
  if (x.orderId) {
    const o = await db
      .prepare("SELECT user_id FROM commerce_orders WHERE id=?")
      .bind(x.orderId)
      .first<any>();
    if (!o) throw new ApiError(404, "Order not found.");
    if (x.userId && o.user_id !== x.userId)
      throw new ApiError(409, "The order does not belong to the selected customer.");
  }
  await db
    .prepare(
      "INSERT INTO support_cases(id,user_id,order_id,product_id,publisher_account_id,category,status,priority,subject,created_by_staff_user_id,assigned_to_staff_user_id,created_at,updated_at) VALUES(?,?,?,?,?,?,'open',?,?,?,?,?,?)",
    )
    .bind(
      caseId,
      x.userId || null,
      x.orderId || null,
      x.productId || null,
      x.publisherAccountId || null,
      x.category,
      x.priority,
      x.subject,
      staff.userId,
      staff.userId,
      at,
      at,
    )
    .run();
  await event(db, caseId, "case_opened", staff.userId, x.subject, {
    category: x.category,
    priority: x.priority,
  });
  return { id: caseId };
}

export async function supportCaseDetail(
  db: CoveEnv["DB"],
  caseId: string,
  includePaymentDetails = false,
) {
  const c = await db.prepare("SELECT * FROM support_cases WHERE id=?").bind(caseId).first<any>();
  if (!c) throw new ApiError(404, "Support case not found.");
  const [timeline, actions] = await Promise.all([
    db
      .prepare("SELECT * FROM support_case_events WHERE case_id=? ORDER BY created_at,id")
      .bind(caseId)
      .all<any>(),
    db
      .prepare("SELECT * FROM support_actions WHERE case_id=? ORDER BY created_at DESC")
      .bind(caseId)
      .all<any>(),
  ]);
  let account: any = null,
    order: any = null,
    entitlements: any[] = [],
    payments: any[] = [],
    devices: any[] = [],
    offline: any[] = [],
    downloadDiagnostics: any[] = [],
    publication: any = null;
  if (c.user_id) {
    account = await db
      .prepare("SELECT app_id id,email,username,created_at FROM auth_accounts WHERE app_id=?")
      .bind(c.user_id)
      .first<any>();
    devices = (
      await db
        .prepare(
          "SELECT id,name,platform,last_seen_at,revoked_at FROM devices WHERE user_id=? ORDER BY last_seen_at DESC LIMIT 50",
        )
        .bind(c.user_id)
        .all<any>()
    ).results;
    offline = (
      await db
        .prepare(
          "SELECT id,product_id,device_id,status,issued_at,expires_at,revoked_at,revocation_reason FROM audio_offline_licenses WHERE user_id=? ORDER BY issued_at DESC LIMIT 50",
        )
        .bind(c.user_id)
        .all<any>()
    ).results;
    downloadDiagnostics = (
      await db
        .prepare(
          `SELECT l.id license_id,l.product_id,l.device_id,l.status license_status,l.expires_at,l.revoked_at,l.revocation_reason,d.name device_name,d.platform,d.revoked_at device_revoked_at,e.id entitlement_id,e.status entitlement_status,e.entitlement_type,p.storefront_status,p.sku FROM audio_offline_licenses l LEFT JOIN devices d ON d.id=l.device_id LEFT JOIN entitlements e ON e.id=l.entitlement_id LEFT JOIN products p ON p.id=l.product_id WHERE l.user_id=? ORDER BY l.issued_at DESC LIMIT 50`,
        )
        .bind(c.user_id)
        .all<any>()
    ).results.map((r: any) => ({
      ...r,
      diagnosis: r.device_revoked_at
        ? "device_revoked"
        : r.entitlement_status !== "active"
          ? "entitlement_inactive"
          : r.license_status !== "active"
            ? "license_inactive"
            : Date.parse(String(r.expires_at || "")) <= Date.now()
              ? "license_expired"
              : !["active", "preorder"].includes(String(r.storefront_status))
                ? "product_unavailable"
                : "ready",
    }));
  }
  if (c.order_id) {
    order = await db
      .prepare("SELECT * FROM commerce_orders WHERE id=?")
      .bind(c.order_id)
      .first<any>();
    entitlements = (
      await db
        .prepare(
          "SELECT e.* FROM entitlements e JOIN commerce_order_items oi ON oi.id=e.order_item_id WHERE oi.order_id=? ORDER BY e.granted_at",
        )
        .bind(c.order_id)
        .all<any>()
    ).results;
    if (includePaymentDetails)
      payments = (
        await db
          .prepare(
            "SELECT id,provider,provider_payment_id,status,amount_minor,currency,failure_code,failure_message,created_at,updated_at FROM commerce_payment_attempts WHERE order_id=? ORDER BY created_at DESC",
          )
          .bind(c.order_id)
          .all<any>()
      ).results;
  }
  if (c.product_id)
    publication = await db
      .prepare(
        `SELECT p.id product_id,p.sku,p.storefront_status,e.title,l.state lifecycle_state,l.state_reason,l.updated_at lifecycle_updated_at FROM products p JOIN editions e ON e.id=p.edition_id LEFT JOIN publishing_edition_drafts ped ON ped.catalog_product_id=p.id LEFT JOIN publishing_release_lifecycles l ON l.publishing_edition_id=ped.id WHERE p.id=? ORDER BY l.updated_at DESC LIMIT 1`,
      )
      .bind(c.product_id)
      .first<any>();
  return {
    case: c,
    account,
    order,
    entitlements,
    payments,
    devices,
    offlineLicenses: offline,
    downloadDiagnostics,
    publication,
    timeline: timeline.results.map((r: any) => ({ ...r, event_json: parse(r.event_json) })),
    actions: actions.results.map((r: any) => ({
      ...r,
      before_json: parse(r.before_json),
      after_json: parse(r.after_json),
    })),
  };
}

export async function addSupportNote(db: CoveEnv["DB"], staff: StaffContext, raw: unknown) {
  const x = z
      .object({
        caseId: z.string().min(1),
        note: z.string().trim().min(1).max(10000),
        status: z
          .enum(["open", "pending_customer", "pending_internal", "resolved", "closed"])
          .optional(),
      })
      .parse(raw),
    c = await db.prepare("SELECT * FROM support_cases WHERE id=?").bind(x.caseId).first<any>();
  if (!c) throw new ApiError(404, "Support case not found.");
  if (x.status)
    await db
      .prepare(
        "UPDATE support_cases SET status=?,resolved_at=CASE WHEN ? IN ('resolved','closed') THEN ? ELSE NULL END,updated_at=? WHERE id=?",
      )
      .bind(x.status, x.status, now(), now(), x.caseId)
      .run();
  else
    await db
      .prepare("UPDATE support_cases SET updated_at=? WHERE id=?")
      .bind(now(), x.caseId)
      .run();
  await event(db, x.caseId, "note", staff.userId, x.note, x.status ? { status: x.status } : {});
  return { saved: true };
}

export async function recordAction(
  db: CoveEnv["DB"],
  staff: StaffContext,
  x: {
    caseId: string;
    actionType: string;
    targetType: string;
    targetId: string;
    reasonCode: string;
    rationale: string;
    idempotencyKey: string;
  },
  before: any,
  after: any,
  providerReference = "",
) {
  const existing = await db
    .prepare("SELECT * FROM support_actions WHERE idempotency_key=?")
    .bind(x.idempotencyKey)
    .first<any>();
  if (existing) return existing;
  const actionId = id("supact"),
    at = now();
  await db
    .prepare(
      "INSERT INTO support_actions(id,case_id,staff_user_id,action_type,target_type,target_id,reason_code,rationale,idempotency_key,before_json,after_json,provider_reference,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
    )
    .bind(
      actionId,
      x.caseId,
      staff.userId,
      x.actionType,
      x.targetType,
      x.targetId,
      x.reasonCode,
      x.rationale,
      x.idempotencyKey,
      JSON.stringify(before || {}),
      JSON.stringify(after || {}),
      providerReference,
      at,
    )
    .run();
  await event(db, x.caseId, "action", staff.userId, x.rationale, {
    actionId,
    actionType: x.actionType,
    targetType: x.targetType,
    targetId: x.targetId,
    reasonCode: x.reasonCode,
  });
  await db.prepare("UPDATE support_cases SET updated_at=? WHERE id=?").bind(at, x.caseId).run();
  return { id: actionId };
}
export function assertScope(c: any, target: any, kind: "user" | "order" | "product" | "publisher") {
  if (kind === "user" && c.user_id && String(target) !== String(c.user_id))
    throw new ApiError(409, "This action target is outside the support case customer scope.");
  if (kind === "order" && c.order_id && String(target) !== String(c.order_id))
    throw new ApiError(409, "This action target is outside the support case order scope.");
  if (kind === "product" && c.product_id && String(target) !== String(c.product_id))
    throw new ApiError(409, "This action target is outside the support case product scope.");
  if (
    kind === "publisher" &&
    c.publisher_account_id &&
    String(target) !== String(c.publisher_account_id)
  )
    throw new ApiError(409, "This action target is outside the support case publisher scope.");
}

/**
 * All canonical support actions now enter a private, independently leased QA
 * owner. Do not restore the previous direct D1 action handler. Production
 * without the private owner deliberately fails closed.
 */
export async function executeSupportAction(
  env: CoveEnv, staff: StaffContext, permission: (p:string)=>boolean, raw:unknown
) {
  // Retain the public authenticated staff entry and independently verify again
  // at the owner; caller-provided permission booleans are never authoritative.
  if (!staff?.userId) throw new ApiError(403,"Staff identity is required.");
  const parsed=z.object({
    caseId:z.string().min(1),actionType:z.enum([
      "resend_receipt","refund","restore_entitlement","revoke_entitlement",
      "reset_publication","requeue_download","revoke_device","security_recovery","note_only"
    ]),
    targetId:z.string().min(1),reasonCode:z.string().min(2).max(120),
    rationale:z.string().trim().min(10).max(5000),
    idempotencyKey:z.string().min(16).max(200),
    amountMinor:z.number().int().positive().optional()
  }).parse(raw);
  // A missing/expired QA owner binding is not permission to fall back to D1.
  return dispatchSupportOwnerAction(env.DB,staff.userId,parsed);
}
