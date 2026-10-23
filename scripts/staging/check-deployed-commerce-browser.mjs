// Opt-in deployed-browser acceptance. NEVER target production or use live Stripe.
// The origin, users, media fixtures and keys must be provisioned out of band.
// The workflow must FAIL, not substitute local module-level identity mocks.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { chromium } from "playwright";
import JSZip from "jszip";

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
];
const missing = required.filter((name) => !process.env[name]);
assert.equal(
  missing.length, 0,
  "Deployed acceptance requires protected QA configuration: " + missing.join(", "),
);
const q = process.env;
const origin = new URL(q.COVE_QA_DEPLOYED_ORIGIN);
assert.equal(origin.protocol, "https:");
assert.equal(origin.pathname, "/");
assert.match(origin.hostname, /(?:^|[.-])(?:qa|staging)(?:[.-])/i);
assert.ok(!origin.hostname.includes("cove-jibrilmohamud.workers.dev"));
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
const report = {
  revision: process.env.GITHUB_SHA || "unreported",
  target: "protected isolated QA origin",
  stripeMode: "test",
  buyerAuthenticated: false,
  outsiderAuthenticated: false,
  protectedEpub: false,
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
async function openUser(email, password) {
  const headers = {};
  if (q.COVE_QA_VERCEL_PROTECTION_BYPASS)
    headers["x-vercel-protection-bypass"] = q.COVE_QA_VERCEL_PROTECTION_BYPASS;
  const context = await browser.newContext({
    extraHTTPHeaders: headers,
    locale: "en-US",
  });
  contexts.push(context);
  const page = await context.newPage();
  const navigated = await page.goto(origin.href, { waitUntil: "domcontentloaded" });
  assert.equal(navigated.status(), 200, "QA preview must be browser-accessible");
  const login = await request(page, "POST", "/auth/login", { login: email, password });
  assert.equal(login.status, 200, "Real Supabase password sign-in through deployed Cove failed");
  assert.equal(login.data.signedIn, true);
  assert.notEqual(login.data.mfaRequired, true, "MFA QA login requires a genuine second factor");
  return page;
}
async function request(page, method, route, body) {
  return page.evaluate(
    async ({ method, route, body }) => {
      const response = await fetch("/api/fore" + route, {
        method,
        credentials: "include",
        headers: body ? { "content-type": "application/json" } : {},
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      const text = await response.text();
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        data = null;
      }
      return { status: response.status, data, mime: response.headers.get("content-type") };
    },
    { method, route, body },
  );
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
async function purchase(page, productId) {
  const cart = await request(page, "GET", "/cart");
  assert.equal(cart.status, 200);
  assert.ok(!cart.data?.items?.length, "QA account cart must start empty; never buy existing items");
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
  payments.push(pay.data.paymentIntentId);
  const confirmed = await stripe("POST", "payment_intents/" + intent.id + "/confirm", {
    payment_method: "pm_card_visa",
    return_url: origin.href,
  });
  assert.equal(confirmed.status, "succeeded");
  assert.equal(confirmed.livemode, false);
  return { intentId: intent.id, orderId: pay.data.orderId };
}
async function refundAndVerify(page, intentId, checkRevoked) {
  const returned = await stripe("POST", "refunds", {
    payment_intent: intentId,
    reason: "requested_by_customer",
  });
  assert.equal(returned.status, "succeeded");
  refunded.add(intentId);
  await until(checkRevoked, "Signed refund event must revoke deployed entitlement");
}
try {
  const buyer = await openUser(q.COVE_QA_BUYER_EMAIL, q.COVE_QA_BUYER_PASSWORD);
  const outsider = await openUser(q.COVE_QA_OUTSIDER_EMAIL, q.COVE_QA_OUTSIDER_PASSWORD);
  report.buyerAuthenticated = true;
  report.outsiderAuthenticated = true;
  await verifyConfig(buyer);
  const anonymous = await browser.newContext();
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
      buyer, "GET", "/delivery/ownership?productId=" +
        encodeURIComponent(q.COVE_QA_EPUB_PRODUCT_ID),
    );
    return result.status === 200 && result.data?.entitlement?.status === "active";
  }, "Signed webhook fulfillment and owner entitlement");
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
  expectDenied(
    await request(outsider, "POST", "/delivery/epub/grant", {
      productId: q.COVE_QA_EPUB_PRODUCT_ID,
      purpose: "read",
    }),
    "Outsider EPUB grant after another user purchased",
  );
  const audiobook = await purchase(buyer, q.COVE_QA_AUDIO_PRODUCT_ID);
  const audioPath = "/audio/" + encodeURIComponent(q.COVE_QA_AUDIO_PUBLIC_ID) +
    "/tracks/" + encodeURIComponent(q.COVE_QA_AUDIO_TRACK_ID);
  expectDenied(await request(outsider, "GET", audioPath), "Outsider audio chapter");
  await until(async () => (await request(buyer, "GET", audioPath)).status === 200,
    "Signed audio-entitlement fulfillment");
  const played = await buyer.evaluate(async (route) => {
    const response = await fetch("/api/fore" + route, { credentials: "include" });
    if (response.status !== 200) return { status: response.status, started: false };
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength < 128) return { status: response.status, started: false };
    const mime = response.headers.get("content-type") || "audio/wav";
    const blobUrl = URL.createObjectURL(new Blob([buffer], { type: mime }));
    const audio = new Audio(blobUrl);
    const started = await new Promise((resolve) => {
      const timeout = setTimeout(() => resolve(false), 9000);
      audio.addEventListener("playing", () => { clearTimeout(timeout); resolve(true); }, { once: true });
      audio.addEventListener("error", () => { clearTimeout(timeout); resolve(false); }, { once: true });
      audio.play().catch(() => { clearTimeout(timeout); resolve(false); });
    });
    audio.pause();
    URL.revokeObjectURL(blobUrl);
    return { status: response.status, started };
  }, audioPath);
  assert.equal(played.started, true, "Actual HTML5 audio playback must start in browser");
  report.playableAudio = true;
  report.outsiderDenied = true;
  await refundAndVerify(buyer, ebook.intentId, async () => {
    const own = await request(
      buyer, "GET", "/delivery/ownership?productId=" +
        encodeURIComponent(q.COVE_QA_EPUB_PRODUCT_ID),
    );
    return own.status !== 200 || own.data?.entitlement?.status !== "active";
  });
  expectDenied(
    await request(buyer, "POST", "/delivery/epub/grant", {
      productId: q.COVE_QA_EPUB_PRODUCT_ID, purpose: "read",
    }), "Refunded EPUB new grant",
  );
  const oldGrant = await buyer.evaluate(async (path) =>
    (await fetch(path, { credentials: "include" })).status, grantUrl.pathname + grantUrl.search);
  assert.ok([401, 403, 404].includes(oldGrant), "Refund must revoke existing EPUB grant");
  await refundAndVerify(buyer, audiobook.intentId, async () =>
    [401, 403, 404].includes((await request(buyer, "GET", audioPath)).status));
  report.refundRevoked = true;
  fs.mkdirSync("artifacts/deployed-commerce", { recursive: true });
  fs.writeFileSync("artifacts/deployed-commerce/report.json", JSON.stringify(report, null, 2));
  console.log("PASS: genuine deployed browser Auth, signed Stripe fulfillment, EPUB, playable audio, outsider denial and refund revocation");
} finally {
  // Never leave succeeded synthetic payments unrefunded after a test assertion.
  for (const intentId of payments) {
    if (refunded.has(intentId)) continue;
    try {
      const intent = await stripe("GET", "payment_intents/" + intentId);
      if (intent.status === "succeeded")
        await stripe("POST", "refunds", { payment_intent: intentId, reason: "requested_by_customer" });
    } catch {
      console.error("QA cleanup requires operator review for a TEST payment intent");
    }
  }
  await Promise.all(contexts.map((c) => c.close().catch(() => {})));
  await browser.close();
}
