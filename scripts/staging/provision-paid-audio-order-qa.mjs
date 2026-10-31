import assert from "node:assert/strict";

/** Seed ONLY a fresh synthetic audiobook purchase in the fixed paid-QA DB.
 * Existing ebook rows, contracts and immutable acquired scopes are untouched. */
export async function provisionPaidAudioOrder(qaSql, { runId, buyerId, evidenceSha }) {
  assert.match(runId, /^\d{8,15}-\d{1,5}$/);
  assert.equal(buyerId, "user_initial_qa_" + runId);
  assert.match(evidenceSha, /^[a-f0-9]{64}$/);
  const at = new Date().toISOString(),
    id = (name) => "qa_audio_" + name + "_" + runId;
  const productId = "prd_audio_qa_" + runId,
    editionId = id("catalog_edition"),
    contractId = id("rights_contract"),
    versionId = id("rights_version"),
    grantId = id("grant"),
    orderId = "order_audio_qa_" + runId,
    itemId = id("order_item");
  const allowed = new Set([
    "editions",
    "products",
    "rights_contracts",
    "rights_contract_versions",
    "rights_grants",
    "offers",
    "commerce_orders",
    "commerce_order_items",
  ]);
  async function clone(table, fromId, overrides) {
    assert.ok(allowed.has(table));
    const cols = (await qaSql("PRAGMA table_info(" + table + ")")).results.map((x) => x.name);
    assert.ok(Object.keys(overrides).every((k) => cols.includes(k)));
    const quote = (key) => '"' + key.replaceAll('"', '""') + '"';
    const result = await qaSql(
      "INSERT INTO " +
        table +
        "(" +
        cols.map(quote).join(",") +
        ") SELECT " +
        cols.map((k) => (Object.hasOwn(overrides, k) ? "?" : quote(k))).join(",") +
        " FROM " +
        table +
        " WHERE id=?",
      [...cols.filter((k) => Object.hasOwn(overrides, k)).map((k) => overrides[k]), fromId],
    );
    assert.equal(result.meta?.changes, 1, "Synthetic audiobook clone failed: " + table);
  }
  await clone("editions", "ed_paid_qa_20261027", {
    id: editionId,
    public_id: null,
    title: "Original generated QA audiobook",
    created_at: at,
    updated_at: at,
  });
  await clone("products", "prd_paid_qa_20261027", {
    id: productId,
    public_id: null,
    edition_id: editionId,
    format: "audiobook",
    sku: id("sku"),
    source_external_id: id("source"),
    created_at: at,
    updated_at: at,
  });
  await clone("rights_contracts", "rcontract_paid_qa_20261027", {
    id: contractId,
    reference_code: id("reference"),
    name: "Original generated audio QA authorization",
    created_at: at,
    updated_at: at,
  });
  await clone("rights_contract_versions", "rcv_paid_qa_20261027", {
    id: versionId,
    contract_id: contractId,
    status: "draft",
    document_sha256: evidenceSha,
    source_document_object_key: "qa/rights.txt",
    approved_by_user_id: buyerId,
    approved_at: at,
    created_at: at,
  });
  await qaSql(
    "INSERT INTO rights_contract_version_territories(contract_version_id,territory_code,decision) VALUES(?,'US','allow')",
    [versionId],
  );
  await qaSql(
    "INSERT INTO rights_contract_version_formats(contract_version_id,format,decision,drm_requirement,offline_permitted) VALUES(?,'audiobook','allow','none',1)",
    [versionId],
  );
  await qaSql(
    "INSERT INTO rights_contract_version_channels(contract_version_id,sales_channel,permitted) VALUES(?,'retail',1)",
    [versionId],
  );
  await qaSql("UPDATE rights_contract_versions SET status='active' WHERE id=? AND status='draft'", [
    versionId,
  ]);
  await clone("rights_grants", "rgrant_paid_qa_20261027", {
    id: grantId,
    edition_id: editionId,
    format: "audiobook",
    contract_id: contractId,
    contract_version_id: versionId,
    source: "original_generated_audio_qa",
    created_at: at,
    updated_at: at,
  });
  const offer = (
    await qaSql("SELECT id FROM offers WHERE product_id=? AND active=1 LIMIT 1", [
      "prd_paid_qa_20261027",
    ])
  ).results[0];
  assert.ok(offer?.id, "Paid QA source must have a real active offer");
  const offerId = id("offer");
  await clone("offers", offer.id, {
    id: offerId,
    product_id: productId,
    created_at: at,
    updated_at: at,
  });
  await qaSql(
    "INSERT INTO catalog_search_documents(product_id,external_book_id,title,format,availability,currency,suppressed,first_ingested_at,updated_at) VALUES(?,?,?,'audiobook','available','USD',0,?,?)",
    [productId, id("source"), "Original generated QA audiobook", at, at],
  );
  await clone("commerce_orders", "order_paid_qa_20261027", {
    id: orderId,
    user_id: buyerId,
    invoice_number: "QA-AUDIO-" + runId,
    idempotency_key: "qa:audio:" + runId,
    status: "pending_payment",
    stripe_payment_intent_id: null,
    stripe_charge_id: null,
    receipt_url: null,
    paid_at: null,
    created_at: at,
    updated_at: at,
  });
  const baseLine = (
    await qaSql("SELECT id FROM commerce_order_items WHERE order_id=? ORDER BY id LIMIT 2", [
      "order_paid_qa_20261027",
    ])
  ).results;
  assert.equal(baseLine.length, 1);
  await clone("commerce_order_items", baseLine[0].id, {
    id: itemId,
    order_id: orderId,
    product_id: productId,
    offer_id: offerId,
    title_snapshot: "Original generated QA audiobook",
    sku_snapshot: id("sku"),
    rights_grant_id: grantId,
    rights_decision_id: null,
    rights_snapshot_json: JSON.stringify({
      grantId,
      editionId,
      territory: "US",
      salesChannel: "retail",
      contractId,
      contractVersionId: versionId,
    }),
    entitlement_status: "pending",
    fulfillment_status: "pending",
    royalty_contract_version_id: null,
    created_at: at,
  });
  const partyId = id("payee"),
    financeId = id("finance_contract"),
    financeVersion = id("finance_version");
  await qaSql(
    "INSERT INTO finance_parties(id,party_type,display_name,created_at,updated_at) VALUES(?,'author','Original audio synthetic QA payee',?,?)",
    [partyId, at, at],
  );
  await qaSql(
    "INSERT INTO finance_royalty_contracts(id,name,product_id,effective_from,created_at,updated_at) VALUES(?,'Audio QA settlement terms',?,?,?,?)",
    [financeId, productId, at, at, at],
  );
  await qaSql(
    "INSERT INTO finance_royalty_contract_versions(id,contract_id,version,effective_from,created_at) VALUES(?,?,1,?,?)",
    [financeVersion, financeId, at, at],
  );
  await qaSql(
    "INSERT INTO finance_royalty_splits(id,contract_version_id,party_id,share_bps,created_at) VALUES(?,?,?,10000,?)",
    [id("split"), financeVersion, partyId, at],
  );
  return { productId, editionId, grantId, contractId, versionId, orderId, buyerId };
}
