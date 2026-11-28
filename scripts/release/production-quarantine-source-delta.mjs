import assert from "node:assert/strict";

const hooks = `  protected productionMaintenanceAdmission():boolean{
    return productionPersistenceEnrolled(this.env as LegalAuthorityEnv&ProductionPersistenceEnv);
  }

  /** Default admission is unchanged: only the existing short-lived QA lease. */
  protected async ownerRuntimeAdmission(_request:Request):Promise<boolean>{
    return qaOwnerLeaseLive(this.env);
  }

`;
export function reverseProductionQuarantineDelta(source) {
  assert.equal(source.split(hooks).length, 2, "Exact production admission hooks drifted");
  const admission = "    if (!await this.ownerRuntimeAdmission(request))\n";
  assert.equal(source.split(admission).length, 2, "Exact runtime admission dispatch drifted");
  const maintenance = "if(!this.productionMaintenanceAdmission()||";
  assert.equal(
    source.split(maintenance).length,
    3,
    "Both metadata and scheduled admission must remain exact",
  );
  return source
    .replace(hooks, "")
    .replace(admission, "    if (!qaOwnerLeaseLive(env))\n")
    .replaceAll(maintenance, "if(!productionPersistenceEnrolled(env)||");
}

export function reverseProductionQuarantineCommerceDelta(source) {
  const addition =
    'import { hasProductionQuarantineBusinessDb } from "../../storefront-strangler/production-quarantine-owner";\n';
  assert.equal(source.split(addition).length, 2);
  source = source.replace(addition, "");
  const denied =
    'env.COVE_LEGAL_CONSUMER_STAGE_ENABLED !== "1" && !hasProductionQuarantineBusinessDb(env.DB)';
  assert.equal(
    source.split(denied).length,
    4,
    "Only the three original refund admission guards change",
  );
  source = source.replaceAll(denied, 'env.COVE_LEGAL_CONSUMER_STAGE_ENABLED !== "1"');
  const dispatch =
    'if (env.COVE_LEGAL_CONSUMER_STAGE_ENABLED === "1" || hasProductionQuarantineBusinessDb(env.DB)) {';
  assert.equal(source.split(dispatch).length, 2, "Only refund dispatch changes");
  source = source.replace(dispatch, 'if (env.COVE_LEGAL_CONSUMER_STAGE_ENABLED === "1") {');
  const denial = `  if (
    full ||
    env.COVE_LEGAL_CONSUMER_STAGE_ENABLED === "1" ||
    hasProductionQuarantineBusinessDb(env.DB)
  )`;
  assert.equal(source.split(denial).length, 2, "Only refund denial check changes");
  return source.replace(denial, '  if (full || env.COVE_LEGAL_CONSUMER_STAGE_ENABLED === "1")');
}
