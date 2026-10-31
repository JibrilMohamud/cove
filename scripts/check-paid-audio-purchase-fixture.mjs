import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { provisionPaidAudioOrder } from "./staging/provision-paid-audio-order-qa.mjs";

const db = new DatabaseSync(":memory:"),
  dir = mkdtempSync(join(tmpdir(), "cove-audio-purchase-"));
try {
  db.exec("PRAGMA foreign_keys=ON");
  for (const name of readdirSync("drizzle")
    .filter((x) => x.endsWith(".sql"))
    .sort())
    db.exec(readFileSync(join("drizzle", name), "utf8"));
  const at = new Date().toISOString();
  const insert = (table, row) => {
    const keys = Object.keys(row);
    db.prepare(
      "INSERT INTO " +
        table +
        "(" +
        keys.join(",") +
        ") VALUES(" +
        keys.map(() => "?").join(",") +
        ")",
    ).run(...keys.map((k) => row[k]));
  };
  insert("works", {
    id: "wrk_paid_qa",
    title: "Synthetic original work",
    created_at: at,
    updated_at: at,
  });
  insert("editions", {
    id: "ed_paid_qa_20261027",
    work_id: "wrk_paid_qa",
    title: "Original ebook",
    created_at: at,
    updated_at: at,
  });
  insert("products", {
    id: "prd_paid_qa_20261027",
    edition_id: "ed_paid_qa_20261027",
    sku: "original_ebook_qa",
    format: "ebook",
    source_name: "publisher",
    source_external_id: "original_ebook_qa",
    created_at: at,
    updated_at: at,
  });
  insert("rights_contracts", {
    id: "rcontract_paid_qa_20261027",
    reference_code: "qa_ebook_contract",
    name: "Original ebook only",
    created_at: at,
    updated_at: at,
  });
  insert("rights_contract_versions", {
    id: "rcv_paid_qa_20261027",
    contract_id: "rcontract_paid_qa_20261027",
    version_number: 1,
    status: "draft",
    effective_from: "2026-01-01",
    retailer_commission_bps: 1000,
    created_at: at,
  });
  insert("rights_contract_version_formats", {
    contract_version_id: "rcv_paid_qa_20261027",
    format: "ebook",
  });
  db.prepare("UPDATE rights_contract_versions SET status='active' WHERE id=?").run(
    "rcv_paid_qa_20261027",
  );
  insert("rights_grants", {
    id: "rgrant_paid_qa_20261027",
    edition_id: "ed_paid_qa_20261027",
    territory_code: "US",
    format: "ebook",
    license_type: "retail",
    contract_id: "rcontract_paid_qa_20261027",
    contract_version_id: "rcv_paid_qa_20261027",
    created_at: at,
    updated_at: at,
  });
  insert("offers", {
    id: "qa_ebook_offer",
    product_id: "prd_paid_qa_20261027",
    offer_type: "purchase",
    currency: "USD",
    amount_minor: 399,
    created_at: at,
    updated_at: at,
  });
  insert("commerce_orders", {
    id: "order_paid_qa_20261027",
    user_id: "qa_ebook_buyer",
    invoice_number: "QA-BASE",
    status: "paid",
    currency: "USD",
    territory_code: "US",
    subtotal_minor: 399,
    total_minor: 399,
    stripe_due_minor: 399,
    billing_address_json: "{}",
    idempotency_key: "qa:base",
    created_at: at,
    updated_at: at,
  });
  insert("commerce_order_items", {
    id: "qa_ebook_item",
    order_id: "order_paid_qa_20261027",
    product_id: "prd_paid_qa_20261027",
    title_snapshot: "Original ebook",
    sku_snapshot: "qa_ebook",
    unit_amount_minor: 399,
    total_minor: 399,
    rights_grant_id: "rgrant_paid_qa_20261027",
    created_at: at,
  });
  const before = db
    .prepare("SELECT * FROM rights_contract_versions WHERE id='rcv_paid_qa_20261027'")
    .get();
  const qaSql = async (sql, params = []) => {
    const st = db.prepare(sql);
    return st.columns().length
      ? { results: st.all(...params) }
      : { results: [], meta: { changes: Number(st.run(...params).changes) } };
  };
  const runId = "41206657552-9",
    buyerId = "user_initial_qa_" + runId;
  const audio = await provisionPaidAudioOrder(qaSql, {
    runId,
    buyerId,
    evidenceSha: "a".repeat(64),
  });
  assert.notEqual(audio.productId, "prd_paid_qa_20261027");
  assert.notEqual(audio.editionId, "ed_paid_qa_20261027");
  assert.deepEqual(
    db.prepare("SELECT * FROM rights_contract_versions WHERE id='rcv_paid_qa_20261027'").get(),
    before,
    "Ebook contract cannot be broadened for audio",
  );
  assert.equal(
    db.prepare("SELECT format FROM products WHERE id=?").get(audio.productId).format,
    "audiobook",
  );
  const line = db.prepare("SELECT * FROM commerce_order_items WHERE order_id=?").get(audio.orderId),
    scope = JSON.parse(line.rights_snapshot_json);
  assert.equal(scope.grantId, audio.grantId);
  assert.equal(scope.contractVersionId, audio.versionId);
  assert.equal(scope.editionId, audio.editionId);
  assert.equal(
    db.prepare("SELECT status FROM commerce_orders WHERE id=?").get(audio.orderId).status,
    "pending_payment",
  );
  assert.equal(
    db.prepare("SELECT COUNT(*) n FROM entitlements WHERE product_id=?").get(audio.productId).n,
    0,
    "Fixture cannot synthesize a paid entitlement",
  );
  assert.throws(
    () =>
      db
        .prepare(
          "INSERT INTO rights_contract_version_formats(contract_version_id,format) VALUES(?,'ebook')",
        )
        .run(audio.versionId),
    /immutable/,
  );
  await build({
    entryPoints: ["src/features/fore/rights.server.ts"],
    outfile: join(dir, "rights.mjs"),
    bundle: true,
    platform: "node",
    format: "esm",
    logLevel: "silent",
  });
  const { resolveProductRights } = await import(pathToFileURL(join(dir, "rights.mjs")).href);
  const D1 = {
    prepare(sql) {
      let values = [];
      const st = db.prepare(sql);
      return {
        bind(...args) {
          values = args;
          return this;
        },
        async first() {
          return st.get(...values) || null;
        },
        async all() {
          return { results: st.all(...values) };
        },
        async run() {
          return { meta: { changes: Number(st.run(...values).changes) } };
        },
      };
    },
  };
  const allowed = await resolveProductRights(D1, audio.productId, "US", {
    salesChannel: "retail",
    persist: false,
  });
  assert.equal(allowed.allowed, true, JSON.stringify(allowed));
  assert.equal(allowed.grantId, audio.grantId);
  assert.equal(allowed.contractVersionId, audio.versionId);
  assert.equal(
    (
      await resolveProductRights(D1, audio.productId, "CA", {
        salesChannel: "retail",
        persist: false,
      })
    ).allowed,
    false,
  );
  await assert.rejects(
    provisionPaidAudioOrder(qaSql, { runId, buyerId: "other-user", evidenceSha: "a".repeat(64) }),
  );
  console.log(
    "PASS: real full schema, separate audio SKU/edition/contract/format/grant/order/royalty terms; original ebook unchanged; no unpaid entitlement; immutable scope and live canonical territorial rights",
  );
} finally {
  db.close();
  rmSync(dir, { recursive: true, force: true });
}
