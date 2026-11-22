/* eslint-disable prettier/prettier -- Fixed aggregate-only historical rights provenance contract. */
/**
 * This is a REAL primary-D1 historical inventory, not legal authorization.
 * No identity, book, contract, SQL or legal evidence text is allowed out.
 * The current owner denial epoch is a separate, mandatory proof that this
 * source inventory deliberately does not possess.
 */
export const HISTORICAL_PRIMARY_INVENTORY_SCHEMA = "cove.primary-historical-rights-inventory.v1";

export const HISTORICAL_SQL = Object.freeze({
  state: [
    "SELECT (SELECT COUNT(*) FROM products) product_total,",
    "(SELECT COUNT(*) FROM products WHERE storefront_status='active') active_products,",
    "(SELECT COUNT(*) FROM products WHERE storefront_status<>'active') inactive_products,",
    "(SELECT COUNT(*) FROM rights_grants) grant_total,",
    "(SELECT COUNT(*) FROM rights_grants WHERE status='active' AND decision='allow') active_allow_grants,",
    "(SELECT COUNT(*) FROM rights_grants WHERE status='suspended') suspended_grants,",
    "(SELECT COUNT(*) FROM products p WHERE p.storefront_status='active' AND NOT EXISTS(",
    "SELECT 1 FROM rights_grants g WHERE g.edition_id=p.edition_id AND lower(g.format)=lower(p.format)",
    "AND g.status='active' AND g.decision='allow')) active_uncovered,",
    "(SELECT COUNT(*) FROM products p WHERE p.storefront_status<>'active' AND NOT EXISTS(",
    "SELECT 1 FROM rights_grants g WHERE g.edition_id=p.edition_id AND lower(g.format)=lower(p.format))) inactive_without_grant,",
    "(SELECT COUNT(*) FROM rights_contracts) contracts,",
    "(SELECT COUNT(*) FROM rights_contract_versions) contract_versions,",
    "(SELECT COUNT(*) FROM storefront_markets WHERE market_status='active') active_markets",
  ].join(" "),
  evidence: [
    "SELECT COUNT(*) joined_grants,",
    "SUM(CASE WHEN ev.id IS NULL THEN 1 ELSE 0 END) missing_evidence,",
    "SUM(CASE WHEN ev.status<>'approved' OR ev.determination<>'public-domain'",
    "OR ev.territory_code<>rg.territory_code THEN 1 ELSE 0 END) unapproved_or_mismatched,",
    "SUM(CASE WHEN length(ev.evidence_hash)<>64 OR ev.evidence_hash GLOB '*[^0-9a-f]*'",
    "THEN 1 ELSE 0 END) legacy_evidence_hashes,",
    "SUM(CASE WHEN ev.evidence_type<>'source-catalog' THEN 1 ELSE 0 END) other_evidence_types",
    "FROM rights_grants rg LEFT JOIN gutenberg_rights_evidence ev ON ev.id=rg.source_evidence_id",
  ].join(" "),
  exposure: [
    "SELECT (SELECT COUNT(*) FROM retail_product_availability_rows) retail_rows,",
    "(SELECT COUNT(*) FROM rights_grant_territories) scoped_grants,",
    "(SELECT COUNT(DISTINCT territory_code) FROM rights_grant_territories) scoped_territories,",
    "(SELECT COUNT(*) FROM rights_grants WHERE decision='deny') explicit_deny_grants,",
    "(SELECT COUNT(*) FROM copyright_notices) copyright_notices",
  ].join(" "),
});

const EXPECTED = Object.freeze({
  state: Object.freeze([
    "product_total","active_products","inactive_products","grant_total",
    "active_allow_grants","suspended_grants","active_uncovered","inactive_without_grant",
    "contracts","contract_versions","active_markets",
  ]),
  evidence: Object.freeze([
    "joined_grants","missing_evidence","unapproved_or_mismatched",
    "legacy_evidence_hashes","other_evidence_types",
  ]),
  exposure: Object.freeze([
    "retail_rows","scoped_grants","scoped_territories",
    "explicit_deny_grants","copyright_notices",
  ]),
});

export function checkedHistoricalAggregate(kind,rows) {
  if(!Object.prototype.hasOwnProperty.call(EXPECTED,kind)||!Array.isArray(rows)||rows.length!==1||
     !rows[0]||typeof rows[0]!=="object"||Array.isArray(rows[0]))
    throw Error("historical_primary_aggregate_shape_not_reviewed");
  const keys=Object.keys(rows[0]).sort();
  if(keys.join("|")!==[...EXPECTED[kind]].sort().join("|"))
    throw Error("historical_primary_aggregate_shape_not_reviewed");
  const output={};
  for(const key of EXPECTED[kind]){
    const value=rows[0][key];
    if(typeof value!=="number"||!Number.isSafeInteger(value)||value<0)
      throw Error("historical_primary_aggregate_value_invalid");
    output[key]=value;
  }
  return output;
}

export function verifyHistoricalPrimaryInventory(first,second){
  if(!first||!second||typeof first!=="object"||typeof second!=="object")
    throw Error("historical_primary_inventory_missing");
  // Check against the exact column contract even in offline/consumer calls.
  for(const kind of Object.keys(EXPECTED)){
    checkedHistoricalAggregate(kind,[first[kind]]);
    checkedHistoricalAggregate(kind,[second[kind]]);
  }
  const x=first.state,e=first.evidence,v=first.exposure;
  const blockers=[];
  if(JSON.stringify(first)!==JSON.stringify(second))
    blockers.push("historical_primary_changed_during_inventory");
  if(x.product_total<1||x.active_products+x.inactive_products!==x.product_total)
    blockers.push("historical_primary_product_partition");
  if(x.grant_total!==x.active_allow_grants+x.suspended_grants)
    blockers.push("historical_primary_grant_partition_unreviewed");
  if(x.active_uncovered!==0)
    blockers.push("historical_primary_active_grants_missing");
  if(x.active_markets<1)
    blockers.push("historical_primary_no_market");
  if(e.joined_grants!==x.grant_total||e.missing_evidence!==0||
     e.unapproved_or_mismatched!==0)
    blockers.push("historical_primary_evidence_lineage_incomplete");
  if(v.scoped_grants<x.grant_total||v.scoped_territories<1)
    blockers.push("historical_primary_territory_scope_incomplete");
  if(v.retail_rows<0||v.explicit_deny_grants>x.grant_total)
    blockers.push("historical_primary_publication_counts_unreviewed");
  // Legacy short fingerprints are NOT equivalent to cryptographic source
  // provenance. This remains a separate unsatisfied positive-release gate.
  if(e.legacy_evidence_hashes>0)
    blockers.push("historical_legacy_evidence_fingerprints_not_sha256");
  // Neither D1 historical counts nor a catalog view proves current DO denial,
  // rightsholder authority, historical change-log completeness or full policy
  // parity. They MUST NEVER be converted into an allow receipt.
  blockers.push("current_owner_denial_epoch_not_proven");
  blockers.push("atomic_owner_primary_generation_not_published");
  blockers.push("full_canonical_policy_parity_not_proven");
  return {
    schema:HISTORICAL_PRIMARY_INVENTORY_SCHEMA,
    source:"production-primary-d1-read-only",
    sampleBased:false,
    scannedProductCount:x.product_total,
    counts:{...x,...e,...v},
    historicalInventoryConsistent:!blockers.some(b=>b.startsWith("historical_primary_")),
    historicalRightsReconciled:false,
    currentOwnerVerified:false,
    authorizing:false,
    permitsPublication:false,
    releaseCertified:false,
    blockers,
  };
}

export function checkedHistoricalD1Response(body){
  if(!body||body.success!==true||!Array.isArray(body.result)||body.result.length!==1||
     body.result[0]?.success!==true||!Array.isArray(body.result[0]?.results)||
     body.result[0]?.meta?.changed_db!==false||
     body.result[0]?.meta?.changes!==0)
    throw Error("historical_primary_non_readonly_or_invalid_d1_response");
  return body.result[0].results;
}
