import assert from "node:assert/strict";

// The original QA license assigns 100% retailer commission, with no
// third-party royalty obligation. The synthetic payee stays on hold and
// cannot enter a payout. These terms cover only the two isolated fixtures.
const party = "qa-owner-v2-finance-party";
const products = [
  {
    id: "prd_qa_owner_v2_audio",
    edition: "qa-owner-v2-audio-edition",
    format: "audiobook",
    key: "audio",
  },
  {
    id: "prd_qa_owner_v2_ebook",
    edition: "qa-owner-v2-ebook-edition",
    format: "ebook",
    key: "ebook",
  },
];
const contract = (p) => "qa-owner-v2-finance-" + p.key;
const version = (p) => contract(p) + "-v1";

function date(at) {
  assert.equal(new Date(at).toISOString(), at, "Expected canonical ISO timestamp");
  return at;
}

// Called only inside the existing isolated-account/database-verified
// provisioning operation; never called by a customer-facing runtime.
export function originalQaRoyaltyStatements(at) {
  date(at);
  return [
    `INSERT OR IGNORE INTO finance_parties(id,party_type,display_name,tax_country,withholding_bps,payout_currency,status,created_at,updated_at) VALUES('${party}','publisher','Original synthetic QA payee','US',0,'USD','hold','${at}','${at}')`,
    ...products.flatMap((p) => [
      `INSERT OR IGNORE INTO finance_royalty_contracts(id,name,product_id,edition_id,territory_code,format,sales_channel,effective_from,status,created_at,updated_at) VALUES('${contract(p)}','Original synthetic QA retail terms','${p.id}','${p.edition}','US','${p.format}','retail','${at}','active','${at}','${at}')`,
      `INSERT OR IGNORE INTO finance_royalty_contract_versions(id,contract_id,version,calculation_basis,fore_commission_bps,payment_terms_days,reserve_bps,effective_from,created_at,notes) VALUES('${version(p)}','${contract(p)}',1,'net_revenue',10000,60,0,'${at}','${at}','Isolated original QA license; no third-party royalty or payout')`,
      `INSERT OR IGNORE INTO finance_royalty_splits(id,contract_version_id,party_id,share_bps,priority,created_at) VALUES('${version(p)}-split','${version(p)}','${party}',10000,0,'${at}')`,
    ]),
  ];
}

// Match the production owner's contractForContext eligibility predicate,
// then require a single exact scoped version and one exact held payee. A
// conflict or existing drift fails before charging Stripe; never overwrite
// a historical financial contract or use a generic fallback contract.
export function originalQaRoyaltyCoverageSql(at) {
  date(at);
  return `SELECT p.id AS product_id,p.format,p.edition_id,rc.id AS contract_id,
    v.id AS version_id,rc.product_id AS contract_product,rc.edition_id AS contract_edition,
    rc.territory_code,rc.format AS contract_format,rc.sales_channel,rc.publisher_id,
    v.version,v.calculation_basis,v.fore_commission_bps,v.default_royalty_rate_bps,
    v.payment_terms_days,v.reserve_bps,
    (SELECT COUNT(*) FROM finance_royalty_rules r WHERE r.contract_version_id=v.id) AS rule_count,
    (SELECT COUNT(*) FROM finance_royalty_splits s WHERE s.contract_version_id=v.id) AS split_count,
    (SELECT COUNT(*) FROM finance_royalty_splits s JOIN finance_parties fp ON fp.id=s.party_id
      WHERE s.contract_version_id=v.id AND s.id=v.id||'-split' AND s.party_id='${party}'
        AND s.share_bps=10000 AND s.priority=0 AND s.recoupment_account IS NULL
        AND fp.status='hold' AND fp.party_type='publisher' AND fp.payout_currency='USD'
        AND fp.withholding_bps=0 AND fp.publisher_id IS NULL AND fp.contributor_id IS NULL) AS valid_split
    FROM products p JOIN editions e ON e.id=p.edition_id
    JOIN finance_royalty_contracts rc ON rc.status='active'
      AND (rc.product_id=p.id OR rc.product_id IS NULL)
      AND (rc.edition_id=e.id OR rc.edition_id IS NULL)
      AND (rc.publisher_id=e.publisher_id OR rc.publisher_id IS NULL)
      AND (rc.territory_code IS NULL OR upper(rc.territory_code)='US')
      AND (rc.format IS NULL OR lower(rc.format)=lower(p.format))
      AND (rc.sales_channel IS NULL OR lower(rc.sales_channel)='retail')
      AND rc.effective_from<='${at}' AND (rc.effective_to IS NULL OR rc.effective_to>'${at}')
    JOIN finance_royalty_contract_versions v ON v.contract_id=rc.id
      AND v.effective_from<='${at}' AND (v.effective_to IS NULL OR v.effective_to>'${at}')
    WHERE p.id IN ('prd_qa_owner_v2_audio','prd_qa_owner_v2_ebook')
    ORDER BY p.id,rc.id,v.id`;
}

export function assertOriginalQaRoyaltyCoverage(rows) {
  assert.equal(rows.length, products.length, "QA royalty coverage missing or ambiguous");
  for (const [i, p] of products.entries()) {
    const r = rows[i];
    assert.ok(
      r.product_id === p.id &&
        r.format === p.format &&
        r.edition_id === p.edition &&
        r.contract_id === contract(p) &&
        r.version_id === version(p) &&
        r.contract_product === p.id &&
        r.contract_edition === p.edition &&
        r.territory_code === "US" &&
        r.contract_format === p.format &&
        r.sales_channel === "retail" &&
        r.publisher_id === null &&
        r.version === 1 &&
        r.calculation_basis === "net_revenue" &&
        r.fore_commission_bps === 10000 &&
        r.default_royalty_rate_bps === null &&
        r.payment_terms_days === 60 &&
        r.reserve_bps === 0 &&
        r.rule_count === 0 &&
        r.split_count === 1 &&
        r.valid_split === 1,
      "QA royalty terms drifted for " + p.key,
    );
  }
}
