/* eslint-disable prettier/prettier -- Protected, explicit read-only production catalog staging audit. */
/** NO production mutations, money operations, export files, or legal grants. */
import {createD1Reader,PRODUCTION_ACCOUNT,verifyProductionMetadata}
  from '../../src/storefront-strangler/production-catalog-metadata-readonly.stage.mjs';

async function main(){
  if(process.argv.length!==3||process.argv[2]!=='--live')
    throw Error('readonly_metadata_audit_requires_explicit_live_opt_in');
  if(process.env.CF_ACCOUNT_ID!==PRODUCTION_ACCOUNT)
    throw Error('readonly_metadata_audit_wrong_account');
  if(process.env.GITHUB_ACTIONS==='true' && (
    process.env.GITHUB_EVENT_NAME!=='workflow_dispatch'||
    process.env.GITHUB_REF!==
      'refs/heads/audit/stage-real-catalog-metadata-readonly-20261115'))
    throw Error('readonly_metadata_audit_unprotected_workflow_event');
  const reader=createD1Reader({token:process.env.COVE_CF_PRODUCTION_AUDIT_READ_TOKEN});
  const checked=await verifyProductionMetadata({read:reader,batchSize:250,
    onProgress:progress=>console.log(JSON.stringify({
      event:'cove_readonly_catalog_scan_progress',...progress,
      releaseCertified:false,
    }))});
  console.log(JSON.stringify({event:'cove_readonly_catalog_metadata_audit',...checked}));
  if(checked.productionOwnerEvidence!==false||checked.releaseCertified!==false)
    throw Error('readonly_metadata_audit_must_never_certify_production_rights');
}
main().catch(error=>{
  // Known fixed error class only; never log auth, query rows or user data.
  const name=String(error?.message||'unknown');
  console.error(JSON.stringify({event:'cove_readonly_catalog_audit_failed',
    reason:/^catalog_readonly_[a-z_0-9]+$/.test(name)?name:
      'readonly_metadata_audit_unavailable',releaseCertified:false}));
  process.exitCode=1;
});