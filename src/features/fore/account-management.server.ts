import { z } from "zod/v3";
import type { CoveEnv } from "./api.server";
import { ApiError, now } from "./service";
import { emitNotification } from "./notifications.server";
import { eraseProviderIdentity } from "./account-erasure.server";
import { exportCustomerSupport } from "./customer-support.server";

export type AccountDB = CoveEnv["DB"];
const id = (p: string) => `${p}_${crypto.randomUUID()}`;
const json = (value: string | undefined | null, fallback: any) => {
  try {
    return JSON.parse(String(value || ""));
  } catch {
    return fallback;
  }
};
async function sha256(value: string) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, "0")).join("");
}
function country(request: Request) {
  return (request.headers.get("cf-ipcountry") || "").slice(0, 2).toUpperCase();
}
function ua(request: Request) {
  return (request.headers.get("user-agent") || "").slice(0, 240);
}

export async function recordAccountSecurityEvent(
  db: AccountDB,
  userId: string,
  eventType: string,
  request: Request,
  detail: unknown = {},
  actorType: "user" | "staff" | "system" | "provider" = "user",
  actorUserId: string | null = userId,
) {
  const cookie = request.headers.get("cookie") || "";
  const fp = cookie ? await sha256(cookie) : "";
  const at = now();
  await db
    .prepare(
      "INSERT INTO account_security_events(id,user_id,event_type,actor_type,actor_user_id,session_fingerprint,ip_country,user_agent_summary,event_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
    )
    .bind(
      id("secevt"),
      userId,
      eventType,
      actorType,
      actorUserId,
      fp,
      country(request),
      ua(request),
      JSON.stringify(detail || {}),
      at,
    )
    .run();
  // Security events are transactional facts first; notification delivery is best-effort and never blocks the security action.
  try {
    await emitNotification(db, {
      userId,
      eventType: "account_security_alert",
      dedupeKey: `security:${userId}:${eventType}:${at}`,
      title: "Account security activity",
      body: `Cove recorded a security event on your account: ${eventType.replaceAll("_", " ")}.`,
      urgency: "high",
      topic: "security",
      subjectType: "account_security_event",
      subjectId: eventType,
      actionUrl: "/account",
      payload: { eventType, actorType, country: country(request), detail },
      forceChannels: ["in_app", "email"],
    });
  } catch (e) {
    console.error("Security notification enqueue failed", e);
  }
}

export async function touchAccountSession(
  db: AccountDB,
  userId: string,
  request: Request,
  sessionFingerprint?: string,
) {
  const cookie = request.headers.get("cookie") || "";
  const hash = sessionFingerprint || (cookie ? await sha256(cookie) : "");
  if (!hash) return null;
  const at = now();
  const existing = await db
    .prepare("SELECT id FROM account_sessions WHERE user_id=? AND provider_session_id_hash=?")
    .bind(userId, hash)
    .first<any>();
  const sessionId = existing?.id || id("sess");
  if (existing)
    await db
      .prepare(
        "UPDATE account_sessions SET last_seen_at=?,user_agent_summary=?,ip_country=? WHERE id=? AND revoked_at IS NULL",
      )
      .bind(at, ua(request), country(request), sessionId)
      .run();
  else
    await db
      .prepare(
        "INSERT INTO account_sessions(id,user_id,provider_session_id_hash,user_agent_summary,ip_country,created_at,last_seen_at) VALUES(?,?,?,?,?,?,?)",
      )
      .bind(sessionId, userId, hash, ua(request), country(request), at, at)
      .run();
  return sessionId;
}

export async function accountOverview(
  db: AccountDB,
  userId: string,
  request: Request,
  sessionFingerprint?: string,
) {
  await touchAccountSession(db, userId, request, sessionFingerprint);
  const [
    prefs,
    addresses,
    billing,
    sessions,
    devices,
    orders,
    refunds,
    subs,
    gifts,
    security,
    deletion,
  ] = await Promise.all([
    db.prepare("SELECT * FROM account_preferences WHERE user_id=?").bind(userId).first<any>(),
    db
      .prepare(
        "SELECT * FROM account_addresses WHERE user_id=? ORDER BY address_type,is_default DESC,updated_at DESC",
      )
      .bind(userId)
      .all<any>(),
    db
      .prepare(
        "SELECT id,provider,brand,last4,exp_month,exp_year,billing_name,is_default,status,created_at,updated_at FROM account_billing_methods WHERE user_id=? ORDER BY is_default DESC,updated_at DESC",
      )
      .bind(userId)
      .all<any>(),
    db
      .prepare(
        "SELECT id,device_id,user_agent_summary,ip_country,created_at,last_seen_at,revoked_at,revoked_reason FROM account_sessions WHERE user_id=? ORDER BY last_seen_at DESC LIMIT 50",
      )
      .bind(userId)
      .all<any>(),
    db
      .prepare(
        "SELECT id,device_key,name,platform,last_seen_at,revoked_at,created_at FROM devices WHERE user_id=? ORDER BY last_seen_at DESC LIMIT 100",
      )
      .bind(userId)
      .all<any>(),
    db
      .prepare(
        "SELECT id,invoice_number,status,currency,total_minor,refunded_minor,payment_method_summary,created_at,paid_at FROM commerce_orders WHERE user_id=? ORDER BY created_at DESC LIMIT 100",
      )
      .bind(userId)
      .all<any>(),
    db
      .prepare(
        "SELECT r.id,r.order_id,r.amount_minor,r.currency,r.reason,r.status,r.created_at,r.succeeded_at FROM commerce_refunds r JOIN commerce_orders o ON o.id=r.order_id WHERE o.user_id=? ORDER BY r.created_at DESC LIMIT 100",
      )
      .bind(userId)
      .all<any>(),
    db
      .prepare(
        "SELECT id,plan_code,status,current_period_start,current_period_end,cancel_at_end,created_at,updated_at FROM subscriptions WHERE user_id=? ORDER BY updated_at DESC",
      )
      .bind(userId)
      .all<any>(),
    db
      .prepare(
        "SELECT w.code_hash,w.nickname,w.added_at,g.last4,g.currency,g.balance_minor,g.status,g.expires_at FROM account_gift_card_wallet w JOIN commerce_gift_cards g ON g.code_hash=w.code_hash WHERE w.user_id=? ORDER BY w.added_at DESC",
      )
      .bind(userId)
      .all<any>(),
    db
      .prepare(
        "SELECT id,event_type,actor_type,ip_country,user_agent_summary,event_json,created_at FROM account_security_events WHERE user_id=? ORDER BY created_at DESC LIMIT 100",
      )
      .bind(userId)
      .all<any>(),
    db
      .prepare(
        "SELECT id,status,requested_at,execute_after,canceled_at,completed_at,legal_hold_reason,cleanup_phase,attempts,next_retry_at,last_error_code FROM account_deletion_requests WHERE user_id=? ORDER BY requested_at DESC LIMIT 1",
      )
      .bind(userId)
      .first<any>(),
  ]);
  const storeCredit = (
    await db
      .prepare(
        "SELECT currency,COALESCE(SUM(amount_minor),0) balance_minor FROM commerce_store_credit_ledger WHERE user_id=? GROUP BY currency",
      )
      .bind(userId)
      .all<any>()
  ).results;
  return {
    preferences: prefs
      ? {
          storefrontCountry: prefs.storefront_country,
          privacy: json(prefs.privacy_json, {}),
          marketing: json(prefs.marketing_json, {}),
          notifications: json(prefs.notifications_json, {}),
        }
      : {
          storefrontCountry: "US",
          privacy: { analytics: true, personalization: true },
          marketing: { email: false, product: false, authorReleases: true, deals: false },
          notifications: {
            orders: true,
            security: true,
            preorders: true,
            authorReleases: true,
            priceDrops: true,
          },
        },
    addresses: addresses.results,
    billingMethods: billing.results,
    sessions: sessions.results,
    devices: devices.results,
    orders: orders.results,
    refunds: refunds.results,
    subscriptions: subs.results,
    giftCards: gifts.results,
    storeCredit,
    securityEvents: security.results.map((r: any) => ({
      ...r,
      event_json: json(r.event_json, {}),
    })),
    deletion: deletion || null,
  };
}

export async function saveAccountPreferences(db: AccountDB, userId: string, raw: unknown) {
  const x = z
      .object({
        storefrontCountry: z
          .string()
          .regex(/^[A-Z]{2}$/)
          .default("US"),
        privacy: z.record(z.boolean()).default({}),
        marketing: z.record(z.boolean()).default({}),
        notifications: z.record(z.boolean()).default({}),
      })
      .parse(raw),
    at = now();
  await db
    .prepare(
      "INSERT INTO account_preferences(user_id,storefront_country,privacy_json,marketing_json,notifications_json,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET storefront_country=excluded.storefront_country,privacy_json=excluded.privacy_json,marketing_json=excluded.marketing_json,notifications_json=excluded.notifications_json,updated_at=excluded.updated_at",
    )
    .bind(
      userId,
      x.storefrontCountry,
      JSON.stringify(x.privacy),
      JSON.stringify(x.marketing),
      JSON.stringify(x.notifications),
      at,
    )
    .run();
  return { saved: true };
}

export async function saveAccountAddress(db: AccountDB, userId: string, raw: unknown) {
  const x = z
      .object({
        id: z.string().optional(),
        addressType: z.enum(["billing", "shipping", "tax"]),
        recipientName: z.string().max(160).default(""),
        line1: z.string().min(1).max(240),
        line2: z.string().max(240).default(""),
        city: z.string().min(1).max(160),
        region: z.string().max(120).default(""),
        postalCode: z.string().min(1).max(40),
        countryCode: z.string().regex(/^[A-Z]{2}$/),
        isDefault: z.boolean().default(false),
      })
      .parse(raw),
    at = now(),
    addressId = x.id || id("addr");
  if (x.isDefault)
    await db
      .prepare(
        "UPDATE account_addresses SET is_default=0,updated_at=? WHERE user_id=? AND address_type=?",
      )
      .bind(at, userId, x.addressType)
      .run();
  const owned = x.id
    ? await db
        .prepare("SELECT 1 ok FROM account_addresses WHERE id=? AND user_id=?")
        .bind(x.id, userId)
        .first<any>()
    : null;
  if (x.id && !owned) throw new ApiError(404, "Address not found.");
  await db
    .prepare(
      "INSERT INTO account_addresses(id,user_id,address_type,recipient_name,line1,line2,city,region,postal_code,country_code,is_default,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET recipient_name=excluded.recipient_name,line1=excluded.line1,line2=excluded.line2,city=excluded.city,region=excluded.region,postal_code=excluded.postal_code,country_code=excluded.country_code,is_default=excluded.is_default,updated_at=excluded.updated_at",
    )
    .bind(
      addressId,
      userId,
      x.addressType,
      x.recipientName,
      x.line1,
      x.line2,
      x.city,
      x.region,
      x.postalCode,
      x.countryCode,
      x.isDefault ? 1 : 0,
      at,
      at,
    )
    .run();
  return { id: addressId };
}

export async function deleteAccountAddress(db: AccountDB, userId: string, addressId: string) {
  const r = await db
    .prepare("DELETE FROM account_addresses WHERE id=? AND user_id=? RETURNING id")
    .bind(addressId, userId)
    .first<any>();
  if (!r) throw new ApiError(404, "Address not found.");
  return { deleted: true };
}

export async function revokeAccountSession(
  db: AccountDB,
  userId: string,
  sessionId: string,
  request: Request,
) {
  const at = now(),
    r = await db
      .prepare(
        "UPDATE account_sessions SET revoked_at=?,revoked_reason='user_revoked' WHERE id=? AND user_id=? AND revoked_at IS NULL RETURNING id",
      )
      .bind(at, sessionId, userId)
      .first<any>();
  if (!r) throw new ApiError(404, "Active session not found.");
  await recordAccountSecurityEvent(db, userId, "session_revoked", request, { sessionId });
  return { revoked: true };
}
export async function registerDevice(
  db: AccountDB,
  userId: string,
  request: Request,
  raw: unknown,
) {
  const x = z
      .object({
        deviceKey: z.string().min(16).max(200),
        name: z.string().trim().min(1).max(120),
        platform: z.string().trim().min(1).max(80),
      })
      .parse(raw),
    at = now();
  const row = await db
    .prepare(
      `INSERT INTO devices(id,user_id,device_key,name,platform,last_seen_at,revoked_at,created_at) VALUES(?,?,?,?,?,?,NULL,?) ON CONFLICT(user_id,device_key) DO UPDATE SET name=excluded.name,platform=excluded.platform,last_seen_at=excluded.last_seen_at WHERE devices.revoked_at IS NULL RETURNING id,name,platform,last_seen_at,created_at`,
    )
    .bind(id("device"), userId, x.deviceKey, x.name, x.platform, at, at)
    .first<any>();
  // A removed device key must never restore itself merely by registering
  // again. Rotate the key and explicitly enroll a new device instead.
  if (!row)
    throw new ApiError(409, "This device was revoked. Register with a new device key.");
  await recordAccountSecurityEvent(db, userId, "device_registered", request, {
    deviceId: row?.id,
    platform: x.platform,
  });
  return row;
}

export async function revokeDevice(
  db: AccountDB,
  userId: string,
  deviceId: string,
  request: Request,
) {
  const at = now(),
    r = await db
      .prepare(
        "UPDATE devices SET revoked_at=? WHERE id=? AND user_id=? AND revoked_at IS NULL RETURNING id",
      )
      .bind(at, deviceId, userId)
      .first<any>();
  if (!r) throw new ApiError(404, "Active device not found.");
  await db
    .prepare(
      "UPDATE audio_offline_licenses SET status='revoked',revoked_at=?,revocation_reason='device_revoked' WHERE user_id=? AND device_id=? AND status='active'",
    )
    .bind(at, userId, deviceId)
    .run();
  await recordAccountSecurityEvent(db, userId, "device_revoked", request, { deviceId });
  return { revoked: true };
}

export async function requestAccountDeletion(
  db: AccountDB,
  userId: string,
  request: Request,
  raw: unknown,
) {
  const x = z.object({ confirmation: z.literal("DELETE MY ACCOUNT") }).parse(raw),
    existing = await db
      .prepare(
        "SELECT id FROM account_deletion_requests WHERE user_id=? AND status IN ('requested','cooling_off','queued','executing')",
      )
      .bind(userId)
      .first<any>();
  if (existing) throw new ApiError(409, "Account deletion is already scheduled.");
  const at = now(),
    executeAfter = new Date(Date.now() + 7 * 86400000).toISOString(),
    confirmationHash = await sha256(`${userId}:${x.confirmation}:${at}`),
    requestId = id("delete");
  await db
    .prepare(
      "INSERT INTO account_deletion_requests(id,user_id,status,requested_at,execute_after,confirmation_hash,created_at,updated_at) VALUES(?,?,'cooling_off',?,?,?,?,?)",
    )
    .bind(requestId, userId, at, executeAfter, confirmationHash, at, at)
    .run();
  await recordAccountSecurityEvent(db, userId, "account_deletion_requested", request, {
    requestId,
    executeAfter,
  });
  return { id: requestId, status: "cooling_off", executeAfter };
}
export async function cancelAccountDeletion(db: AccountDB, userId: string, request: Request) {
  const at = now(),
    r = await db
      .prepare(
        "UPDATE account_deletion_requests SET status='canceled',canceled_at=?,updated_at=? WHERE user_id=? AND status IN ('requested','cooling_off','queued') RETURNING id",
      )
      .bind(at, at, userId)
      .first<any>();
  if (!r) throw new ApiError(404, "No cancellable deletion request found.");
  await recordAccountSecurityEvent(db, userId, "account_deletion_canceled", request, {
    requestId: r.id,
  });
  return { canceled: true };
}

export async function accountDataExport(db: AccountDB, userId: string) {
  const [
    account,
    profile,
    readingStates,
    annotations,
    definitions,
    readingSessions,
    reviews,
    reviewHearts,
    authorFollows,
    authorFollowPreferences,
    entitlements,
    orders,
    orderItems,
    refunds,
    preorders,
    subscriptions,
    addresses,
    preferences,
    billingMethods,
    devices,
    sessions,
    securityEvents,
    giftCards,
    storeCredit,
  ] = await Promise.all([
    db
      .prepare("SELECT app_id id,email,username,created_at FROM auth_accounts WHERE app_id=?")
      .bind(userId)
      .first<any>(),
    db.prepare("SELECT * FROM profiles WHERE user_id=?").bind(userId).first<any>(),
    db
      .prepare("SELECT * FROM reading_states WHERE user_id=? ORDER BY updated_at DESC")
      .bind(userId)
      .all<any>(),
    db
      .prepare(
        "SELECT * FROM annotations WHERE user_id=? AND deleted_at IS NULL ORDER BY created_at",
      )
      .bind(userId)
      .all<any>(),
    db
      .prepare("SELECT * FROM definitions WHERE user_id=? ORDER BY created_at")
      .bind(userId)
      .all<any>(),
    db
      .prepare("SELECT * FROM reading_sessions WHERE user_id=? ORDER BY started_at")
      .bind(userId)
      .all<any>(),
    db
      .prepare(
        "SELECT id,book_id,rating_steps,body,visibility,moderation,provenance_type,provenance_weight,ranking_status,created_at,updated_at FROM reviews WHERE user_id=? ORDER BY created_at",
      )
      .bind(userId)
      .all<any>(),
    db
      .prepare("SELECT review_id,created_at FROM review_hearts WHERE user_id=? ORDER BY created_at")
      .bind(userId)
      .all<any>(),
    db
      .prepare(
        "SELECT contributor_id,created_at FROM author_follows WHERE user_id=? ORDER BY created_at",
      )
      .bind(userId)
      .all<any>(),
    db
      .prepare("SELECT * FROM author_follow_preferences WHERE user_id=? ORDER BY updated_at")
      .bind(userId)
      .all<any>(),
    db
      .prepare(
        "SELECT id,product_id,entitlement_type,status,source,order_item_id,starts_at,ends_at,granted_at,updated_at FROM entitlements WHERE user_id=? ORDER BY granted_at",
      )
      .bind(userId)
      .all<any>(),
    db
      .prepare(
        "SELECT id,invoice_number,status,currency,subtotal_minor,promo_discount_minor,tax_minor,total_minor,refunded_minor,payment_method_summary,created_at,paid_at FROM commerce_orders WHERE user_id=? ORDER BY created_at",
      )
      .bind(userId)
      .all<any>(),
    db
      .prepare(
        "SELECT oi.* FROM commerce_order_items oi JOIN commerce_orders o ON o.id=oi.order_id WHERE o.user_id=? ORDER BY oi.created_at",
      )
      .bind(userId)
      .all<any>(),
    db
      .prepare(
        "SELECT r.id,r.order_id,r.amount_minor,r.currency,r.reason,r.status,r.created_at,r.succeeded_at FROM commerce_refunds r JOIN commerce_orders o ON o.id=r.order_id WHERE o.user_id=? ORDER BY r.created_at",
      )
      .bind(userId)
      .all<any>(),
    db
      .prepare("SELECT * FROM preorders WHERE user_id=? ORDER BY created_at")
      .bind(userId)
      .all<any>(),
    db
      .prepare(
        "SELECT id,plan_code,status,current_period_start,current_period_end,cancel_at_end,created_at,updated_at FROM subscriptions WHERE user_id=? ORDER BY created_at",
      )
      .bind(userId)
      .all<any>(),
    db
      .prepare("SELECT * FROM account_addresses WHERE user_id=? ORDER BY created_at")
      .bind(userId)
      .all<any>(),
    db.prepare("SELECT * FROM account_preferences WHERE user_id=?").bind(userId).first<any>(),
    db
      .prepare(
        "SELECT id,provider,brand,last4,exp_month,exp_year,billing_name,is_default,status,created_at,updated_at FROM account_billing_methods WHERE user_id=? ORDER BY created_at",
      )
      .bind(userId)
      .all<any>(),
    db
      .prepare(
        "SELECT id,name,platform,last_seen_at,revoked_at,created_at FROM devices WHERE user_id=? ORDER BY created_at",
      )
      .bind(userId)
      .all<any>(),
    db
      .prepare(
        "SELECT id,user_agent_summary,ip_country,created_at,last_seen_at,revoked_at,revoked_reason FROM account_sessions WHERE user_id=? ORDER BY created_at",
      )
      .bind(userId)
      .all<any>(),
    db
      .prepare(
        "SELECT id,event_type,actor_type,ip_country,user_agent_summary,event_json,created_at FROM account_security_events WHERE user_id=? ORDER BY created_at",
      )
      .bind(userId)
      .all<any>(),
    db
      .prepare(
        "SELECT w.nickname,w.added_at,g.last4,g.currency,g.balance_minor,g.status,g.expires_at FROM account_gift_card_wallet w JOIN commerce_gift_cards g ON g.code_hash=w.code_hash WHERE w.user_id=? ORDER BY w.added_at",
      )
      .bind(userId)
      .all<any>(),
    db
      .prepare(
        "SELECT currency,amount_minor,entry_type,reference,created_at FROM commerce_store_credit_ledger WHERE user_id=? ORDER BY created_at",
      )
      .bind(userId)
      .all<any>(),
  ]);
  const [
    socialProfile,
    topBooks,
    follows,
    followRequests,
    blocks,
    mutes,
    posts,
    postReactions,
    lists,
    listItems,
    groups,
    groupMemberships,
    journeys,
    journeyPoints,
    journeyRecipients,
    sharedHighlights,
    readerPreferences,
    socialEvents,
  ] = await Promise.all([
    db.prepare("SELECT * FROM social_profiles WHERE user_id=?").bind(userId).first<any>(),
    db
      .prepare("SELECT * FROM profile_top_books WHERE user_id=? ORDER BY position")
      .bind(userId)
      .all<any>(),
    db
      .prepare(
        "SELECT * FROM social_follows WHERE follower_user_id=? OR followed_user_id=? ORDER BY created_at",
      )
      .bind(userId, userId)
      .all<any>(),
    db
      .prepare(
        "SELECT * FROM social_follow_requests WHERE requester_user_id=? OR target_user_id=? ORDER BY created_at",
      )
      .bind(userId, userId)
      .all<any>(),
    db
      .prepare(
        "SELECT * FROM social_blocks WHERE blocker_user_id=? OR blocked_user_id=? ORDER BY created_at",
      )
      .bind(userId, userId)
      .all<any>(),
    db
      .prepare("SELECT * FROM social_mutes WHERE muter_user_id=? ORDER BY created_at")
      .bind(userId)
      .all<any>(),
    db
      .prepare("SELECT * FROM social_posts WHERE user_id=? ORDER BY created_at")
      .bind(userId)
      .all<any>(),
    db
      .prepare("SELECT * FROM social_post_reactions WHERE user_id=? ORDER BY created_at")
      .bind(userId)
      .all<any>(),
    db
      .prepare("SELECT * FROM social_lists WHERE user_id=? ORDER BY created_at")
      .bind(userId)
      .all<any>(),
    db
      .prepare(
        "SELECT i.* FROM social_list_items i JOIN social_lists l ON l.id=i.list_id WHERE l.user_id=? ORDER BY i.list_id,i.position",
      )
      .bind(userId)
      .all<any>(),
    db
      .prepare(
        "SELECT g.* FROM reading_groups g WHERE g.owner_user_id=? OR EXISTS(SELECT 1 FROM reading_group_members m WHERE m.group_id=g.id AND m.user_id=?) ORDER BY g.created_at",
      )
      .bind(userId, userId)
      .all<any>(),
    db
      .prepare("SELECT * FROM reading_group_members WHERE user_id=? ORDER BY created_at")
      .bind(userId)
      .all<any>(),
    db
      .prepare("SELECT * FROM reading_journeys WHERE user_id=? ORDER BY finished_at")
      .bind(userId)
      .all<any>(),
    db
      .prepare(
        "SELECT p.* FROM reading_journey_points p JOIN reading_journeys j ON j.id=p.journey_id WHERE j.user_id=? ORDER BY p.journey_id,p.sequence",
      )
      .bind(userId)
      .all<any>(),
    db
      .prepare(
        "SELECT r.journey_id,r.recipient_user_id,r.version,r.revoked_at,r.created_at,r.updated_at FROM reading_journey_recipients r JOIN reading_journeys j ON j.id=r.journey_id WHERE j.user_id=? OR r.recipient_user_id=? ORDER BY r.updated_at",
      )
      .bind(userId, userId)
      .all<{
        journey_id: string;
        recipient_user_id: string;
        version: number;
        revoked_at: string | null;
        created_at: string;
        updated_at: string;
      }>(),
    db
      .prepare("SELECT * FROM social_annotation_shares WHERE user_id=? ORDER BY created_at")
      .bind(userId)
      .all<any>(),
    db.prepare("SELECT * FROM social_reader_preferences WHERE user_id=?").bind(userId).first<any>(),
    db
      .prepare("SELECT * FROM social_events WHERE user_id=? ORDER BY created_at")
      .bind(userId)
      .all<any>(),
  ]);
  const [textBookmarks, readingGoals, bookMetrics] = await Promise.all([
    db
      .prepare("SELECT * FROM text_bookmarks WHERE user_id=? ORDER BY created_at")
      .bind(userId)
      .all<any>(),
    db.prepare("SELECT * FROM reading_goals WHERE user_id=? ORDER BY year").bind(userId).all<any>(),
    db
      .prepare("SELECT * FROM book_metrics WHERE user_id=? ORDER BY updated_at")
      .bind(userId)
      .all<any>(),
  ]);
  return {
    matching: {
      preferences: await db
        .prepare("SELECT preferences_json,updated_at FROM matching_preferences WHERE user_id=?")
        .bind(userId)
        .first(),
      feedback: (
        await db
          .prepare(
            "SELECT product_id,book_fingerprint,spine,mode,recording_id,music_fingerprint,reason,updated_at FROM matching_feedback WHERE user_id=? ORDER BY updated_at",
          )
          .bind(userId)
          .all()
      ).results,
    },
    discovery: {
      controls: await db
        .prepare(
          "SELECT preferences_json,revision,updated_at FROM recommendation_taste_controls WHERE user_id=?",
        )
        .bind(userId)
        .first(),
      feedback: (
        await db.prepare("SELECT * FROM recommendation_feedback WHERE user_id=?").bind(userId).all()
      ).results,
      events: (
        await db
          .prepare("SELECT * FROM recommendation_events WHERE user_id=? ORDER BY occurred_at")
          .bind(userId)
          .all()
      ).results,
    },
    schema: "fore-account-export",
    version: 4,
    exportedAt: now(),
    support: await exportCustomerSupport(db, userId),
    account,
    profile,
    reading: {
      states: readingStates.results,
      annotations: annotations.results,
      definitions: definitions.results,
      bookmarks: textBookmarks.results,
      sessions: readingSessions.results,
      goals: readingGoals.results,
      bookMetrics: bookMetrics.results,
    },
    community: {
      reviews: reviews.results,
      reviewHearts: reviewHearts.results,
      authorFollows: authorFollows.results,
      authorFollowPreferences: authorFollowPreferences.results,
      social: {
        profile: socialProfile,
        topBooks: topBooks.results,
        follows: follows.results,
        followRequests: followRequests.results,
        blocks: blocks.results,
        mutes: mutes.results,
        posts: posts.results,
        reactions: postReactions.results,
        lists: lists.results,
        listItems: listItems.results,
        groups: groups.results,
        groupMemberships: groupMemberships.results,
        journeys: journeys.results,
        journeyPoints: journeyPoints.results,
        journeyRecipients: journeyRecipients.results,
        sharedHighlights: sharedHighlights.results,
        readerPreferences,
        socialEvents: socialEvents.results,
      },
    },
    commerce: {
      entitlements: entitlements.results,
      orders: orders.results,
      orderItems: orderItems.results,
      refunds: refunds.results,
      preorders: preorders.results,
      subscriptions: subscriptions.results,
      giftCards: giftCards.results,
      storeCredit: storeCredit.results,
    },
    accountManagement: {
      addresses: addresses.results,
      preferences: preferences
        ? {
            ...preferences,
            privacy_json: json(preferences.privacy_json, {}),
            marketing_json: json(preferences.marketing_json, {}),
            notifications_json: json(preferences.notifications_json, {}),
          }
        : null,
      billingMethods: billingMethods.results,
      devices: devices.results,
      sessions: sessions.results,
      securityEvents: securityEvents.results.map((r: any) => ({
        ...r,
        event_json: json(r.event_json, {}),
      })),
    },
  };
}

type ErasureJob = {
  id: string;
  user_id: string;
  attempts: number;
  object_keys_json: string;
  storage_erased_at: string | null;
  database_erased_at: string | null;
  identity_erased_at: string | null;
};
async function maintainErasureLease(db: AccountDB, requestId: string, token: string) {
  const renewed = await db
    .prepare(
      "UPDATE account_deletion_requests SET lease_expires_at=? WHERE id=? AND lease_token=? AND status='executing' AND lease_expires_at>? RETURNING id",
    )
    .bind(new Date(Date.now() + 600000).toISOString(), requestId, token, now())
    .first<{ id: string }>();
  if (!renewed) throw new ApiError(409, "erasure_lease_lost");
}
export async function processAccountDeletionQueue(env: CoveEnv, limit = 25) {
  const db = env.DB,
    current = now();
  const rows = (
    await db
      .prepare(
        "SELECT id FROM account_deletion_requests WHERE status IN ('cooling_off','queued','executing','blocked_legal_hold') AND execute_after<=? AND (next_retry_at IS NULL OR next_retry_at<=?) AND (lease_expires_at IS NULL OR lease_expires_at<=?) ORDER BY execute_after LIMIT ?",
      )
      .bind(current, current, current, Math.max(1, Math.min(25, limit)))
      .all<{ id: string }>()
  ).results;
  let completed = 0,
    blocked = 0,
    retrying = 0;
  for (const candidate of rows) {
    const lease = crypto.randomUUID(),
      leaseUntil = new Date(Date.now() + 600000).toISOString();
    const r = await db
      .prepare(
        "UPDATE account_deletion_requests SET status='executing',lease_expires_at=?,lease_token=?,attempts=attempts+1,updated_at=? WHERE id=? AND status IN ('cooling_off','queued','executing','blocked_legal_hold') AND execute_after<=? AND (next_retry_at IS NULL OR next_retry_at<=?) AND (lease_expires_at IS NULL OR lease_expires_at<=?) RETURNING *",
      )
      .bind(leaseUntil, lease, now(), candidate.id, current, current, current)
      .first<ErasureJob>();
    if (!r) continue;
    try {
      const chargeback = await db
        .prepare(
          "SELECT 1 ok FROM commerce_orders WHERE user_id=? AND status IN ('disputed','chargeback_lost') LIMIT 1",
        )
        .bind(r.user_id)
        .first<any>();
      const activeSubscription = await db
        .prepare(
          "SELECT 1 ok FROM subscriptions WHERE user_id=? AND status IN ('active','trialing','past_due') LIMIT 1",
        )
        .bind(r.user_id)
        .first<any>();
      const activeStaff = await db
        .prepare("SELECT 1 ok FROM staff_principals WHERE user_id=? AND status='active' LIMIT 1")
        .bind(r.user_id)
        .first<any>();
      const publisherAuthority = await db
        .prepare(
          "SELECT 1 ok FROM publishing_account_members WHERE user_id=? AND status='active' AND role IN ('owner','admin') LIMIT 1",
        )
        .bind(r.user_id)
        .first<any>();
      const socialGroupOwner = await db
        .prepare(
          "SELECT 1 ok FROM reading_groups g WHERE g.owner_user_id=? AND g.deleted_at IS NULL AND g.status='active' AND (SELECT COUNT(*) FROM reading_group_members m WHERE m.group_id=g.id AND m.status='active')>1 LIMIT 1",
        )
        .bind(r.user_id)
        .first<any>();
      const legalReason = chargeback
        ? "Open payment dispute/chargeback record"
        : activeSubscription
          ? "Active subscription must be canceled before erasure"
          : activeStaff
            ? "Active staff identity must be deprovisioned before erasure"
            : publisherAuthority
              ? "Publisher ownership/admin authority must be transferred or removed before erasure"
              : socialGroupOwner
                ? "Reading-group ownership must be transferred before erasure"
                : "";
      if (legalReason) {
        await db
          .prepare(
            "UPDATE account_deletion_requests SET status='blocked_legal_hold',legal_hold_reason=?,updated_at=?,lease_expires_at=NULL,lease_token=NULL,next_retry_at=? WHERE id=?",
          )
          .bind(legalReason, now(), new Date(Date.now() + 86400000).toISOString(), r.id)
          .run();
        blocked++;
        continue;
      }

      const authRow = await db
        .prepare("SELECT provider_id FROM auth_accounts WHERE app_id=?")
        .bind(r.user_id)
        .first<{ provider_id: string }>();
      if (
        env.FORE_AUTH_MODE === "supabase" &&
        (!authRow?.provider_id ||
          !env.SUPABASE_URL ||
          (!env.FORE_INGESTION_SIGNING_KEY && !env.SUPABASE_SECRET_KEY))
      )
        throw new ApiError(503, "identity_configuration_missing");
      const at = now();
      await db
        .prepare("UPDATE auth_accounts SET disabled_at=COALESCE(disabled_at,?) WHERE app_id=?")
        .bind(at, r.user_id)
        .run();
      if (!r.storage_erased_at) {
        await maintainErasureLease(db, r.id, lease);
        const recorded = JSON.parse(r.object_keys_json) as string[];
        const imports = (
          await db
            .prepare("SELECT object_key FROM personal_imports WHERE user_id=?")
            .bind(r.user_id)
            .all<{ object_key: string }>()
        ).results
          .map((x) => x.object_key)
          .filter(Boolean);
        const orphaned: string[] = [];
        if (env.BUCKET?.list) {
          let cursor: string | undefined;
          do {
            await maintainErasureLease(db, r.id, lease);
            const page = await env.BUCKET.list({ prefix: `uploads/${r.user_id}/`, cursor });
            orphaned.push(...page.objects.map((object) => object.key));
            cursor = page.truncated ? page.cursor : undefined;
            if (page.truncated && !cursor) throw new ApiError(503, "storage_listing_incomplete");
          } while (cursor);
        }
        const keys = [...new Set([...recorded, ...imports, ...orphaned])];
        if (keys.length && !env.BUCKET) throw new ApiError(503, "storage_configuration_missing");
        await db
          .prepare(
            "UPDATE account_deletion_requests SET object_keys_json=?,cleanup_phase='storage',updated_at=? WHERE id=? AND lease_token=?",
          )
          .bind(JSON.stringify(keys), now(), r.id, lease)
          .run();
        for (const [index, key] of keys.entries()) {
          if (index % 25 === 0) await maintainErasureLease(db, r.id, lease);
          await env.BUCKET!.delete(key);
        }
        await db
          .prepare(
            "UPDATE account_deletion_requests SET storage_erased_at=?,updated_at=? WHERE id=? AND lease_token=?",
          )
          .bind(now(), now(), r.id, lease)
          .run();
      }
      if (!r.database_erased_at) {
        await maintainErasureLease(db, r.id, lease);
        const privateProducts = (
          await db
            .prepare(
              "SELECT p.id,p.edition_id,e.work_id,p.source_external_id FROM products p JOIN editions e ON e.id=p.edition_id AND e.release_status='private' WHERE p.source_name='upload' AND (EXISTS(SELECT 1 FROM personal_imports i WHERE i.product_id=p.id AND i.user_id=?) OR EXISTS(SELECT 1 FROM digital_assets a JOIN asset_versions v ON v.asset_id=a.id WHERE a.edition_id=e.id AND substr(v.object_key,1,length(?))=?)) AND NOT EXISTS(SELECT 1 FROM personal_imports other WHERE other.product_id=p.id AND other.user_id<>?)",
            )
            .bind(r.user_id, `uploads/${r.user_id}/`, `uploads/${r.user_id}/`, r.user_id)
            .all<{ id: string; edition_id: string; work_id: string; source_external_id: string }>()
        ).results;
        const ownedLists = (
          await db.prepare("SELECT id FROM social_lists WHERE user_id=?").bind(r.user_id).all<any>()
        ).results.map((x: any) => String(x.id));
        const ownedGroups = (
          await db
            .prepare("SELECT id FROM reading_groups WHERE owner_user_id=?")
            .bind(r.user_id)
            .all<any>()
        ).results.map((x: any) => String(x.id));
        for (const id of ownedLists)
          await db
            .prepare(
              "UPDATE social_posts SET deleted_at=COALESCE(deleted_at,?),body='[list removed]',updated_at=? WHERE context_type='list' AND context_id=?",
            )
            .bind(at, at, id)
            .run();
        for (const id of ownedGroups)
          await db
            .prepare(
              "UPDATE social_posts SET deleted_at=COALESCE(deleted_at,?),body='[group removed]',updated_at=? WHERE context_type='group' AND context_id=?",
            )
            .bind(at, at, id)
            .run();
        await db.batch([
          db.prepare("DELETE FROM notification_inbox WHERE user_id=?").bind(r.user_id),
          db.prepare("DELETE FROM notification_delivery_jobs WHERE user_id=?").bind(r.user_id),
          db.prepare("DELETE FROM storefront_user_preferences WHERE user_id=?").bind(r.user_id),
          db.prepare("DELETE FROM notification_events WHERE user_id=?").bind(r.user_id),
          db.prepare("DELETE FROM notification_push_endpoints WHERE user_id=?").bind(r.user_id),
          db.prepare("DELETE FROM notification_preferences WHERE user_id=?").bind(r.user_id),
          db.prepare("DELETE FROM text_bookmarks WHERE user_id=?").bind(r.user_id),
          db.prepare("DELETE FROM sync_records WHERE user_id=?").bind(r.user_id),
          db.prepare("DELETE FROM sync_mutations WHERE user_id=?").bind(r.user_id),
          db.prepare("DELETE FROM sync_conflicts WHERE user_id=?").bind(r.user_id),
          db.prepare("DELETE FROM reader_settings WHERE user_id=?").bind(r.user_id),
          db.prepare("DELETE FROM sync_clients WHERE user_id=?").bind(r.user_id),
          db
            .prepare("DELETE FROM reading_journey_recipients WHERE recipient_user_id=?")
            .bind(r.user_id),
          db.prepare("DELETE FROM reading_journeys WHERE user_id=?").bind(r.user_id),
          db.prepare("DELETE FROM reading_progress_events WHERE user_id=?").bind(r.user_id),
          db.prepare("DELETE FROM account_legal_consents WHERE user_id=?").bind(r.user_id),
          db
            .prepare("DELETE FROM pending_account_legal_consents WHERE provider_id=?")
            .bind(authRow?.provider_id || ""),
          db
            .prepare("DELETE FROM social_annotation_shares WHERE recipient_user_id=?")
            .bind(r.user_id),
          db
            .prepare(
              "UPDATE social_posts SET deleted_at=COALESCE(deleted_at,?),body='[withdrawn]',passage_text='',recipient_user_id=NULL,moderation_status='removed',updated_at=? WHERE recipient_user_id=? OR user_id=?",
            )
            .bind(at, at, r.user_id, r.user_id),
          db.prepare("DELETE FROM customer_support_tickets WHERE user_id=?").bind(r.user_id),
          db.prepare("DELETE FROM social_post_reactions WHERE user_id=?").bind(r.user_id),
          db
            .prepare("DELETE FROM social_follows WHERE follower_user_id=? OR followed_user_id=?")
            .bind(r.user_id, r.user_id),
          db
            .prepare(
              "DELETE FROM social_follow_requests WHERE requester_user_id=? OR target_user_id=?",
            )
            .bind(r.user_id, r.user_id),
          db
            .prepare("DELETE FROM social_blocks WHERE blocker_user_id=? OR blocked_user_id=?")
            .bind(r.user_id, r.user_id),
          db
            .prepare("DELETE FROM social_mutes WHERE muter_user_id=? OR muted_user_id=?")
            .bind(r.user_id, r.user_id),
          db.prepare("DELETE FROM profile_top_books WHERE user_id=?").bind(r.user_id),
          db.prepare("DELETE FROM social_annotation_shares WHERE user_id=?").bind(r.user_id),
          db.prepare("DELETE FROM social_events WHERE user_id=?").bind(r.user_id),
          db.prepare("DELETE FROM social_reader_preferences WHERE user_id=?").bind(r.user_id),
          db.prepare("DELETE FROM social_list_likes WHERE user_id=?").bind(r.user_id),
          db.prepare("DELETE FROM social_list_saves WHERE user_id=?").bind(r.user_id),
          db
            .prepare(
              "UPDATE social_posts SET user_id='deleted:'||substr(id,1,24),body='[deleted account]',passage_text='',updated_at=? WHERE user_id=?",
            )
            .bind(at, r.user_id),
          db
            .prepare("UPDATE social_audit_events SET actor_user_id=NULL WHERE actor_user_id=?")
            .bind(r.user_id),
          db
            .prepare(
              "UPDATE author_social_posts SET created_by_user_id='deleted:'||substr(id,1,24) WHERE created_by_user_id=?",
            )
            .bind(r.user_id),
          db.prepare("DELETE FROM social_lists WHERE user_id=?").bind(r.user_id),
          db.prepare("DELETE FROM reading_groups WHERE owner_user_id=?").bind(r.user_id),
          db.prepare("DELETE FROM reading_group_members WHERE user_id=?").bind(r.user_id),
          db.prepare("DELETE FROM social_profiles WHERE user_id=?").bind(r.user_id),
          db.prepare("DELETE FROM review_hearts WHERE user_id=?").bind(r.user_id),
          db.prepare("DELETE FROM reviews WHERE user_id=?").bind(r.user_id),
          db.prepare("DELETE FROM annotations WHERE user_id=?").bind(r.user_id),
          db.prepare("DELETE FROM definitions WHERE user_id=?").bind(r.user_id),
          db.prepare("DELETE FROM reading_sessions WHERE user_id=?").bind(r.user_id),
          db.prepare("DELETE FROM reading_states WHERE user_id=?").bind(r.user_id),
          db.prepare("DELETE FROM reading_goals WHERE user_id=?").bind(r.user_id),
          db.prepare("DELETE FROM book_metrics WHERE user_id=?").bind(r.user_id),
          db.prepare("DELETE FROM completion_events WHERE user_id=?").bind(r.user_id),
          db.prepare("DELETE FROM playback WHERE user_id=?").bind(r.user_id),
          db.prepare("DELETE FROM biosync_positions WHERE user_id=?").bind(r.user_id),
          db.prepare("DELETE FROM commercial_audio_playback WHERE user_id=?").bind(r.user_id),
          db.prepare("DELETE FROM commercial_biosync_positions WHERE user_id=?").bind(r.user_id),
          db.prepare("DELETE FROM author_follow_preferences WHERE user_id=?").bind(r.user_id),
          db.prepare("DELETE FROM author_follows WHERE user_id=?").bind(r.user_id),
          db.prepare("DELETE FROM wishlist_events WHERE user_id=?").bind(r.user_id),
          db.prepare("DELETE FROM wishlist_items WHERE user_id=?").bind(r.user_id),
          db.prepare("DELETE FROM wishlist_profiles WHERE user_id=?").bind(r.user_id),
          db.prepare("DELETE FROM preview_states WHERE user_id=?").bind(r.user_id),
          db.prepare("DELETE FROM shopping_carts WHERE user_id=?").bind(r.user_id),
          db.prepare("DELETE FROM shelves WHERE user_id=?").bind(r.user_id),
          db.prepare("DELETE FROM matching_feedback WHERE user_id=?").bind(r.user_id),
          db.prepare("DELETE FROM matching_preferences WHERE user_id=?").bind(r.user_id),
          db.prepare("DELETE FROM recommendation_feedback WHERE user_id=?").bind(r.user_id),
          db.prepare("DELETE FROM recommendation_requests WHERE user_id=?").bind(r.user_id),
          db.prepare("DELETE FROM recommendation_events WHERE user_id=?").bind(r.user_id),
          db.prepare("DELETE FROM recommendation_user_features WHERE user_id=?").bind(r.user_id),
          db.prepare("DELETE FROM recommendation_taste_controls WHERE user_id=?").bind(r.user_id),
          db
            .prepare("DELETE FROM recommendation_learning_boundaries WHERE user_id=?")
            .bind(r.user_id),
          db.prepare("DELETE FROM recommendation_privacy WHERE user_id=?").bind(r.user_id),
          db.prepare("DELETE FROM search_query_events WHERE user_id=?").bind(r.user_id),
          db.prepare("DELETE FROM merch_events WHERE user_id=?").bind(r.user_id),
          db.prepare("DELETE FROM personal_export_events WHERE user_id=?").bind(r.user_id),
          db.prepare("DELETE FROM personal_imports WHERE user_id=?").bind(r.user_id),
          db.prepare("DELETE FROM account_addresses WHERE user_id=?").bind(r.user_id),
          db.prepare("DELETE FROM account_preferences WHERE user_id=?").bind(r.user_id),
          db.prepare("DELETE FROM account_billing_methods WHERE user_id=?").bind(r.user_id),
          db.prepare("DELETE FROM account_gift_card_wallet WHERE user_id=?").bind(r.user_id),
          db.prepare("DELETE FROM profiles WHERE user_id=?").bind(r.user_id),
          db
            .prepare(
              "UPDATE audio_offline_licenses SET status='revoked',revoked_at=COALESCE(revoked_at,?),revocation_reason=CASE WHEN revocation_reason='' THEN 'account_deleted' ELSE revocation_reason END WHERE user_id=? AND status='active'",
            )
            .bind(at, r.user_id),
          db
            .prepare("UPDATE commerce_customers SET email='',updated_at=? WHERE user_id=?")
            .bind(at, r.user_id),
          db
            .prepare(
              "UPDATE account_sessions SET revoked_at=COALESCE(revoked_at,?),revoked_reason='account_deleted' WHERE user_id=?",
            )
            .bind(at, r.user_id),
          db
            .prepare(
              "UPDATE devices SET device_key='deleted:'||id,name='',platform='',revoked_at=COALESCE(revoked_at,?) WHERE user_id=?",
            )
            .bind(at, r.user_id),
          ...privateProducts.flatMap((product) => [
            db
              .prepare(
                "DELETE FROM external_identifiers WHERE entity_type='product' AND entity_id=?",
              )
              .bind(product.id),
            db.prepare("DELETE FROM products WHERE id=? AND source_name='upload'").bind(product.id),
            db
              .prepare("DELETE FROM editions WHERE id=? AND release_status='private'")
              .bind(product.edition_id),
            db
              .prepare(
                "DELETE FROM works WHERE id=? AND NOT EXISTS(SELECT 1 FROM editions WHERE work_id=?)",
              )
              .bind(product.work_id, product.work_id),
            db
              .prepare(
                "DELETE FROM contributors WHERE id=? AND NOT EXISTS(SELECT 1 FROM edition_contributors WHERE contributor_id=?)",
              )
              .bind(
                `con_upload_${product.source_external_id}`,
                `con_upload_${product.source_external_id}`,
              ),
          ]),
          db
            .prepare(
              "UPDATE auth_accounts SET email=?,username=NULL,disabled_at=COALESCE(disabled_at,?) WHERE app_id=?",
            )
            .bind(`deleted+${r.user_id.replace(/[^a-zA-Z0-9]/g, "")}@invalid.fore`, at, r.user_id),
        ]);

        await db
          .prepare(
            "UPDATE account_deletion_requests SET database_erased_at=?,cleanup_phase='identity',updated_at=? WHERE id=? AND lease_token=?",
          )
          .bind(now(), now(), r.id, lease)
          .run();
      }
      if (!r.identity_erased_at) {
        await maintainErasureLease(db, r.id, lease);
        if (env.FORE_AUTH_MODE === "supabase")
          await eraseProviderIdentity(env, authRow!.provider_id, r.user_id, r.id);
        await db
          .prepare(
            "UPDATE account_deletion_requests SET identity_erased_at=?,updated_at=? WHERE id=? AND lease_token=?",
          )
          .bind(now(), now(), r.id, lease)
          .run();
      }
      const done = await db
        .prepare(
          "UPDATE account_deletion_requests SET status='completed',cleanup_phase='complete',completed_at=?,updated_at=?,lease_expires_at=NULL,lease_token=NULL,next_retry_at=NULL,last_error_code='',legal_hold_reason='',object_keys_json='[]' WHERE id=? AND lease_token=? AND storage_erased_at IS NOT NULL AND database_erased_at IS NOT NULL AND identity_erased_at IS NOT NULL RETURNING id",
        )
        .bind(now(), now(), r.id, lease)
        .first<{ id: string }>();
      if (done) completed++;
    } catch (error) {
      const code =
        error instanceof ApiError && /^[a-z_]+$/.test(error.message)
          ? error.message
          : "cleanup_failed";
      const retry = new Date(
        Date.now() + Math.min(86400000, 60000 * Math.pow(2, Math.min(r.attempts, 10))),
      ).toISOString();
      await db
        .prepare(
          "UPDATE account_deletion_requests SET status='queued',lease_expires_at=NULL,lease_token=NULL,next_retry_at=?,last_error_code=?,updated_at=? WHERE id=? AND lease_token=?",
        )
        .bind(retry, code, now(), r.id, lease)
        .run();
      retrying++;
      console.error(
        JSON.stringify({
          event: "account_erasure_retry",
          requestId: r.id,
          code,
          attempt: r.attempts,
        }),
      );
    }
  }
  return { processed: rows.length, completed, blocked, retrying };
}
