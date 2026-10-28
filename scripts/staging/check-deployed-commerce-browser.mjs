// Opt-in deployed-browser acceptance. NEVER target production or use live Stripe.
// The origin, users, media fixtures and keys must be provisioned out of band.
// The workflow must FAIL, not substitute local module-level identity mocks.
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import fs from "node:fs";
import { chromium } from "playwright";
import JSZip from "jszip";
import { qaD1, provisionQaRefundOperator, revokeQaRefundOperator } from "./qa-refund-operator.mjs";

const required = [
  "COVE_QA_DEPLOYED_ORIGIN",
  "COVE_QA_BUYER_EMAIL",
  "COVE_QA_BUYER_PASSWORD",
  "COVE_QA_OUTSIDER_EMAIL",
  "COVE_QA_OUTSIDER_PASSWORD",
  "COVE_QA_EPUB_PRODUCT_ID",
  "COVE_QA_AUDIO_PRODUCT_ID",
  "COVE_QA_AUDIO_PUBLIC_ID",
  "COVE_QA_AUDIO_TRACK_ID",
  "COVE_SANDBOX_SECRET_KEY",
  "CLOUDFLARE_API_TOKEN",
];
const missing = required.filter((name) => !process.env[name]);
assert.equal(
  missing.length,
  0,
  "Deployed acceptance requires protected QA configuration: " + missing.join(", "),
);
const q = process.env;
const origin = new URL(q.COVE_QA_DEPLOYED_ORIGIN);
assert.equal(origin.protocol, "https:");
assert.equal(origin.pathname, "/");
assert.match(origin.hostname, /(?:^|[.-])(?:qa|staging)(?:[.-])/i);
// Allow only this one disposable, ingress-gated Cloudflare Worker as a
// temporary test origin. Other workers.dev hosts remain rejected.
const isEphemeralQaWorker =
  origin.hostname === "cove-commerce-customer-qa-stage.cove-jibrilmohamud.workers.dev";
if (isEphemeralQaWorker) {
  assert.match(
    q.COVE_QA_STAGE_BEARER || "",
    /^[a-f0-9]{64}$/,
    "Temporary Cloudflare QA worker requires its rotating ingress bearer",
  );
} else {
  assert.ok(!origin.hostname.endsWith(".workers.dev"), "Untrusted Worker test origin");
}
assert.ok(!origin.hostname.includes("www.cove"));
assert.match(q.COVE_SANDBOX_SECRET_KEY, /^(sk|rk|rkcs)_test_/);
assert.notEqual(q.COVE_QA_BUYER_EMAIL.toLowerCase(), q.COVE_QA_OUTSIDER_EMAIL.toLowerCase());
assert.match(q.COVE_QA_AUDIO_PUBLIC_ID, /^ca_[a-zA-Z0-9_-]+$/);
assert.notEqual(q.COVE_QA_EPUB_PRODUCT_ID, q.COVE_QA_AUDIO_PRODUCT_ID);

const stripeHeaders = { authorization: "Bearer " + q.COVE_SANDBOX_SECRET_KEY };
async function stripe(method, path, body) {
  const response = await fetch("https://api.stripe.com/v1/" + path, {
    method,
    headers: {
      ...stripeHeaders,
      ...(body ? { "content-type": "application/x-www-form-urlencoded" } : {}),
    },
    ...(body ? { body: new URLSearchParams(body) } : {}),
    signal: AbortSignal.timeout(20000),
  });
  const data = await response.json();
  assert.ok(response.ok, "Stripe test operation failed (" + response.status + ")");
  return data;
}
const account = await stripe("GET", "account");
assert.equal(account.id, "acct_1UTG66ErdufyFpJN", "Only Cove Stripe TEST account is permitted");

const browser = await chromium.launch({ headless: true });
const contexts = [];
const payments = [];
const refunded = new Set();
let refundOperatorId = null;
let refundOperatorPage = null;
const report = {
  revision: process.env.GITHUB_SHA || "unreported",
  target: "protected isolated QA origin",
  stripeMode: "test",
  buyerAuthenticated: false,
  outsiderAuthenticated: false,
  protectedEpub: false,
  signedOfflineEpub: false,
  offlineBuyerDeviceBound: false,
  offlineRefundDenied: false,
  playableAudio: false,
  outsiderDenied: false,
  refundRevoked: false,
};
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, label, duration = 60000) {
  const end = Date.now() + duration;
  while (Date.now() < end) {
    const r = await check();
    if (r) return r;
    await delay(750);
  }
  throw Error(label + " failed or timed out on deployed QA (no synthetic shortcut)");
}
function qaIngressHeaders() {
  const headers = {};
  if (q.COVE_QA_VERCEL_PROTECTION_BYPASS)
    headers["x-vercel-protection-bypass"] = q.COVE_QA_VERCEL_PROTECTION_BYPASS;
  if (q.COVE_QA_STAGE_BEARER) {
    assert.match(q.COVE_QA_STAGE_BEARER, /^[a-f0-9]{64}$/);
    headers.authorization = "Bearer " + q.COVE_QA_STAGE_BEARER;
  }
  return headers;
}
async function openUser(email, password) {
  const context = await browser.newContext({
    extraHTTPHeaders: qaIngressHeaders(),
    locale: "en-US",
  });
  contexts.push(context);
  const page = await context.newPage();
  const navigated = await page.goto(origin.href, { waitUntil: "domcontentloaded" });
  assert.equal(navigated.status(), 200, "QA preview must be browser-accessible");
  const login = await request(page, "POST", "/auth/login", { login: email, password });
  // Log status only: never echo account email, password, session cookies or
  // arbitrary provider error responses into CI logs.
  console.log(
    "QA_AUTH_LOGIN",
    login.status,
    login.data?.signedIn === true,
    login.appHeader === true ? "cove-api" : "non-api-response",
    login.finalPath === "/api/fore/auth/login" ? "expected-route" : "unexpected-route",
    login.redirected === true ? "redirected" : "direct",
  );
  assert.equal(
    login.status,
    200,
    login.status === 401
      ? "Deployed Cove rejected the QA password or unconfirmed identity; verify Supabase QA users and four GitHub Actions QA credentials"
      : "Deployed Cove auth routing failed; check API readiness and request status",
  );
  assert.equal(login.data.signedIn, true);
  assert.notEqual(login.data.mfaRequired, true, "MFA QA login requires a genuine second factor");
  return page;
}
async function request(page, method, route, body) {
  assert.ok(
    route.startsWith("/") &&
      !route.startsWith("//") &&
      !route.includes("..") &&
      !route.includes("#"),
    "QA API route must be local",
  );
  // BrowserContext.request shares the actual browser cookie jar (including
  // Supabase session cookies), but survives page navigation or hydration.
  // Never replay a checkout, signed payment or refund after it was dispatched.
  const url = new URL("/api/fore" + route, origin);
  assert.equal(url.origin, origin.origin, "QA API must remain same-origin");
  const response = await page.context().request.fetch(url.toString(), {
    method,
    headers: {
      ...qaIngressHeaders(),
      origin: origin.origin,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(body !== undefined ? { data: JSON.stringify(body) } : {}),
    maxRedirects: 0,
    timeout: 30000,
  });
  const raw = await response.text();
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    data = null;
  }
  return {
    status: response.status(),
    data,
    mime: response.headers()["content-type"] || null,
    appHeader: Object.hasOwn(response.headers(), "x-fore-request-id"),
    finalPath: new URL(response.url()).pathname,
    redirected: response.status() >= 300 && response.status() < 400,
  };
}
function expectDenied(out, label) {
  assert.ok([401, 403, 404].includes(out.status), label + " must deny (status " + out.status + ")");
}
async function verifyConfig(page) {
  const conf = await request(page, "GET", "/checkout/config");
  assert.equal(conf.status, 200);
  assert.equal(conf.data.livemode, false, "Deployed backend is not in TEST mode");
  assert.equal(conf.data.stripeReady, true);
  assert.match(conf.data.publishableKey, /^pk_test_/);
}
const billingAddress = {
  name: "Cove Synthetic QA",
  line1: "1 Original Fixture Lane",
  city: "Richmond",
  state: "VA",
  postalCode: "23220",
  country: "US",
};
// Isolated QA accounts persist between runs, unlike their synthetic purchase
// fixtures. Clear ONLY fixture products from the authenticated QA buyer cart,
// and fail closed if an unexpected product is present. This must never target
// production or another user's cart.
async function clearStaleQaFixtureCart(userId) {
  assert.match(userId, /^sb:[a-f0-9-]{36}$/);
  assert.equal(origin.hostname, "cove-commerce-customer-qa-stage.cove-jibrilmohamud.workers.dev");
  const knownProducts = new Set([q.COVE_QA_EPUB_PRODUCT_ID, q.COVE_QA_AUDIO_PRODUCT_ID]);
  const previous = await qaD1(
    "SELECT i.product_id FROM shopping_cart_items i JOIN shopping_carts c ON c.id=i.cart_id WHERE c.user_id=? LIMIT 20",
    [userId],
  );
  assert.ok(previous.length <= 2, "Unexpected existing QA cart size; never clear arbitrary items");
  assert.ok(
    previous.every((row) => knownProducts.has(row.product_id)),
    "Unexpected QA cart product; refuse automatic cleanup",
  );
  if (previous.length) {
    await qaD1(
      "DELETE FROM shopping_cart_items WHERE cart_id IN (SELECT id FROM shopping_carts WHERE user_id=?) AND product_id IN (?,?)",
      [userId, q.COVE_QA_EPUB_PRODUCT_ID, q.COVE_QA_AUDIO_PRODUCT_ID],
    );
  }
  const remaining = await qaD1(
    "SELECT COUNT(*) n FROM shopping_cart_items i JOIN shopping_carts c ON c.id=i.cart_id WHERE c.user_id=?",
    [userId],
  );
  assert.equal(Number(remaining[0]?.n || 0), 0, "QA buyer cart not emptied");
  console.log("QA_SYNTHETIC_CART_RESET", previous.length);
}

async function purchase(page, productId) {
  const cart = await request(page, "GET", "/cart");
  console.log("QA_CART_PROBE", cart.status, cart.appHeader, cart.finalPath, cart.mime);
  assert.equal(cart.status, 200);
  assert.ok(
    !cart.data?.items?.length,
    "QA account cart must start empty; never buy existing items",
  );
  const item = await request(page, "POST", "/cart/item", { productId });
  assert.ok(item.status >= 200 && item.status < 300);
  const quote = await request(page, "POST", "/checkout/quote", {
    territory: "US",
    billingAddress,
    useStoreCredit: false,
  });
  assert.equal(quote.status, 200);
  assert.ok(quote.data?.id);
  const idem = "qa-deployed-" + randomUUID();
  const pay = await request(page, "POST", "/checkout/payment", {
    quoteId: quote.data.id,
    idempotencyKey: idem,
  });
  assert.equal(pay.status, 200);
  assert.match(pay.data?.paymentIntentId, /^pi_/);
  const repeated = await request(page, "POST", "/checkout/payment", {
    quoteId: quote.data.id,
    idempotencyKey: idem,
  });
  assert.equal(repeated.data?.paymentIntentId, pay.data.paymentIntentId);
  const intent = await stripe("GET", "payment_intents/" + pay.data.paymentIntentId);
  assert.equal(intent.livemode, false);
  assert.ok(intent.amount > 0 && intent.amount <= 500, "Synthetic QA maximum is $5");
  assert.equal(intent.currency, "usd");
  payments.push({ intentId: pay.data.paymentIntentId, orderId: pay.data.orderId });
  const confirmed = await stripe("POST", "payment_intents/" + intent.id + "/confirm", {
    payment_method: "pm_card_visa",
    return_url: origin.href,
  });
  assert.equal(confirmed.status, "succeeded");
  assert.equal(confirmed.livemode, false);
  return { intentId: intent.id, orderId: pay.data.orderId };
}
async function refundAndVerify(adminPage, purchase, checkRevoked) {
  // Run the SAME commerce refund path used by Cove's staff. Directly calling
  // Stripe refunds does not create Cove's commerce_refunds ledger row and
  // therefore cannot certify its real revocation behavior.
  const returned = await request(adminPage, "POST", "/admin/commerce/refund", {
    orderId: purchase.orderId,
    reason: "requested_by_customer",
    idempotencyKey: "qa-refund-" + randomUUID(),
  });
  assert.equal(returned.status, 200, "Authorized Cove refund endpoint rejected QA request");
  assert.ok(["pending", "succeeded"].includes(returned.data?.status));
  refunded.add(purchase.intentId);
  await until(async () => {
    const rows = await qaD1("SELECT status FROM commerce_orders WHERE id=?", [purchase.orderId]);
    return rows[0]?.status === "refunded" && (await checkRevoked());
  }, "Real Cove refund must update order, entitlement and protected access");
}
try {
  const buyer = await openUser(q.COVE_QA_BUYER_EMAIL, q.COVE_QA_BUYER_PASSWORD);
  const outsider = await openUser(q.COVE_QA_OUTSIDER_EMAIL, q.COVE_QA_OUTSIDER_PASSWORD);
  report.buyerAuthenticated = true;
  report.outsiderAuthenticated = true;
  await verifyConfig(buyer);
  const buyerAccount = await request(buyer, "GET", "/account");
  assert.equal(buyerAccount.status, 200);
  const buyerId = String(buyerAccount.data?.user?.id || "");
  assert.ok(
    buyerId,
    "Authenticated buyer identity required to certify device-bound offline receipt",
  );
  await clearStaleQaFixtureCart(buyerId);
  const outsiderAccount = await request(outsider, "GET", "/account");
  assert.equal(outsiderAccount.status, 200);
  refundOperatorId = outsiderAccount.data?.user?.id || null;
  await provisionQaRefundOperator(refundOperatorId);
  refundOperatorPage = outsider;
  // A normal authenticated buyer is still prohibited from refunding even
  // their own order. The QA staff subject exists ONLY in the isolated D1.
  expectDenied(
    await request(buyer, "POST", "/admin/commerce/refund", {
      orderId: "ord_" + randomUUID(),
      idempotencyKey: "qa-denied-" + randomUUID(),
    }),
    "Buyer must not have commerce-admin refund privilege",
  );
  const anonymous = await browser.newContext({ extraHTTPHeaders: qaIngressHeaders() });
  contexts.push(anonymous);
  const guest = await anonymous.newPage();
  await guest.goto(origin.href, { waitUntil: "domcontentloaded" });
  expectDenied(
    await request(guest, "POST", "/delivery/epub/grant", {
      productId: q.COVE_QA_EPUB_PRODUCT_ID,
      purpose: "read",
    }),
    "Guest EPUB grant",
  );
  expectDenied(
    await request(outsider, "POST", "/delivery/epub/grant", {
      productId: q.COVE_QA_EPUB_PRODUCT_ID,
      purpose: "read",
    }),
    "Outsider EPUB grant before purchase",
  );
  const ebook = await purchase(buyer, q.COVE_QA_EPUB_PRODUCT_ID);
  await until(async () => {
    const result = await request(
      buyer,
      "GET",
      "/delivery/ownership?productId=" + encodeURIComponent(q.COVE_QA_EPUB_PRODUCT_ID),
    );
    if (result.status !== 200 || result.data?.entitlement?.status !== "active") return false;
    const source = await qaD1(
      `SELECT e.status FROM entitlements e
       JOIN commerce_order_items oi ON oi.id=e.order_item_id
       WHERE oi.order_id=? AND e.product_id=?`,
      [ebook.orderId, q.COVE_QA_EPUB_PRODUCT_ID],
    );
    return source.length === 1 && source[0].status === "active";
  }, "Signed webhook fulfillment and NEW order-linked owner entitlement");
  const grant = await request(buyer, "POST", "/delivery/epub/grant", {
    productId: q.COVE_QA_EPUB_PRODUCT_ID,
    purpose: "read",
  });
  assert.equal(grant.status, 201);
  const grantUrl = new URL(grant.data?.url, origin);
  assert.equal(grantUrl.origin, origin.origin);
  const book = await buyer.evaluate(async (path) => {
    const r = await fetch(path, { credentials: "include" });
    return { status: r.status, bytes: Array.from(new Uint8Array(await r.arrayBuffer())) };
  }, grantUrl.pathname + grantUrl.search);
  assert.equal(book.status, 200);
  const epub = await JSZip.loadAsync(Uint8Array.from(book.bytes));
  const chapter = epub.file("chapter.xhtml");
  assert.ok(chapter, "Deployed fixture must be a real synthetic EPUB");
  assert.match(await chapter.async("string"), /Original synthetic content/);
  report.protectedEpub = true;
  // Original Cove offline EPUB API: device registration, seven-day P-256
  // signed receipt, buyer/device/product binding and real issuer's EPUB URL.
  const deviceKey = "qa-" + randomUUID();
  const device = await request(buyer, "POST", "/account/device/register", {
    deviceKey,
    name: "Isolated offline EPUB QA",
    platform: "playwright-test",
  });
  assert.equal(device.status, 200, "Original device registration must succeed");
  assert.ok(device.data?.id, "Original device record must have an ID");
  const verifiedKey = await request(buyer, "GET", "/offline-epub/verification-key");
  assert.equal(verifiedKey.status, 200);
  assert.ok(verifiedKey.data?.publicKey?.x && verifiedKey.data?.publicKey?.y);
  assert.match(String(verifiedKey.data?.keyId || ""), /^[a-f0-9]{64}$/);
  const offline = await request(buyer, "POST", "/offline-epub/license", {
    productId: q.COVE_QA_EPUB_PRODUCT_ID,
    deviceKey,
  });
  assert.equal(offline.status, 201, "Actual offline EPUB issuer must return signed receipt");
  const offlineClaims = JSON.parse(
    Buffer.from(offline.data.receipt.payload, "base64url").toString("utf8"),
  );
  const signatureKey = await crypto.subtle.importKey(
    "jwk",
    verifiedKey.data.publicKey,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  );
  const signatureOkay = await crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    signatureKey,
    Buffer.from(offline.data.receipt.signature, "base64url"),
    new TextEncoder().encode("cove-offline-epub:v1\n" + offline.data.receipt.payload),
  );
  assert.equal(signatureOkay, true, "Actual seven-day receipt signature must verify");
  assert.equal(offline.data.receipt.keyId, verifiedKey.data.keyId);
  assert.equal(offlineClaims.keyId, verifiedKey.data.keyId);
  assert.equal(offlineClaims.audience, "cove-offline-epub");
  assert.equal(offlineClaims.userId, buyerId);
  assert.equal(offlineClaims.productId, q.COVE_QA_EPUB_PRODUCT_ID);
  assert.equal(
    offlineClaims.deviceKeyHash,
    createHash("sha256").update(deviceKey).digest("hex"),
    "Offline receipt must be bound to the registered buyer device",
  );
  assert.equal(offlineClaims.assetVersionId, offline.data.assetVersionId);
  assert.ok(offlineClaims.licenseId);
  const lifetime = Date.parse(offlineClaims.expiresAt) - Date.parse(offlineClaims.issuedAt);
  assert.equal(lifetime, 7 * 24 * 60 * 60 * 1000);
  assert.equal(offlineClaims.expiresAt, offline.data.expiresAt);
  assert.equal(new URL(offline.data.url, origin).origin, origin.origin);
  report.signedOfflineEpub = true;
  // The original offline issuer correctly returns 428 when a device was
  // never registered. Prove the stronger condition too: even a separately
  // registered outsider cannot obtain this purchaser's signed offline book.
  const outsiderDeviceKey = "qa-" + randomUUID();
  const outsiderDevice = await request(outsider, "POST", "/account/device/register", {
    deviceKey: outsiderDeviceKey,
    name: "Isolated unentitled outsider device",
    platform: "playwright-test",
  });
  assert.equal(outsiderDevice.status, 200);
  assert.ok(outsiderDevice.data?.id);
  expectDenied(
    await request(outsider, "POST", "/offline-epub/license", {
      productId: q.COVE_QA_EPUB_PRODUCT_ID,
      deviceKey: outsiderDeviceKey,
    }),
    "Registered but unentitled outsider offline EPUB license",
  );
  const outsiderDeviceRevoked = await request(outsider, "POST", "/account/device/revoke", {
    deviceId: outsiderDevice.data.id,
  });
  assert.equal(outsiderDeviceRevoked.status, 200);
  report.offlineBuyerDeviceBound = true;
  expectDenied(
    await request(outsider, "POST", "/delivery/epub/grant", {
      productId: q.COVE_QA_EPUB_PRODUCT_ID,
      purpose: "read",
    }),
    "Outsider EPUB grant after another user purchased",
  );
  const audiobook = await purchase(buyer, q.COVE_QA_AUDIO_PRODUCT_ID);
  const audioPath =
    "/audio/" +
    encodeURIComponent(q.COVE_QA_AUDIO_PUBLIC_ID) +
    "/tracks/" +
    encodeURIComponent(q.COVE_QA_AUDIO_TRACK_ID);
  expectDenied(await request(outsider, "GET", audioPath), "Outsider audio chapter");
  await until(async () => {
    if ((await request(buyer, "GET", audioPath)).status !== 200) return false;
    const source = await qaD1(
      `SELECT e.status FROM entitlements e
       JOIN commerce_order_items oi ON oi.id=e.order_item_id
       WHERE oi.order_id=? AND e.product_id=?`,
      [audiobook.orderId, q.COVE_QA_AUDIO_PRODUCT_ID],
    );
    return source.length === 1 && source[0].status === "active";
  }, "Signed webhook and new audio order-linked entitlement");
  const playable = await buyer.evaluate(async (route) => {
    const response = await fetch("/api/fore" + route, { credentials: "include" });
    if (response.status !== 200) return false;
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength < 128) return false;
    const mime = response.headers.get("content-type") || "audio/wav";
    const blobUrl = URL.createObjectURL(new Blob([buffer], { type: mime }));
    const audio = new Audio(blobUrl);
    const button = document.createElement("button");
    button.type = "button";
    button.id = "cove-qa-begin-audio";
    button.textContent = "Start QA audio playback";
    // Keep the input visible and clickable even when Cove's application
    // stylesheet hides empty or unstyled buttons. Playwright must dispatch
    // an actual user click; no synthetic autoplay exemption is acceptable.
    button.style.cssText =
      "position:fixed;inset:12px auto auto 12px;z-index:2147483647;" +
      "display:block;visibility:visible;opacity:1;pointer-events:auto;" +
      "padding:12px;background:#fff;color:#000;border:2px solid #000;";
    audio.preload = "auto";
    window.__coveQaAudio = audio;
    window.__coveQaAudioUrl = blobUrl;
    window.__coveQaPlayback = "pending";
    button.addEventListener("click", () => {
      audio.addEventListener(
        "playing",
        () => {
          window.__coveQaPlayback = "playing";
        },
        { once: true },
      );
      audio.addEventListener(
        "error",
        () => {
          window.__coveQaPlayback = "error";
        },
        { once: true },
      );
      void audio.play().catch(() => {
        window.__coveQaPlayback = "error";
      });
    });
    document.body.appendChild(button);
    return true;
  }, audioPath);
  assert.equal(playable, true, "Audio chapter must return genuine playable bytes");
  // Audio activation is a real browser click, never a synthetic autoplay
  // exception or a HEAD-only media check.
  await buyer.click("#cove-qa-begin-audio");
  await buyer.waitForFunction(() => window.__coveQaPlayback !== "pending", null, {
    timeout: 10000,
  });
  assert.equal(
    await buyer.evaluate(() => window.__coveQaPlayback),
    "playing",
    "Actual HTML5 audio playback must start after a user gesture",
  );
  await buyer.evaluate(() => {
    window.__coveQaAudio.pause();
    URL.revokeObjectURL(window.__coveQaAudioUrl);
  });
  report.playableAudio = true;
  report.outsiderDenied = true;
  await refundAndVerify(refundOperatorPage, ebook, async () => {
    const own = await request(
      buyer,
      "GET",
      "/delivery/ownership?productId=" + encodeURIComponent(q.COVE_QA_EPUB_PRODUCT_ID),
    );
    return own.status !== 200 || own.data?.entitlement?.status !== "active";
  });
  expectDenied(
    await request(buyer, "POST", "/delivery/epub/grant", {
      productId: q.COVE_QA_EPUB_PRODUCT_ID,
      purpose: "read",
    }),
    "Refunded EPUB new grant",
  );
  expectDenied(
    await request(buyer, "POST", "/offline-epub/license", {
      productId: q.COVE_QA_EPUB_PRODUCT_ID,
      deviceKey,
    }),
    "Refunded EPUB cannot issue a new offline license",
  );
  report.offlineRefundDenied = true;
  const revokedDevice = await request(buyer, "POST", "/account/device/revoke", {
    deviceId: device.data.id,
  });
  assert.equal(revokedDevice.status, 200, "QA device must be revoked after offline issuance");
  const oldGrant = await buyer.evaluate(
    async (path) => (await fetch(path, { credentials: "include" })).status,
    grantUrl.pathname + grantUrl.search,
  );
  assert.ok([401, 403, 404].includes(oldGrant), "Refund must revoke existing EPUB grant");
  await refundAndVerify(refundOperatorPage, audiobook, async () =>
    [401, 403, 404].includes((await request(buyer, "GET", audioPath)).status),
  );
  report.refundRevoked = true;
  fs.mkdirSync("artifacts/deployed-commerce", { recursive: true });
  fs.writeFileSync("artifacts/deployed-commerce/report.json", JSON.stringify(report, null, 2));
  console.log(
    "PASS: genuine deployed browser Auth, signed Stripe fulfillment, EPUB, playable audio, outsider denial and refund revocation",
  );
} finally {
  // First clean up *through Cove* so entitlement revocation and the refund
  // ledger are actually processed; only fall back to a Stripe test-mode
  // refund if the real Cove admin path itself is unavailable.
  for (const payment of payments) {
    if (refunded.has(payment.intentId)) continue;
    try {
      if (refundOperatorPage && refundOperatorId) {
        const local = await request(refundOperatorPage, "POST", "/admin/commerce/refund", {
          orderId: payment.orderId,
          reason: "requested_by_customer",
          idempotencyKey: "qa-cleanup-" + randomUUID(),
        });
        if (local.status === 200 && ["pending", "succeeded"].includes(local.data?.status)) {
          refunded.add(payment.intentId);
          continue;
        }
      }
      const intent = await stripe("GET", "payment_intents/" + payment.intentId);
      if (intent.status === "succeeded") {
        await stripe("POST", "refunds", {
          payment_intent: payment.intentId,
          reason: "requested_by_customer",
        });
        console.error(
          "QA Stripe-only cleanup performed; Cove entitlement reconciliation needs review",
        );
      }
    } catch {
      console.error("QA cleanup requires operator review for a TEST payment intent");
    }
  }
  try {
    await revokeQaRefundOperator(refundOperatorId);
  } catch {
    console.error("QA temporary refund-operator cleanup requires operator review");
  }
  await Promise.all(contexts.map((c) => c.close().catch(() => {})));
  await browser.close();
}
