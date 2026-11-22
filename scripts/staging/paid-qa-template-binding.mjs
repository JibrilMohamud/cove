/* eslint-disable prettier/prettier -- Exact legacy QA template-to-isolated-account D1 rebinding. */
import assert from "node:assert/strict";
import {QA_PAID_D1,PRODUCTION_D1} from "./paid-qa-cloudflare-credentials.mjs";

const LEGACY_QA_PAID_D1="7c7ab994-f6b3-419d-a72d-71eb9ea22e7e";
const LEGACY_QA_PAID_NAME="cove-paid-commerce-legal-qa-20261027";
export const ISOLATED_QA_PAID_NAME="cove-qa-paid-owner-primary-20261122";

/**
 * A protected QA run uses historical, disabled example configs as templates,
 * but MUST only deploy private synthetic Workers bound to the separate
 * November Cove QA account/D1. Never rebind a production or unknown database.
 * The original templates are not edited or deployed directly.
 */
export function bindPaidQaTemplateToIsolatedPrimary(config){
  assert.ok(config && typeof config==="object");
  assert.equal(config.workers_dev,false,"Paid QA template must initially be private");
  assert.equal(config.preview_urls,false,"Paid QA template must not expose preview URLs");
  assert.deepEqual(config.routes,[],"Paid QA template must not expose a public route");
  assert.equal(config.d1_databases?.length,1,"Paid QA template must bind one exact D1");
  assert.equal(config.triggers,undefined,"Paid QA template must not schedule jobs");
  const db=config.d1_databases[0];
  assert.equal(db.binding,"PRIMARY_DB");
  assert.equal(db.database_id,LEGACY_QA_PAID_D1,
    "Unexpected legacy template database; never silently rebind production D1");
  assert.equal(db.database_name,LEGACY_QA_PAID_NAME);
  assert.notEqual(db.database_id,PRODUCTION_D1);
  const keys=["COVE_RIGHTS_OWNER_PRIMARY_ID","COVE_LEGAL_WRITER_PRIMARY_ID"]
    .filter(k=>Object.hasOwn(config.vars||{},k));
  assert.equal(keys.length,1,"Expected one exact owner/writer D1 identity marker");
  assert.equal(config.vars[keys[0]],LEGACY_QA_PAID_D1,
    "Owner/writer identity does not match the template D1");
  assert.notEqual(QA_PAID_D1,PRODUCTION_D1);
  return {
    ...config,
    d1_databases:[{...db,database_name:ISOLATED_QA_PAID_NAME,database_id:QA_PAID_D1}],
    vars:{...config.vars,[keys[0]]:QA_PAID_D1},
  };
}
