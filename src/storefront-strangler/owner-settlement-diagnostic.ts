/* eslint-disable prettier/prettier -- Private QA diagnostics never include SQL, credentials, provider bodies or buyer data. */
export function ownerSettlementDiagnostic(error:unknown):string {
  if(!(error instanceof Error))return "unclassified_failure";
  const message=error.message;
  // These are fixed internal verifier codes, not arbitrary exception text.
  if(/^(?:owner_(?:stripe|settlement)_[a-z_]+|invalid_owner_settlement_command|internal_order_has_stripe_identity)$/.test(message))return message;
  // Diagnose the exact stage that refused a real hosted Stripe TEST order.
  // No resource IDs, buyer data, provider bodies or raw exception text are
  // returned to the QA ingress: only fixed, reviewed classifications.
  const knownSettlementFailures:Record<string,string>={
    "Order not found.":"settlement_order_not_found",
    "Settlement provider does not match canonical tender.":"settlement_tender_mismatch",
    "Settlement receipt has been superseded.":"settlement_receipt_conflict",
    "Terminal or invalid order cannot be settled.":"settlement_terminal_order",
    "Invalid settlement buyer identity.":"settlement_buyer_identity_invalid",
    "Settlement amounts do not balance.":"settlement_amount_mismatch",
    "Settlement line inventory is invalid or already partially written.":"settlement_line_inventory_invalid",
    "Settlement reservations do not cover canonical tender.":"settlement_reservation_mismatch",
    "Settlement product is unavailable.":"settlement_product_unavailable",
    "Preorder plan cannot accept this settlement.":"settlement_preorder_plan_invalid",
    "Complete Stripe fee evidence is required before settlement.":"settlement_fee_evidence_missing",
    "Unbalanced settlement journal.":"settlement_journal_unbalanced",
    "Settlement commit was not acknowledged.":"settlement_commit_unacknowledged",
    "Atomic settlement receipt is missing.":"settlement_effects_receipt_missing",
    "Settlement was revoked before reconciliation.":"settlement_revoked_during_recovery",
    "isolated_settlement_effect_interruption":"qa_expected_effect_interruption"
  };
  if(Object.hasOwn(knownSettlementFailures,message))return knownSettlementFailures[message];
  if(/^No active royalty contract covers .+ \/ [A-Z]{2} \/ [a-z_]+\.$/.test(message))
    return "settlement_royalty_contract_missing";
  if(/^Royalty contract version .+ has no payee splits\.$/.test(message))
    return "settlement_royalty_splits_missing";
  if(/^Royalty split must allocate exactly 100% for contract version .+; found [0-9.]+%\.$/.test(message))
    return "settlement_royalty_splits_invalid";
  const missing=message.match(/no such (table|column):\s*([a-z_][a-z0-9_.]*)/i);
  if(missing)return "missing_"+missing[1].toLowerCase()+":"+missing[2].toLowerCase().slice(0,100);
  if(/too many SQL variables/i.test(message))return "database_parameter_limit";
  if(/CHECK constraint failed/i.test(message))return "database_check_rejected";
  if(/FOREIGN KEY constraint failed/i.test(message))return "database_foreign_key_rejected";
  if(/UNIQUE constraint failed/i.test(message))return "database_duplicate_rejected";
  if(/NOT NULL constraint failed/i.test(message))return "database_required_value_missing";
  if(/D1_ERROR|SQLITE_ERROR/.test(message))return "database_execution_failed";
  // Source/stack is used only to choose a fixed code. Never reflect it back:
  // deployed errors can contain SQL, provider messages, or customer identifiers.
  // These names survive the owner's isolated bundled build in the QA harness.
  const stack=typeof error.stack==="string"?error.stack:"";
  for(const [frame,code] of [
    ["calculateAndAccrueRoyalty","settlement_royalty_calculation_failed"],
    ["accrueSaleRoyaltiesForOrder","settlement_royalty_accrual_failed"],
    ["postPaidSettlementTransaction","settlement_atomic_transaction_failed"],
    ["reconcileOwnerPaidSettlementEffects","settlement_postcommit_effects_failed"],
    ["recordTaxTransaction","settlement_tax_effects_failed"],
    ["recordPromotionAttribution","settlement_promotion_effects_failed"],
    ["verifiedPayment","settlement_provider_verification_failed"],
    ["executeOwnerPaidSettlement","settlement_owner_execution_failed"]
  ] as const) {
    if(stack.includes(frame))return code;
  }
  if(error.name==="TypeError")return "settlement_type_error";
  if(error.name==="RangeError")return "settlement_range_error";
  return "unclassified_failure";
}

// Bound propagation to fixed codes; never echo raw owner header text or database identifiers.
const forwardableSettlementCodes=new Set([
  "invalid_owner_settlement_command","internal_order_has_stripe_identity",
  "owner_stripe_verifier_unavailable","owner_stripe_redirect_forbidden",
  "owner_stripe_credential_rejected","owner_stripe_permission_denied","owner_stripe_payment_not_found",
  "owner_stripe_verification_rate_limited","owner_stripe_verification_request_rejected","owner_stripe_verification_failed",
  "owner_stripe_receipt_too_large","owner_stripe_order_scope_mismatch","owner_stripe_charge_not_settleable",
  "owner_stripe_fee_pending","owner_stripe_fee_not_available",
  "owner_settlement_already_executing","owner_settlement_order_withdrawn","owner_settlement_order_scope_invalid",
  "owner_settlement_line_inventory_invalid","owner_settlement_acquired_rights_changed",
  "owner_settlement_identity_collision","owner_settlement_publication_incomplete",
  "settlement_order_not_found","settlement_tender_mismatch","settlement_receipt_conflict",
  "settlement_terminal_order","settlement_buyer_identity_invalid","settlement_amount_mismatch",
  "settlement_line_inventory_invalid","settlement_reservation_mismatch","settlement_product_unavailable",
  "settlement_preorder_plan_invalid","settlement_fee_evidence_missing","settlement_journal_unbalanced",
  "settlement_commit_unacknowledged","settlement_effects_receipt_missing","settlement_revoked_during_recovery",
  "qa_expected_effect_interruption","settlement_royalty_contract_missing","settlement_royalty_splits_missing",
  "settlement_royalty_splits_invalid","database_parameter_limit","database_check_rejected",
  "database_foreign_key_rejected","database_duplicate_rejected","database_required_value_missing",
  "database_execution_failed","settlement_royalty_calculation_failed","settlement_royalty_accrual_failed",
  "settlement_atomic_transaction_failed","settlement_postcommit_effects_failed","settlement_tax_effects_failed",
  "settlement_promotion_effects_failed","settlement_provider_verification_failed","settlement_owner_execution_failed",
  "settlement_type_error","settlement_range_error",
  ...["owner_authority_gate","canonical_order_read","canonical_lines_read","initial_rights_check",
    "stripe_payment_verification","verified_rights_recheck","durable_owner_command",
    "atomic_canonical_transaction","postcommit_effects","effects_receipt","owner_permission_publication",
    "publication_receipt"].map(phase=>"owner_settlement_phase_"+phase),
]);
export function safeForwardedSettlementCode(value:string|null):string {
  if(value&&forwardableSettlementCodes.has(value))return value;
  if(value?.startsWith("missing_table:"))return "database_missing_table";
  if(value?.startsWith("missing_column:"))return "database_missing_column";
  return "unclassified_failure";
}
