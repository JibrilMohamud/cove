import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHmac, createHash } from "node:crypto";
import { build } from "esbuild";
import { localBindings } from "./local-api.mjs";
const root = fs.mkdtempSync(path.join(os.tmpdir(), "cove-webhook-"));
try {
  fs.cpSync("drizzle", path.join(root, "drizzle"), { recursive: true });
  await build({
    entryPoints: ["src/features/fore/commerce.server.ts"],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile: path.join(root, "commerce.mjs"),
    logLevel: "silent",
  });
  const { stripeWebhook, commerceConfig, invoiceHtml } = await import(
    path.join(root, "commerce.mjs")
  );
  await build({
    entryPoints: ["src/features/fore/risk-tax.server.ts"],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile: path.join(root, "risk.mjs"),
    logLevel: "silent",
  });
  const { ingestStripeRiskSignal } = await import(path.join(root, "risk.mjs"));
  const env = {
    ...localBindings(root),
    STRIPE_LIVEMODE: "false",
    STRIPE_PUBLISHABLE_KEY: "pk_test_cove_fixture",
    STRIPE_WEBHOOK_SECRET: "whsec_cove_fixture",
  };
  assert.equal(
    commerceConfig({ ...env, STRIPE_SECRET_KEY: "rk_test_cove_fixture" }).stripeReady,
    true,
  );
  assert.equal(
    commerceConfig({ ...env, STRIPE_SECRET_KEY: "rkcs_test_cove_fixture" }).stripeReady,
    true,
  );
  assert.equal(
    commerceConfig({ ...env, STRIPE_SECRET_KEY: "rkcs_live_cove_fixture" }).stripeReady,
    false,
  );
  assert.equal(
    commerceConfig({ ...env, STRIPE_SECRET_KEY: "rk_live_cove_fixture" }).stripeReady,
    false,
  );
  const event = {
    id: "evt_cove_retry",
    type: "payment_intent.processing",
    livemode: false,
    data: { object: { id: "pi_cove_fixture", metadata: { fore_order_id: "order-not-present" } } },
  };
  function request(
    value = event,
    { secret = env.STRIPE_WEBHOOK_SECRET, at = Math.floor(Date.now() / 1000) } = {},
  ) {
    const raw = JSON.stringify(value),
      sig = createHmac("sha256", secret)
        .update(at + "." + raw)
        .digest("hex");
    return new Request("https://cove.test/api/fore/stripe/webhook", {
      method: "POST",
      headers: { "stripe-signature": `t=${at},v1=${sig}` },
      body: raw,
    });
  }
  const original = env.DB.prepare;
  let fail = true;
  env.DB.prepare = (sql) => {
    if (fail && sql.startsWith("SELECT * FROM commerce_orders")) {
      fail = false;
      throw Error("Transient injected database outage");
    }
    return original(sql);
  };
  await assert.rejects(stripeWebhook(env, request()), /Transient/);
  assert.equal(
    (
      await original("SELECT status FROM commerce_webhook_events WHERE provider_event_id=?")
        .bind(event.id)
        .first()
    ).status,
    "failed",
  );
  await stripeWebhook(env, request());
  assert.equal(
    (
      await original("SELECT status FROM commerce_webhook_events WHERE provider_event_id=?")
        .bind(event.id)
        .first()
    ).status,
    "processed",
  );
  assert.equal((await stripeWebhook(env, request())).duplicate, true);
  await assert.rejects(
    stripeWebhook(env, request({ ...event, type: "different" })),
    /different payload/,
  );
  await assert.rejects(
    stripeWebhook(env, request({ ...event, id: "evt_live", livemode: true })),
    /mode mismatch/,
  );
  await assert.rejects(
    stripeWebhook(env, request({ ...event, id: "evt_bad" }, { secret: "incorrect" })),
    /signature/,
  );
  await assert.rejects(
    stripeWebhook(env, request({ ...event, id: "evt_old" }, { at: 1 })),
    /signature/,
  );
  const oversized = {
    ...event,
    id: "evt_oversized_payload",
    data: { object: { ...event.data.object, padding: "X".repeat(1_048_576) } },
  };
  await assert.rejects(
    stripeWebhook(env, request(oversized)),
    /payload exceeds the limit/,
    "A signed but oversized webhook must be refused before database mutation",
  );
  assert.equal(
    await original(
      "SELECT provider_event_id FROM commerce_webhook_events WHERE provider_event_id=?",
    )
      .bind(oversized.id)
      .first(),
    null,
    "Oversized Stripe events must never claim canonical webhook state",
  );
  const processing = { ...event, id: "evt_busy" },
    raw = JSON.stringify(processing);
  await original(
    "INSERT INTO commerce_webhook_events(provider_event_id,event_type,livemode,payload_sha256,status,received_at,processing_token,processing_lease_until) VALUES(?,?,0,?,'received',?,'other',?)",
  )
    .bind(
      processing.id,
      processing.type,
      createHash("sha256").update(raw).digest("hex"),
      new Date().toISOString(),
      new Date(Date.now() + 60000).toISOString(),
    )
    .run();
  await assert.rejects(stripeWebhook(env, request(processing)), /still being processed/);
  await original(
    "UPDATE commerce_webhook_events SET processing_lease_until='' WHERE provider_event_id=?",
  )
    .bind(processing.id)
    .run();
  await stripeWebhook(env, request(processing));
  // A genuine Cove-tagged successful charge must be retried if its D1
  // order row has not arrived. A 200 here would permanently swallow payment
  // fulfillment; unrelated untagged Stripe PaymentIntents are unaffected.
  const missingOrderEvent = {
    id: "evt_missing_initial_cove_order",
    type: "payment_intent.succeeded",
    livemode: false,
    data: {
      object: {
        id: "pi_expected",
        currency: "jpy",
        amount_received: 1000,
        metadata: { fore_order_id: "ord-proof" },
      },
    },
  };
  await assert.rejects(stripeWebhook(env, request(missingOrderEvent)), /order not yet available/);
  const pendingMissing = await original(
    "SELECT status FROM commerce_webhook_events WHERE provider_event_id=?",
  )
    .bind(missingOrderEvent.id)
    .first();
  assert.equal(pendingMissing.status, "failed", "Cove-tagged missing order must remain retryable");
  const timestamp = new Date().toISOString();
  await original(
    "INSERT INTO commerce_orders(id,user_id,invoice_number,status,currency,territory_code,subtotal_minor,total_minor,stripe_due_minor,billing_address_json,idempotency_key,stripe_payment_intent_id,created_at,updated_at) VALUES('ord-proof','qa','QA-PROOF','pending_payment','JPY','JP',1000,1000,1000,'{}','qa-proof','pi_expected',?,?)",
  )
    .bind(timestamp, timestamp)
    .run();
  // Each webhook lifecycle case gets its own isolated synthetic order. Tests
  // must never reset a terminal canonical status to pending_payment: that
  // setup pattern would bypass exactly the immutable refund guard under test.
  async function freshLifecycleOrder(status, label) {
    const suffix = label.replace(/[^a-z0-9_]/gi, "_").slice(0, 110);
    const id = "ord_" + suffix;
    const paymentIntentId = "pi_" + suffix;
    await original(
      "INSERT INTO commerce_orders(id,user_id,invoice_number,status,currency,territory_code,subtotal_minor,total_minor,stripe_due_minor,billing_address_json,idempotency_key,stripe_payment_intent_id,created_at,updated_at) VALUES(?,'qa',?,?,'JPY','JP',1000,1000,1000,'{}',?,?,?,?)",
    )
      .bind(id, "QA-" + suffix, status, "qa-" + suffix, paymentIntentId, timestamp, timestamp)
      .run();
    return { id, paymentIntentId };
  }
  // A genuine signed event for a different PI must never update the
  // canonical order merely because Stripe metadata names that order.
  // This includes non-success lifecycle events, not only settlement.
  for (const [suffix, type] of [
    ["processing", "payment_intent.processing"],
    ["authorization", "payment_intent.amount_capturable_updated"],
    ["failure", "payment_intent.payment_failed"],
    ["cancel", "payment_intent.canceled"],
  ]) {
    const crossed = {
      id: "evt_pi_cross_order_" + suffix,
      type,
      livemode: false,
      data: {
        object: {
          id: "pi_another_order",
          currency: "jpy",
          metadata: { fore_order_id: "ord-proof" },
        },
      },
    };
    await assert.rejects(
      stripeWebhook(env, request(crossed)),
      /does not match the canonical order/,
      "Mismatched PI may not mutate another order in " + type,
    );
    const eventState = await original(
      "SELECT status FROM commerce_webhook_events WHERE provider_event_id=?",
    )
      .bind(crossed.id)
      .first();
    assert.equal(eventState.status, "failed", "Mismatched event must remain retryable");
  }
  assert.equal(
    (await original("SELECT status FROM commerce_orders WHERE id='ord-proof'").first()).status,
    "pending_payment",
    "Mismatched signed non-success events must not cancel or alter the real order",
  );
  for (const [suffix, overrides] of [
    ["amount", { amount_received: 999 }],
    ["currency", { currency: "usd" }],
    ["intent", { id: "pi_other" }],
  ]) {
    const mismatch = {
      id: `evt_mismatch_${suffix}`,
      type: "payment_intent.succeeded",
      livemode: false,
      data: {
        object: {
          id: "pi_expected",
          currency: "jpy",
          amount_received: 1000,
          metadata: { fore_order_id: "ord-proof" },
          ...overrides,
        },
      },
    };
    await assert.rejects(stripeWebhook(env, request(mismatch)), /does not match/);
  }
  // Stripe may deliver distinct, correctly signed PaymentIntent lifecycle
  // events out of order. An old authorization must not reopen a canceled,
  // failed, refunded, paid or disputed canonical order.
  for (const [existing, expected] of [
    ["pending_payment", "authorized"],
    ["canceled", "canceled"],
    ["payment_failed", "payment_failed"],
    ["paid", "paid"],
    ["refunded", "refunded"],
    ["disputed", "disputed"],
  ]) {
    const order = await freshLifecycleOrder(existing, "authorization_" + existing);
    await stripeWebhook(
      env,
      request({
        id: "evt_authorization_after_" + existing,
        type: "payment_intent.amount_capturable_updated",
        livemode: false,
        data: { object: { id: order.paymentIntentId, metadata: { fore_order_id: order.id } } },
      }),
    );
    assert.equal(
      (await original("SELECT status FROM commerce_orders WHERE id=?").bind(order.id).first()).status,
      expected,
      "A late signed authorization cannot resurrect an order in state " + existing,
    );
  }
  // A properly signed but late failure/cancellation must never move a
  // disputed, refunded or already canceled order back into a live checkout
  // state. Only mutable pre-settlement orders can transition.
  for (const [type, changed] of [
    ["payment_intent.payment_failed", "payment_failed"],
    ["payment_intent.canceled", "canceled"],
  ]) {
    for (const [existing, expected] of [
      ["pending_payment", changed],
      ["processing", changed],
      ["authorized", changed],
      ["payment_failed", changed],
      ["canceled", "canceled"],
      ["paid", "paid"],
      ["partially_refunded", "partially_refunded"],
      ["refunded", "refunded"],
      ["disputed", "disputed"],
    ]) {
      const order = await freshLifecycleOrder(existing, "terminal_" + type + "_" + existing);
      await stripeWebhook(
        env,
        request({
          id: `evt_terminal_${type}_${existing}`,
          type,
          livemode: false,
          data: {
            object: {
              id: order.paymentIntentId,
              metadata: { fore_order_id: order.id },
              last_payment_error: { code: "card_declined" },
            },
          },
        }),
      );
      assert.equal(
        (await original("SELECT status FROM commerce_orders WHERE id=?").bind(order.id).first()).status,
        expected,
        "Stale signed event " + type + " may not regress order state " + existing,
      );
    }
  }
  // Signed successful payments must not resurrect a canceled, disputed or
  // revoked order. These events must be retryable rather than publishing
  // entitlements, settling tender or rewriting canonical order status.
  const baselineEntitlements = await original("SELECT count(*) AS n FROM entitlements").first();
  const baselineLedger = await original(
    "SELECT count(*) AS n FROM commerce_ledger_entries",
  ).first();
  for (const terminal of ["canceled", "disputed", "chargeback_lost"]) {
    const order = await freshLifecycleOrder(terminal, "late_success_" + terminal);
    const late = {
      id: "evt_late_success_after_" + terminal,
      type: "payment_intent.succeeded",
      livemode: false,
      data: {
        object: {
          id: order.paymentIntentId,
          currency: "jpy",
          amount_received: 1000,
          metadata: { fore_order_id: order.id },
        },
      },
    };
    await assert.rejects(
      stripeWebhook(env, request(late)),
      /Terminal or invalid order cannot be settled/,
      "Signed late success must fail closed for " + terminal,
    );
    const orderAfter = await original(
      "SELECT status FROM commerce_orders WHERE id=?",
    ).bind(order.id).first();
    assert.equal(orderAfter.status, terminal);
    const received = await original(
      "SELECT status FROM commerce_webhook_events WHERE provider_event_id=?",
    )
      .bind(late.id)
      .first();
    assert.equal(received.status, "failed", "Rejected late successes remain retryable");
    assert.equal(
      (await original("SELECT count(*) AS n FROM entitlements").first()).n,
      baselineEntitlements.n,
    );
    assert.equal(
      (await original("SELECT count(*) AS n FROM commerce_ledger_entries").first()).n,
      baselineLedger.n,
    );
  }
  assert.equal(
    (await original("SELECT status FROM commerce_orders WHERE id='ord-proof'").first()).status,
    "pending_payment",
    "Independent signed webhook fixtures must not mutate the original pending order",
  );
  await ingestStripeRiskSignal(
    env.DB,
    "ord-proof",
    { outcome: { risk_score: 3, risk_level: "normal", network_status: "approved_by_network" } },
    "evt_radar_success",
  );
  const radar = await original(
    "SELECT score,level FROM risk_provider_signals WHERE provider_signal_id=?",
  )
    .bind("evt_radar_success")
    .first();
  assert.equal(radar.score, 3);
  assert.equal(radar.level, "normal");
  assert.equal(
    (await original("SELECT status FROM commerce_orders WHERE id='ord-proof'").first()).status,
    "pending_payment",
    "mismatched successful events never grant fulfillment",
  );
  for (const [currency, amount, expected] of [
    ["JPY", 1234, "¥1,234"],
    ["USD", 1234, "$12.34"],
    ["KWD", 1234, "1.234"],
  ]) {
    await original(
      "UPDATE commerce_orders SET status='paid',currency=?,subtotal_minor=?,total_minor=? WHERE id='ord-proof'",
    )
      .bind(currency, amount, amount)
      .run();
    const invoice = await invoiceHtml(env.DB, "qa", "ord-proof");
    assert.ok(invoice.includes(expected), `${currency}: invoice renders ISO minor units`);
  }
  // Refund.created may arrive after refund.updated(succeeded). Preserve the
  // already settled/refunded state instead of presenting a completed
  // revocation as a pending refund again.
  await original(
    "INSERT INTO commerce_refunds(id,order_id,provider_refund_id,amount_minor,currency,reason,status,idempotency_key,created_at,updated_at,succeeded_at) VALUES('rfd_terminal','ord-proof','re_terminal',500,'JPY','qa','succeeded','refund-terminal-qa',?,?,?)",
  )
    .bind(timestamp, timestamp, timestamp)
    .run();
  await stripeWebhook(
    env,
    request({
      id: "evt_refund_created_after_succeeded",
      type: "refund.created",
      livemode: false,
      data: { object: { id: "re_terminal", status: "pending" } },
    }),
  );
  assert.equal(
    (await original("SELECT status FROM commerce_refunds WHERE id='rfd_terminal'").first()).status,
    "succeeded",
    "A late refund.created cannot downgrade an already succeeded refund",
  );
  await assert.rejects(invoiceHtml(env.DB, "another-user", "ord-proof"), /not found/);
  console.log(
    "PASS: signed webhook mode/signature/replay gates, retry after transient failure, concurrent/expired leases and restricted API-key mode checks.",
  );
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
