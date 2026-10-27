/* eslint-disable prettier/prettier -- Isolated sandbox fixtures preserve explicit security assertions and synthetic input construction. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { spawn, execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { build } from "esbuild";
import JSZip from "jszip";
import { localBindings } from "./local-api.mjs";

// Opt-in real Stripe SANDBOX integration; never run with production keys/data.
// Install the official Stripe CLI and provide these two variables out of band.
const secret = process.env.COVE_SANDBOX_SECRET_KEY || "";
const publishable = process.env.COVE_SANDBOX_PUBLISHABLE_KEY || "";
assert.match(secret, /^(sk|rk|rkcs)_test_/);
assert.match(publishable, /^pk_test_/);
// Prevent a syntactically valid test key for another business from producing
// a misleading Cove fulfillment certification. The account itself is never
// mutated by this preflight.
const provider = await fetch("https://api.stripe.com/v1/account", {
  headers: { Authorization: `Bearer ${secret}` },
  signal: AbortSignal.timeout(20000),
});
assert.equal(provider.status, 200, "Cove Stripe TEST key must allow account preflight");
const providerAccount = await provider.json();
assert.equal(providerAccount.id, "acct_1UTG66ErdufyFpJN", "Sandbox keys must belong to Cove");
assert.notEqual(providerAccount.charges_enabled, undefined, "Malformed Stripe account response");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "cove-stripe-integration-"));
const redact = (s) =>
  String(s).replace(
    /(?:sk|rk|rkcs|pk)_(?:test|live)_[A-Za-z0-9]+|whsec_[A-Za-z0-9]+/g,
    "[REDACTED]",
  );
let listener, server;
try {
  fs.cpSync("drizzle", path.join(root, "drizzle"), { recursive: true });
  await build({
    entryPoints: [
      "api.server",
      "commerce.server",
      "retail.server",
      "delivery.server",
      "royalty-engine.server",
    ].map((n) => `src/features/fore/${n}.ts`),
    bundle: true,
    platform: "node",
    format: "esm",
    outdir: root,
    outExtension: { ".js": ".mjs" },
    logLevel: "silent",
  });
  const api = await import(path.join(root, "api.server.mjs"));
  const commerce = await import(path.join(root, "commerce.server.mjs"));
  const retail = await import(path.join(root, "retail.server.mjs"));
  const delivery = await import(path.join(root, "delivery.server.mjs"));
  const royalty = await import(path.join(root, "royalty-engine.server.mjs"));
  const env = {
    ...localBindings(root),
    STRIPE_SECRET_KEY: secret,
    STRIPE_PUBLISHABLE_KEY: publishable,
    STRIPE_LIVEMODE: "false",
    STRIPE_TAX_ENABLED: "false",
    STRIPE_CAPTURE_METHOD: "automatic",
    STRIPE_WEBHOOK_SECRET: "",
  };
  await api.handleCoveApi(new Request("https://cove.test/api/fore/catalog"), env);
  const db = env.DB,
    at = new Date().toISOString();
  let product = await db
    .prepare("SELECT * FROM products WHERE source_external_id='1342'")
    .first();
  assert.ok(product, "seeded synthetic fixture edition");
  // Check out a genuinely commercial, non-Gutenberg-namespaced product.
  // Re-labeling a Gutenberg product alone would be rejected by the strong
  // legal owner even if its displayed rights looked like a licensed book.
  // Both rows and the checkout exist only inside this disposable test DB.
  const commercialId="prd_cove_sandbox_original_"+randomUUID().replaceAll("-","");
  const productFields=(await db.prepare("PRAGMA table_info(products)").all()).results;
  const quoteName=(name)=>'"'+String(name).replaceAll('"','""')+'"';
  const selectParts=[],replace=[];
  for(const column of productFields){
    const field=column.name;
    if(field==="id"){replace.push(commercialId);selectParts.push("?");}
    else if(field==="sku"){replace.push("sku-"+commercialId);selectParts.push("?");}
    else if(field==="source_external_id"){replace.push("cove-original-"+commercialId);selectParts.push("?");}
    else if(field==="public_id"||field==="slug"){replace.push(commercialId);selectParts.push("?");}
    else if(field==="source_name"){replace.push("publisher");selectParts.push("?");}
    else selectParts.push(quoteName(field));
  }
  await db.prepare(
    "INSERT INTO products("+productFields.map(c=>quoteName(c.name)).join(",")+") SELECT "+
      selectParts.join(",")+" FROM products WHERE id=?",
  ).bind(...replace,product.id).run();
  // Keep one canonical retail offer per QA product; never create a second
  // synthetic purchase offer for the public-domain source.
  await db.prepare("UPDATE offers SET product_id=? WHERE product_id=?")
    .bind(commercialId,product.id).run();
  product=await db.prepare("SELECT * FROM products WHERE id=?").bind(commercialId).first();
  assert.equal(product.id,commercialId);
  await db
    .prepare(
      "INSERT INTO finance_parties(id,party_type,display_name,tax_country,created_at,updated_at) VALUES('qa-payee','author','Synthetic QA payee','US',?,?)",
    )
    .bind(at, at)
    .run();
  await db
    .prepare(
      "INSERT INTO finance_royalty_contracts(id,name,product_id,sales_channel,effective_from,status,created_at,updated_at) VALUES('qa-contract','Synthetic sandbox contract',?,'retail','2020-01-01T00:00:00.000Z','active',?,?)",
    )
    .bind(product.id, at, at)
    .run();
  await royalty.createRoyaltyContractVersion(db, {
    contractId: "qa-contract",
    effectiveFrom: "2020-01-01T00:00:00.000Z",
    foreCommissionBps: 2500,
    paymentTermsDays: 0,
    splits: [{ partyId: "qa-payee", shareBps: 10000 }],
  });
  // Replace only this isolated fixture's content/rights/offer. Production
  // Gutenberg products remain free and no licensed publisher text is imported.
  await db
    .prepare(
      "UPDATE products SET source_name='publisher',source_external_id='cove-sandbox-original' WHERE id=?",
    )
    .bind(product.id)
    .run();
  await db
    .prepare("UPDATE editions SET title='Cove sandbox original licensed fixture' WHERE id=?")
    .bind(product.edition_id)
    .run();
  await db
    .prepare(
      "UPDATE rights_grants SET rightsholder_id=NULL,rightsholder_party_id=NULL,license_type='license',source='sandbox-original-license',source_evidence_id=NULL,notes='Synthetic original QA license only' WHERE edition_id=?",
    )
    .bind(product.edition_id)
    .run();
  await db
    .prepare("UPDATE offers SET offer_type='purchase',amount_minor=100,active=1 WHERE product_id=?")
    .bind(product.id)
    .run();
  const asset = await db
    .prepare(
      "SELECT av.* FROM asset_versions av JOIN digital_assets da ON da.current_version_id=av.id WHERE da.edition_id=? AND da.kind='epub'",
    )
    .bind(product.edition_id)
    .first();
  assert.ok(asset, "fixture asset version");
  const zip = new JSZip();
  zip.file("mimetype", "application/epub+zip", { compression: "STORE" });
  zip.file(
    "META-INF/container.xml",
    '<container><rootfiles><rootfile full-path="book.opf"/></rootfiles></container>',
  );
  zip.file(
    "book.opf",
    '<package version="3.0"><metadata><title>Cove sandbox original</title></metadata><manifest><item id="chapter" href="chapter.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="chapter"/></spine></package>',
  );
  zip.file(
    "chapter.xhtml",
    '<html xmlns="http://www.w3.org/1999/xhtml"><body><p>Original synthetic content for Cove sandbox fulfillment validation.</p></body></html>',
  );
  const bytes = await zip.generateAsync({ type: "uint8array" }),
    checksum = createHash("sha256").update(bytes).digest("hex"),
    objectKey = "sandbox/original.epub";
  await env.BUCKET.put(objectKey, bytes);
  await db
    .prepare(
      "UPDATE asset_versions SET object_key=?,source_url=NULL,sha256=?,size_bytes=? WHERE id=?",
    )
    .bind(objectKey, checksum, bytes.byteLength, asset.id)
    .run();
  const user = {
    id: `qa_${randomUUID()}`,
    email: "cove-qa@example.invalid",
    name: "Cove sandbox reader",
  };
  await db
    .prepare(
      "INSERT INTO auth_accounts(provider_id,app_id,email,username,created_at) VALUES(?,?,?,?,?)",
    )
    .bind(user.id, user.id, user.email, "sandbox_reader", "2020-01-01T00:00:00.000Z")
    .run();
  await assert.rejects(
    delivery.issueCommercialEpubGrant(env, user.id, { productId: product.id, purpose: "read" }),
    /entitlement|acquisition|purchase|access/i,
  );
  await retail.addToCart(db, user.id, { productId: product.id, territory: "US" });
  const quote = await commerce.checkoutQuote(env, user, {
    territory: "US",
    billingAddress: {
      name: user.name,
      line1: "1 Sandbox Way",
      city: "Richmond",
      state: "VA",
      postalCode: "23220",
      country: "US",
    },
  });
  const packets = [];
  server = createServer(async (req, res) => {
    try {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const raw = Buffer.concat(chunks).toString(),
        signature = String(req.headers["stripe-signature"] || "");
      const response = await api.handleCoveApi(
        new Request(`http://127.0.0.1/api/fore/stripe/webhook`, {
          method: "POST",
          headers: { "stripe-signature": signature, "content-type": "application/json" },
          body: raw,
        }),
        env,
      );
      const result = await response.json();
      packets.push({ raw, signature, status: response.status, result });
      res.writeHead(response.status, { "content-type": "application/json" });
      res.end(JSON.stringify(result));
    } catch (error) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: redact(error.message) }));
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const local = `http://127.0.0.1:${server.address().port}/webhook`;
  listener = spawn(
    "stripe",
    [
      "listen",
      "--events",
      "payment_intent.succeeded,payment_intent.payment_failed,charge.refunded",
      "--forward-to",
      local,
    ],
    {
      env: { ...process.env, STRIPE_API_KEY: secret },
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let listenerText = "";
  for (const stream of [listener.stdout, listener.stderr])
    stream.on("data", (chunk) => {
      listenerText += chunk;
      const found = /whsec_[A-Za-z0-9]+/.exec(listenerText);
      if (found) env.STRIPE_WEBHOOK_SECRET = found[0];
    });
  listener.on("error", (error) => {
    listenerText += error.message;
  });
  async function until(check, label, ms = 45000) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const value = await check();
      if (value) return value;
      await new Promise((r) => setTimeout(r, 250));
    }
    throw Error(`${label} timed out. ${redact(listenerText).slice(-600)}`);
  }
  await until(() => env.STRIPE_WEBHOOK_SECRET, "Stripe CLI signed webhook listener");
  const idempotencyKey = `sandbox-payment-${randomUUID()}`;
  const payment = await commerce.createCheckoutPayment(env, user, {
    quoteId: quote.id,
    idempotencyKey,
  });
  assert.ok(payment.paymentIntentId);
  const repeated = await commerce.createCheckoutPayment(env, user, {
    quoteId: quote.id,
    idempotencyKey,
  });
  assert.equal(repeated.paymentIntentId, payment.paymentIntentId);
  const confirmation = await fetch(
    `https://api.stripe.com/v1/payment_intents/${payment.paymentIntentId}/confirm`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secret}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        payment_method: "pm_card_visa",
        return_url: "https://example.invalid/cove-sandbox",
      }),
      signal: AbortSignal.timeout(20000),
    },
  );
  const confirmed = await confirmation.json();
  assert.equal(
    confirmation.status,
    200,
    redact(confirmed.error?.message || "Stripe confirmation failed"),
  );
  assert.equal(confirmed.livemode, false);
  assert.equal(confirmed.status, "succeeded");
  assert.equal(confirmed.amount_received, 100);
  const packet = await until(
    () => packets.find((p) => JSON.parse(p.raw).type === "payment_intent.succeeded"),
    "Real successful-payment event",
  );
  assert.equal(packet.status, 200, JSON.stringify(packet.result));
  const order = await until(async () => {
    const row = await db
      .prepare("SELECT * FROM commerce_orders WHERE id=?")
      .bind(payment.orderId)
      .first();
    return row?.status === "paid" ? row : null;
  }, "Paid fulfillment");
  const entitlement = await db
    .prepare("SELECT * FROM entitlements WHERE user_id=? AND product_id=? AND status='active'")
    .bind(user.id, product.id)
    .first();
  assert.ok(entitlement);
  const accrual = await db
    .prepare("SELECT count(*) n FROM finance_royalty_events WHERE order_id=? AND event_type='sale'")
    .bind(order.id)
    .first();
  assert.equal(accrual.n, 1, "successful payment accrues the synthetic royalty contract");
  const request = new Request("https://cove.test/api/fore/delivery", {
    headers: { "cf-ipcountry": "US", "user-agent": "Cove sandbox QA" },
  });
  const grant = await delivery.issueCommercialEpubGrant(
    env,
    user.id,
    { productId: product.id, purpose: "read" },
    request,
  );
  const file = await delivery.serveCommercialEpubGrant(env, grant.url.split("/").pop(), request);
  assert.equal(file.status, 200);
  const delivered = await file.arrayBuffer();
  const deliveredZip = await JSZip.loadAsync(delivered);
  assert.ok(
    (await deliveredZip.file("chapter.xhtml").async("string")).includes(
      "Original synthetic content",
    ),
  );
  const replay = await commerce.stripeWebhook(
    env,
    new Request("https://cove.test/api/fore/stripe/webhook", {
      method: "POST",
      headers: { "stripe-signature": packet.signature },
      body: packet.raw,
    }),
  );
  assert.equal(replay.duplicate, true);
  const count = await db
    .prepare(
      "SELECT count(*) n FROM entitlements WHERE user_id=? AND product_id=? AND entitlement_type='purchase'",
    )
    .bind(user.id, product.id)
    .first();
  assert.equal(count.n, 1);
  await assert.rejects(
    delivery.issueCommercialEpubGrant(env, "other-reader", {
      productId: product.id,
      purpose: "read",
    }),
    /entitlement|acquisition|purchase|access/i,
  );
  // Stripe settlement is external to D1 and the legal owner. Deliberately
  // fail the independent owner AFTER Stripe accepts a real TEST refund, then
  // retry the same canonical refund and provider idempotency key. The
  // pending owner receipt must not be misreported as a failed payment, nor
  // can replay cause a second refund or return a stale "succeeded" record.
  const refundKey = `sandbox-refund-${randomUUID()}`;
  let ownerAvailable = false;
  let denialAttempts = 0;
  const stagedRefund = {
    ...env,
    COVE_LEGAL_CONSUMER_STAGE_ENABLED: "1",
    COVE_SSR_STAGING: "1",
    COVE_CANONICAL_LEGAL_WRITE_LOCK: "1",
    COVE_LEGAL_WRITER_PRIMARY_ID: "7c7ab994-f6b3-419d-a72d-71eb9ea22e7e",
    COVE_LEGAL_QUARANTINE_WRITER_STAGE: "1",
    COVE_LEGAL_QUARANTINE_SECRET: "a".repeat(64),
    LEGAL_QUARANTINE_WRITER: {
      async fetch(request) {
        denialAttempts++;
        assert.equal(request.headers.get("authorization"), "Bearer " + "a".repeat(64));
        assert.equal(new URL(request.url).pathname, "/commercial/entitlement/revoke-order");
        const command = await request.json();
        assert.equal(command.orderId, order.id);
        assert.match(command.operationId, /^ref_[a-z0-9-]+$/);
        if (!ownerAvailable) return new Response(null, { status: 503 });
        // This disposable DB models the separately certified canonical
        // owner writer; it is NOT a substitute for the deployed DO QA.
        await db.prepare(
          "UPDATE entitlements SET status='revoked',updated_at=? WHERE user_id=? AND order_item_id IN (SELECT id FROM commerce_order_items WHERE order_id=?)",
        ).bind(new Date().toISOString(), user.id, order.id).run();
        return Response.json({ orderDenied: true });
      },
    },
  };
  const refundRequest = { orderId: order.id, idempotencyKey: refundKey };
  await assert.rejects(
    commerce.refundOrder(stagedRefund, refundRequest),
    (e) => e.status === 503,
    "Stripe-successful refund must fail closed when owner denial is unavailable",
  );
  const awaitingOwner = await db.prepare(
    "SELECT id,status,provider_refund_id,succeeded_at FROM commerce_refunds WHERE idempotency_key=?",
  ).bind(refundKey).first();
  assert.equal(awaitingOwner.status, "succeeded",
    "Real Stripe refund cannot be falsely relabeled failed after owner outage");
  assert.match(awaitingOwner.provider_refund_id, /^re_[a-zA-Z0-9]+$/);
  assert.equal(awaitingOwner.succeeded_at, null,
    "Financial/entitlement settlement must not be acknowledged before owner denial");
  await assert.rejects(
    commerce.refundOrder(stagedRefund, refundRequest),
    (e) => e.status === 503,
    "Same idempotency key must retry the owner, not return stale success",
  );
  ownerAvailable = true;
  const refund = await commerce.refundOrder(stagedRefund, refundRequest);
  assert.equal(refund.status, "succeeded");
  assert.equal(refund.providerRefundId, awaitingOwner.provider_refund_id);
  assert.ok(denialAttempts >= 3, "Refund requires actual owner retry before acknowledgement");
  const settledReceipt = await db.prepare(
    "SELECT succeeded_at FROM commerce_refunds WHERE id=?",
  ).bind(awaitingOwner.id).first();
  assert.ok(settledReceipt.succeeded_at, "Owner-confirmed refund must persist receipt");
  await assert.rejects(
    delivery.issueCommercialEpubGrant(env, user.id, { productId: product.id, purpose: "read" }),
    /entitlement|acquisition|purchase|access|revoked/i,
  );
  await assert.rejects(
    delivery.serveCommercialEpubGrant(env, grant.url.split("/").pop(), request),
    /entitlement|revoked|active/i,
  );
  const report = {
    environment: "isolated temporary Stripe sandbox",
    amountMinor: 100,
    currency: "USD",
    livemode: false,
    paymentIntentId: payment.paymentIntentId,
    orderId: order.id,
    eventId: JSON.parse(packet.raw).id,
    refundId: refund.providerRefundId,
    checks: [
      "Cove quote and PaymentIntent creation",
      "checkout idempotency",
      "real test-card success",
      "Stripe CLI-delivered signed event",
      "paid order and single purchase entitlement",
      "protected EPUB grant and original fixture content",
      "duplicate event replay",
      "cross-account denial",
      "real refund and revoked new/existing delivery",
      "owner outage after real refund, durable pending reconciliation and same-key recovery",
      "royalty accrual under an active synthetic payee contract",
    ],
    tax: "disabled only in isolated sandbox; no tax collection claim",
    at: new Date().toISOString(),
  };
  if (process.env.COVE_SANDBOX_REPORT) {
    fs.mkdirSync(path.dirname(process.env.COVE_SANDBOX_REPORT), { recursive: true });
    fs.writeFileSync(process.env.COVE_SANDBOX_REPORT, JSON.stringify(report, null, 2) + "\n");
  }
  console.log("PASS: " + JSON.stringify(report));
} catch (error) {
  console.error(redact(error.stack || error));
  process.exitCode = 1;
} finally {
  if (listener?.pid) {
    try {
      if (process.platform === "win32")
        execFileSync("taskkill", ["/PID", String(listener.pid), "/T", "/F"]);
      else process.kill(-listener.pid, "SIGTERM");
    } catch {}
    listener.stdout?.destroy();
    listener.stderr?.destroy();
    listener.unref();
  }
  if (server) await new Promise((r) => server.close(r));
  fs.rmSync(root, { recursive: true, force: true });
}
