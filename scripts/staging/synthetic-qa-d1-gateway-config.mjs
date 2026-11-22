/* eslint-disable prettier/prettier -- Fixed synthetic D1 bindings only. No runtime-selected primary databases. */
import assert from "node:assert/strict";
import {QA_PAID_D1,QA_SCHEMA_SOURCE_D1,PRODUCTION_D1} from "./paid-qa-cloudflare-credentials.mjs";
const LEGAL_QA_DB="5e3a6b69-6f3d-4b19-b837-01f7aa56ce87";
export function syntheticD1GatewayConfig(mode,run,expires) {
  assert.ok(mode==="paid"||mode==="legal");
  assert.match(run,/^\d{8,15}(?:-\d{1,5})?$/);
  assert.ok(Number.isSafeInteger(expires)&&expires>Date.now()&&expires-Date.now()<=45*60_000);
  const bindings=mode==="paid"?[
    {binding:"QA_PRIMARY_DB",database_name:"cove-paid-commerce-legal-qa-20261027",database_id:QA_PAID_D1},
    {binding:"QA_SCHEMA_DB",database_name:"cove-perf-isolated-candidate-20261019",database_id:QA_SCHEMA_SOURCE_D1},
  ]:[{binding:"QA_PRIMARY_DB",database_name:"cove-canonical-publication-qa-20261025",database_id:LEGAL_QA_DB}];
  assert.ok(bindings.every(b=>b.database_id!==PRODUCTION_D1));
  return {name:(mode==="paid"?"cove-paid-d1-gateway-":"cove-legal-d1-gateway-")+run,
    main:"scripts/staging/synthetic-qa-d1-gateway.worker.mjs",
    compatibility_date:"2026-10-25",workers_dev:true,preview_urls:false,routes:[],
    d1_databases:bindings,
    vars:{COVE_QA_D1_GATE_ALLOWED:mode,COVE_QA_D1_GATE_EXPIRES_AT:String(expires)}};
}
