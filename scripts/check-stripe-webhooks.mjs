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
    await original("SELECT provider_event_id FROM commerce_webhook_events WHERE provider_event_id=?")
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
  const timestamp = new Date().toISOString();
  await original(
    "INSERT INTO commerce_orders(id,user_id,invoice_number,status,currency,territory_code,subtotal_minor,total_minor,stripe_due_minor,billing_address_json,idempotency_key,stripe_payment_intent_id,created_at,updated_at) VALUES('ord-proof','qa','QA-PROOF','pending_payment','JPY','JP',1000,1000,1000,'{}','qa-proof','pi_expected',?,?)",
  )
    .bind(timestamp, timestamp)
    .run();
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
  await assert.rejects(invoiceHtml(env.DB, "another-user", "ord-proof"), /not found/);
  console.log(
    "PASS: signed webhook mode/signature/replay gates, retry after transient failure, concurrent/expired leases and restricted API-key mode checks.",
  );
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
