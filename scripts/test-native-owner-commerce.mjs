// Disposable native D1 + SQLite DO + actual named service-binding proof.
// All provider and legal fixtures are synthetic. No hosted/production evidence.
import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "esbuild";
const { Miniflare, convertV4MiniflareOptions } = createRequire(import.meta.url)(
  process.env.COVE_MINIFLARE_MODULE || "miniflare",
);
const root = mkdtempSync(join(tmpdir(), "cove-native-commerce-"));
const primary = "969f1ea0-5f57-4f3a-aa25-9c74e58f5af3";
const secret = "d".repeat(64),
  backendToken = "native-commerce-backend-fixture-0000000000";
const webhookSecret = "whsec_" + "a".repeat(48);
const orderId = "order_native_binding",
  productId = "prd_native_binding",
  editionId = "edition_native_binding";
const userId = "sb:12345678-1234-4abc-8def-123456789abc";
const at = new Date().toISOString();
const authToken =
  [
    { alg: "HS256", typ: "JWT" },
    { sub: userId.slice(3), session_id: "native-commerce-session", aal: "aal1", exp: 4102444800 },
  ]
    .map((x) => Buffer.from(JSON.stringify(x)).toString("base64url"))
    .join(".") + ".fixture";
const cookie =
  "fore-auth=base64-" +
  Buffer.from(
    JSON.stringify({
      access_token: authToken,
      refresh_token: "local-commerce-refresh",
      expires_at: 4102444800,
      expires_in: 3600,
      token_type: "bearer",
      user: { id: userId.slice(3), email: "native-commerce@test.invalid" },
    }),
  ).toString("base64url");
// Compact lexical whitespace for native D1 exec without altering SQL literals.
function compact(input) {
  let out = "",
    quote = null;
  for (let i = 0; i < input.length; i++) {
    const c = input[i],
      next = input[i + 1];
    if (quote) {
      assert.ok(c !== "\n" && c !== "\r");
      out += c;
      if (c === quote) {
        if (next === quote) {
          out += next;
          i++;
        } else quote = null;
      }
    } else if (c === "-" && next === "-") {
      while (i < input.length && input[i] !== "\n") i++;
      out += " ";
    } else if (c === "/" && next === "*") {
      const end = input.indexOf("*/", i + 2);
      assert.ok(end >= 0);
      i = end + 1;
      out += " ";
    } else if (["'", '"', "`", "["].includes(c)) {
      quote = c === "[" ? "]" : c;
      out += c;
    } else out += /[\r\n]/.test(c) ? " " : c;
  }
  assert.equal(quote, null);
  return out;
}
let mf,
  providerUnavailable = true,
  providerCalls = 0,
  refundRecord,
  refundPosts = 0,
  refundCreations = 0,
  loseRefundAcknowledgement = true;
try {
  const common = {
    bundle: true,
    format: "esm",
    platform: "neutral",
    target: "es2022",
    alias: { jszip: "jszip/dist/jszip.min.js" },
    mainFields: ["browser", "module", "main"],
    external: ["cloudflare:*", "node:*"],
    logLevel: "silent",
  };
  // The fixture-only class bootstrap inserts one synthetic legal scope into
  // the real DO. It is never imported into or exposed by a production build.
  await build({
    ...common,
    outfile: join(root, "owner.mjs"),
    stdin: {
      sourcefile: "native-commerce-fixture.ts",
      loader: "ts",
      resolveDir: resolve("src/storefront-strangler"),
      contents: `import real,{CoveLegalAuthority as Base,CoveBusinessEntrypoint} from "./consolidated-owner-qa.worker";
      import {publishFreshCommercialProof} from "./commercial-legal-core";
      export {CoveBusinessEntrypoint};
      export class CoveLegalAuthority extends Base {
        async fetch(request) {
          if(new URL(request.url).pathname==="/fixture/seed-native-legal") {
            if(this.env.NATIVE_COMMERCE_FIXTURE!=="local-only"||request.headers.get("authorization")!=="Bearer "+this.env.COVE_RIGHTS_OWNER_SECRET)return new Response(null,{status:403});
            const value=this.ctx.storage.transactionSync(()=>publishFreshCommercialProof(this.ctx.storage.sql,{
              productId:${JSON.stringify(productId)},editionId:${JSON.stringify(editionId)},territory:"US",channel:"retail",
              grantId:"grant_native_binding",contractId:"contract_native_binding",contractVersionId:"version_native_binding",
              validUntil:new Date(Date.now()+600000).toISOString()},0));
            return Response.json(value);
          }
          return super.fetch(request);
        }
      }
      export default { ...real, fetch(request,env) {
        if(new URL(request.url).pathname==="/fixture/seed-native-legal")return env.LEGAL_AUTHORITY.getByName("cove-staged-legal-global-v1").fetch(request);
        return real.fetch(request,env);
      }};`,
    },
  });
  await build({
    ...common,
    entryPoints: ["src/storefront-strangler/consolidated-gateway-qa.worker.ts"],
    outfile: join(root, "caller.mjs"),
  });
  const caller = {
    name: "caller",
    rootPath: root,
    modules: true,
    scriptPath: join(root, "caller.mjs"),
    compatibilityDate: "2026-10-17",
    compatibilityFlags: ["nodejs_compat"],
    bindings: {
      COVE_CONSOLIDATED_GATEWAY_QA: "1",
      FORE_ENVIRONMENT: "staging",
      COVE_SSR_STAGING: "1",
      FORE_BACKEND_TOKEN_SHA256: createHash("sha256").update(backendToken).digest("hex"),
    },
    serviceBindings: { BUSINESS_OWNER: { name: "owner", entrypoint: "CoveBusinessEntrypoint" } },
  };
  assert.equal(caller.d1Databases, undefined);
  const owner = {
    name: "owner",
    rootPath: root,
    modules: true,
    scriptPath: join(root, "owner.mjs"),
    compatibilityDate: "2026-10-17",
    compatibilityFlags: ["nodejs_compat"],
    bindings: {
      COVE_CONSOLIDATED_OWNER_QA: "1",
      COVE_QA_SCHEDULE_OWNER_ENABLED: "1",
      FORE_ENVIRONMENT: "staging",
      COVE_SSR_STAGING: "1",
      COVE_RIGHTS_OWNER_ENABLED: "1",
      COVE_RIGHTS_OWNER_PRIMARY_ID: primary,
      COVE_LEGAL_WRITER_PRIMARY_ID: primary,
      COVE_PUBLICATION_COMMAND_TERRITORY: "US",
      COVE_PUBLICATION_COMMAND_CURRENCY: "USD",
      COVE_RIGHTS_OWNER_SECRET: secret,
      COVE_RIGHTS_OWNER_TEST_EXPIRES_AT: String(Date.now() + 840000),
      COVE_LEGAL_CONSUMER_STAGE_ENABLED: "1",
      COVE_CANONICAL_LEGAL_WRITE_LOCK: "1",
      FORE_BACKEND_TOKEN_SHA256: caller.bindings.FORE_BACKEND_TOKEN_SHA256,
      FORE_PUBLIC_URL: "https://fixture.invalid",
      NATIVE_COMMERCE_FIXTURE: "local-only",
      FORE_AUTH_MODE: "supabase",
      SUPABASE_URL: "https://native-commerce-auth.invalid",
      SUPABASE_PUBLISHABLE_KEY: "sb_publishable_local_commerce",
      STRIPE_SECRET_KEY: "sk_test_nativefixtureonly",
      STRIPE_WEBHOOK_SECRET: webhookSecret,
      STRIPE_LIVEMODE: "false",
      STRIPE_TAX_ENABLED: "false",
    },
    d1Databases: { PRIMARY_DB: primary },
    r2Buckets: { BUCKET: "native-commerce-media" },
    durableObjects: { LEGAL_AUTHORITY: { className: "CoveLegalAuthority", useSQLite: true } },
    outboundService: async (request) => {
      if (new URL(request.url).origin === "https://native-commerce-auth.invalid") {
        assert.equal(new URL(request.url).pathname, "/auth/v1/user");
        assert.equal(request.headers.get("authorization"), "Bearer " + authToken);
        return Response.json({
          id: userId.slice(3),
          aud: "authenticated",
          role: "authenticated",
          email: "native-commerce@test.invalid",
          email_confirmed_at: at,
          created_at: at,
          updated_at: at,
          app_metadata: { provider: "email", providers: ["email"] },
          user_metadata: {},
          identities: [],
        });
      }
      providerCalls++;
      const url = new URL(request.url);
      assert.equal(url.origin, "https://api.stripe.com");
      if (url.pathname === "/v1/refunds") {
        assert.equal(request.method, "POST");
        assert.equal(request.headers.get("idempotency-key"), "native-binding-refund-00000001");
        const form = new URLSearchParams(await request.text());
        assert.equal(form.get("payment_intent"), "pi_native_binding");
        assert.equal(form.get("amount"), "100");
        assert.equal(form.get("metadata[fore_order_id]"), orderId);
        refundPosts++;
        const refundId = form.get("metadata[fore_refund_id]");
        assert.match(refundId, /^ref_[a-zA-Z0-9_-]+$/);
        if (!refundRecord) {
          refundCreations++;
          refundRecord = {
            id: "re_native_binding",
            object: "refund",
            amount: 100,
            currency: "usd",
            payment_intent: { id: "pi_native_binding", object: "payment_intent", livemode: false },
            status: "succeeded",
            metadata: { fore_order_id: orderId, fore_refund_id: refundId },
          };
        }
        assert.equal(
          refundRecord.metadata.fore_refund_id,
          refundId,
          "Uncertain retry must reuse the exact canonical refund reservation",
        );
        if (loseRefundAcknowledgement) {
          loseRefundAcknowledgement = false;
          return new Response(null, { status: 503 });
        }
        return Response.json(refundRecord);
      }
      if (url.pathname === "/v1/refunds/re_native_binding") {
        assert.equal(request.method, "GET");
        assert.ok(refundRecord, "Provider cannot verify an uncreated refund");
        return Response.json(refundRecord);
      }
      assert.match(url.pathname, /^\/v1\/payment_intents\/pi_native_binding$/);
      if (providerUnavailable) return new Response(null, { status: 503 });
      return Response.json({
        id: "pi_native_binding",
        object: "payment_intent",
        status: "succeeded",
        livemode: false,
        amount: 100,
        amount_received: 100,
        currency: "usd",
        metadata: { fore_order_id: orderId },
        latest_charge: {
          id: "ch_native_binding",
          payment_intent: "pi_native_binding",
          refunded: false,
          amount_refunded: 0,
          disputed: false,
          balance_transaction: { id: "txn_native_binding", fee: 2, net: 98, currency: "usd" },
        },
      });
    },
  };
  const options = {
    workers: [caller, owner],
    resourcePersistencePath: join(root, "resources"),
    isolatedResourcePersistencePath: join(root, "isolated"),
    d1Persist: join(root, "d1"),
    durableObjectsPersist: join(root, "do"),
  };
  mf = new Miniflare(convertV4MiniflareOptions ? convertV4MiniflareOptions(options) : options);
  let db = await mf.getD1Database("PRIMARY_DB", "owner");
  const migrations = readdirSync("drizzle")
    .filter((n) => n.endsWith(".sql"))
    .sort();
  for (const name of migrations)
    await db.exec(compact(readFileSync(join("drizzle", name), "utf8")));
  const insert = async (table, value) => {
    const keys = Object.keys(value);
    await db
      .prepare(`INSERT INTO ${table}(${keys.join(",")}) VALUES(${keys.map(() => "?").join(",")})`)
      .bind(...keys.map((k) => value[k]))
      .run();
  };
  await insert("finance_parties", {
    id: "native_party",
    party_type: "author",
    display_name: "Local fixture",
    created_at: at,
    updated_at: at,
  });
  await insert("finance_royalty_contracts", {
    id: "native_finance_contract",
    name: "Local fixture",
    effective_from: at,
    created_at: at,
    updated_at: at,
  });
  await insert("finance_royalty_contract_versions", {
    id: "native_finance_version",
    contract_id: "native_finance_contract",
    version: 1,
    effective_from: at,
    created_at: at,
  });
  await insert("finance_royalty_splits", {
    id: "native_split",
    contract_version_id: "native_finance_version",
    party_id: "native_party",
    share_bps: 10000,
    created_at: at,
  });
  await insert("works", {
    id: "work_native_binding",
    title: "Native fixture",
    created_at: at,
    updated_at: at,
  });
  await insert("editions", {
    id: editionId,
    work_id: "work_native_binding",
    title: "Native fixture",
    release_status: "released",
    created_at: at,
    updated_at: at,
  });
  await insert("products", {
    id: productId,
    edition_id: editionId,
    sku: productId,
    format: "ebook",
    source_name: "publisher",
    source_external_id: productId,
    created_at: at,
    updated_at: at,
  });
  await insert("commerce_orders", {
    id: orderId,
    user_id: userId,
    invoice_number: "NATIVE-BINDING-1",
    status: "pending_payment",
    currency: "USD",
    territory_code: "US",
    subtotal_minor: 100,
    total_minor: 100,
    stripe_due_minor: 100,
    gift_card_minor: 0,
    store_credit_minor: 0,
    billing_address_json: "{}",
    idempotency_key: "native:binding:checkout",
    stripe_payment_intent_id: "pi_native_binding",
    created_at: at,
    updated_at: at,
  });
  await insert("commerce_order_items", {
    id: "item_native_binding",
    order_id: orderId,
    product_id: productId,
    title_snapshot: "Native fixture",
    sku_snapshot: productId,
    unit_amount_minor: 100,
    total_minor: 100,
    rights_grant_id: "grant_native_binding",
    rights_snapshot_json: JSON.stringify({
      grantId: "grant_native_binding",
      editionId,
      contractId: "contract_native_binding",
      contractVersionId: "version_native_binding",
      territory: "US",
      salesChannel: "retail",
    }),
    created_at: at,
  });
  await insert("digital_assets", {
    id: "native_epub_asset",
    edition_id: editionId,
    kind: "epub",
    current_version_id: "native_epub_version",
    created_at: at,
    updated_at: at,
  });
  await insert("asset_versions", {
    id: "native_epub_version",
    asset_id: "native_epub_asset",
    version_number: 1,
    object_key: "local/native.epub",
    mime_type: "application/epub+zip",
    created_at: at,
  });
  const mediaBytes = new Uint8Array([69, 80, 85, 66, 78, 65, 84, 73, 86, 69]);
  const bucket = await mf.getR2Bucket("BUCKET", "owner");
  await bucket.put("local/native.epub", mediaBytes);
  let legalClient = await mf.getWorker("owner"),
    client = await mf.getWorker("caller");
  assert.equal(
    (
      await legalClient.fetch("https://legal-authority.internal/fixture/seed-native-legal", {
        method: "POST",
        headers: { authorization: "Bearer " + secret },
      })
    ).status,
    200,
  );
  const event = JSON.stringify({
    id: "evt_native_binding",
    type: "payment_intent.succeeded",
    livemode: false,
    data: {
      object: {
        id: "pi_native_binding",
        amount_received: 100,
        currency: "usd",
        metadata: { fore_order_id: orderId },
        latest_charge: null,
      },
    },
  });
  const post = async (signatureValid = true) => {
    const ts = Math.floor(Date.now() / 1000);
    return client.fetch("https://fixture.invalid/api/fore/stripe/webhook", {
      method: "POST",
      headers: {
        "x-cove-backend-token": backendToken,
        "content-type": "application/json",
        "stripe-signature": `t=${ts},v1=${createHmac(
          "sha256",
          signatureValid ? webhookSecret : "invalid",
        )
          .update(ts + "." + event)
          .digest("hex")}`,
      },
      body: event,
    });
  };
  assert.equal((await post(false)).status, 400);
  const snapshot = async () =>
    db
      .prepare(
        "SELECT (SELECT status FROM commerce_orders WHERE id=?) status,(SELECT count(*) FROM entitlements WHERE user_id=?) entitlements,(SELECT count(*) FROM commerce_settlement_receipts WHERE order_id=?) receipts,(SELECT count(*) FROM commerce_ledger_entries WHERE order_id=?) ledger,(SELECT count(*) FROM finance_royalty_calculations WHERE order_id=?) royalties",
      )
      .bind(orderId, userId, orderId, orderId, orderId)
      .first();
  const before = await snapshot();
  assert.equal((await post()).status, 503, "Provider outage must not acknowledge fulfillment");
  assert.deepEqual(await snapshot(), before, "Provider outage must not commit any payment rows");
  providerUnavailable = false;
  const paid = await post();
  assert.equal(paid.status, 200, await paid.clone().text());
  const persisted = await snapshot();
  assert.equal(persisted.status, "paid");
  assert.equal(persisted.entitlements, 1);
  assert.equal(persisted.receipts, 1);
  assert.ok(persisted.ledger > 0);
  assert.equal(persisted.royalties, 1);
  assert.equal(
    (
      await db
        .prepare("SELECT SUM(amount_minor) total FROM commerce_ledger_entries WHERE order_id=?")
        .bind(orderId)
        .first()
    ).total,
    0,
  );
  assert.equal((await post()).status, 200);
  assert.deepEqual(await snapshot(), persisted);
  const acquireGrant = () =>
    client.fetch("https://fixture.invalid/api/fore/delivery/epub/grant", {
      method: "POST",
      headers: {
        "x-cove-backend-token": backendToken,
        "x-cove-client-country": "US",
        "content-type": "application/json",
        cookie,
      },
      body: JSON.stringify({ productId, purpose: "read" }),
    });
  const grantResponse = await acquireGrant();
  assert.equal(grantResponse.status, 201, await grantResponse.clone().text());
  const grant = await grantResponse.json();
  const redeem = () =>
    client.fetch("https://fixture.invalid" + grant.url, {
      headers: { "x-cove-backend-token": backendToken, "x-cove-client-country": "US" },
    });
  const delivered = await redeem();
  assert.equal(delivered.status, 200, await delivered.clone().text());
  assert.deepEqual(new Uint8Array(await delivered.arrayBuffer()), mediaBytes);
  assert.equal(
    (
      await db
        .prepare(
          "SELECT count(*) n FROM commercial_download_audit WHERE grant_id=? AND event_type IN ('grant_issued','stream_started')",
        )
        .bind(grant.grantId)
        .first()
    ).n,
    2,
  );
  // A disposable local staff principal reaches the original RBAC-protected
  // refund API. No production user/role or extra refund entrypoint is created.
  await insert("staff_roles", {
    id: "native_refund_role",
    name: "native_refund_role",
    description: "Disposable native fixture",
  });
  await insert("staff_role_permissions", {
    role_id: "native_refund_role",
    permission: "commerce.manage",
  });
  await insert("staff_principals", {
    user_id: userId,
    display_name: "Disposable refund operator",
    status: "active",
    mfa_required: 0,
    created_by_user_id: "native-local-fixture",
    created_at: at,
    updated_at: at,
  });
  await insert("staff_principal_roles", {
    user_id: userId,
    role_id: "native_refund_role",
    granted_at: at,
  });
  const requestRefund = () =>
    client.fetch("https://fixture.invalid/api/fore/admin/commerce/refund", {
      method: "POST",
      headers: { "x-cove-backend-token": backendToken, "content-type": "application/json", cookie },
      body: JSON.stringify({
        orderId,
        idempotencyKey: "native-binding-refund-00000001",
        reason: "requested_by_customer",
      }),
    });
  const uncertain = await requestRefund();
  assert.equal(uncertain.status, 502, await uncertain.clone().text());
  assert.equal(
    refundCreations,
    1,
    "Provider accepted exactly one refund before its acknowledgement was lost",
  );
  const pendingRefund = await db
    .prepare("SELECT id,status,succeeded_at FROM commerce_refunds WHERE order_id=?")
    .bind(orderId)
    .first();
  assert.ok(pendingRefund);
  assert.equal(pendingRefund.status, "pending");
  assert.equal(pendingRefund.succeeded_at, null);
  assert.equal(
    (
      await db
        .prepare("SELECT count(*) n FROM commerce_ledger_entries WHERE refund_id=?")
        .bind(pendingRefund.id)
        .first()
    ).n,
    0,
  );
  assert.equal(
    (
      await db
        .prepare("SELECT status FROM entitlements WHERE order_item_id='item_native_binding'")
        .first()
    ).status,
    "revoked",
  );
  assert.equal((await redeem()).status, 410);
  assert.equal((await acquireGrant()).status, 403);
  // A genuine runtime restart loses in-memory commands while retaining the
  // owner/D1 journals and the provider's idempotent accepted refund.
  await mf.dispose();
  mf = new Miniflare(convertV4MiniflareOptions ? convertV4MiniflareOptions(options) : options);
  client = await mf.getWorker("caller");
  db = await mf.getD1Database("PRIMARY_DB", "owner");
  const reconciled = await requestRefund();
  assert.equal(reconciled.status, 200, await reconciled.clone().text());
  assert.equal(refundPosts, 2);
  assert.equal(refundCreations, 1, "Uncertain retry must not create a second external refund");
  const refundRows = async () =>
    db
      .prepare(
        "SELECT (SELECT count(*) FROM commerce_refunds WHERE order_id=?) refunds,(SELECT count(*) FROM commerce_ledger_entries WHERE refund_id=?) ledger,(SELECT SUM(amount_minor) FROM commerce_ledger_entries WHERE refund_id=?) balance,(SELECT count(*) FROM finance_royalty_calculations WHERE order_id=? AND source_type='refund') royalties",
      )
      .bind(orderId, pendingRefund.id, pendingRefund.id, orderId)
      .first();
  const postedRefund = await refundRows();
  assert.equal(postedRefund.refunds, 1);
  assert.equal(postedRefund.ledger, 2);
  assert.equal(postedRefund.balance, 0);
  assert.equal(postedRefund.royalties, 1);
  const royaltyReversal = await db
    .prepare(
      "SELECT source_type,customer_price_minor,basis_minor FROM finance_royalty_calculations WHERE order_id=? ORDER BY source_type",
    )
    .bind(orderId)
    .all();
  const saleRoyalty = royaltyReversal.results.find((row) => row.source_type === "sale");
  const refundRoyalty = royaltyReversal.results.find((row) => row.source_type === "refund");
  assert.equal(saleRoyalty.customer_price_minor, 100);
  assert.equal(refundRoyalty.customer_price_minor, -100);
  assert.equal(
    refundRoyalty.basis_minor,
    -saleRoyalty.basis_minor,
    "Full refund must reverse the persisted royalty basis",
  );
  assert.deepEqual(
    await db
      .prepare("SELECT status,refunded_minor FROM commerce_orders WHERE id=?")
      .bind(orderId)
      .first(),
    { status: "refunded", refunded_minor: 100 },
  );
  const canonicalRefund = await db
    .prepare("SELECT status,provider_refund_id,succeeded_at FROM commerce_refunds WHERE id=?")
    .bind(pendingRefund.id)
    .first();
  assert.equal(canonicalRefund.status, "succeeded");
  assert.equal(canonicalRefund.provider_refund_id, "re_native_binding");
  assert.ok(canonicalRefund.succeeded_at);
  const callsAfterRefund = providerCalls;
  assert.equal((await requestRefund()).status, 200);
  assert.deepEqual(await refundRows(), postedRefund);
  assert.equal(
    providerCalls,
    callsAfterRefund,
    "Completed refund retry must not repeat provider operations",
  );
  const callsBeforeRestart = providerCalls;
  await mf.dispose();
  mf = new Miniflare(convertV4MiniflareOptions ? convertV4MiniflareOptions(options) : options);
  client = await mf.getWorker("caller");
  assert.equal((await post()).status, 200);
  assert.equal(
    providerCalls,
    callsBeforeRestart,
    "Durable webhook replay must not repeat provider verification",
  );
  console.log(
    "PASS: actual native named owner binding, all-schema settlement/delivery/refund, lost provider acknowledgement, restart, balanced reversal ledger/royalties and exact replay",
    JSON.stringify({
      migrations: migrations.length,
      callerD1Bindings: 0,
      persisted,
      postedRefund,
      refundCreations,
      productionAccess: false,
      hosted: false,
    }),
  );
} finally {
  await mf?.dispose();
  rmSync(root, { recursive: true, force: true });
}
