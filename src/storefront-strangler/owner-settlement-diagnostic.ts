/* eslint-disable prettier/prettier -- Private QA diagnostics never include SQL, credentials, provider bodies or buyer data. */
export function ownerSettlementDiagnostic(error:unknown):string {
  if(!(error instanceof Error))return "unclassified_failure";
  const message=error.message;
  // These are fixed internal verifier codes, not arbitrary exception text.
  if(/^(?:owner_(?:stripe|settlement)_[a-z_]+|invalid_owner_settlement_command|internal_order_has_stripe_identity)$/.test(message))return message;
  const missing=message.match(/no such (table|column):\s*([a-z_][a-z0-9_.]*)/i);
  if(missing)return "missing_"+missing[1].toLowerCase()+":"+missing[2].toLowerCase().slice(0,100);
  if(/too many SQL variables/i.test(message))return "database_parameter_limit";
  if(/CHECK constraint failed/i.test(message))return "database_check_rejected";
  if(/FOREIGN KEY constraint failed/i.test(message))return "database_foreign_key_rejected";
  if(/UNIQUE constraint failed/i.test(message))return "database_duplicate_rejected";
  if(/NOT NULL constraint failed/i.test(message))return "database_required_value_missing";
  if(/D1_ERROR|SQLITE_ERROR/.test(message))return "database_execution_failed";
  return "unclassified_failure";
}
