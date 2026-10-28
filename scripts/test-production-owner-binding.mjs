/* eslint-disable prettier/prettier -- Exact production resource identity is a release boundary. */
import assert from "node:assert/strict";
import {verifyProductionOwnerBinding,PRODUCTION_D1,PRODUCTION_OWNER_NAMESPACE,PRODUCTION_OWNER_SCRIPT} from "./check-production-owner-binding.mjs";
const owner={bindings:[
  {name:"PRIMARY_DB",type:"d1",id:PRODUCTION_D1},
  {name:"LEGAL_AUTHORITY",type:"durable_object_namespace",namespace_id:PRODUCTION_OWNER_NAMESPACE},
  {name:"COVE_RIGHTS_OWNER_ENABLED",type:"plain_text",text:"0"},
  {name:"COVE_RIGHTS_OWNER_PRIMARY_ID",type:"plain_text",text:PRODUCTION_D1},
  {name:"COVE_RIGHTS_OWNER_SECRET",type:"secret_text"}
]};
const backend={bindings:[{name:"DB",type:"d1",id:PRODUCTION_D1},
  {name:"LEGAL_AUTHORITY",type:"durable_object_namespace",namespace_id:PRODUCTION_OWNER_NAMESPACE,
    class_name:"CoveLegalAuthority",script_name:PRODUCTION_OWNER_SCRIPT},
  {name:"COVE_RIGHTS_OWNER_SECRET",type:"secret_text"}]};
assert.equal(verifyProductionOwnerBinding(owner,backend),true);
for(const [name,changes] of [
  ["PRIMARY_DB",{id:"7c7ab994-f6b3-419d-a72d-71eb9ea22e7e"}],
  ["LEGAL_AUTHORITY",{namespace_id:"qa-namespace"}],
  ["COVE_RIGHTS_OWNER_ENABLED",{text:"1"}],
  ["COVE_RIGHTS_OWNER_PRIMARY_ID",{text:"wrong-primary"}],
  ["COVE_RIGHTS_OWNER_SECRET",{type:"plain_text",text:"exposed"}]
])assert.throws(()=>verifyProductionOwnerBinding({bindings:owner.bindings.map(b=>b.name===name?{...b,...changes}:b)},backend));
for(const changes of [{namespace_id:"qa-namespace"},{script_name:"cove-legal-authority-private-qa-example"},
  {class_name:"DifferentClass"},{type:"service"}])
  assert.throws(()=>verifyProductionOwnerBinding(owner,{bindings:backend.bindings.map(b=>b.name==="LEGAL_AUTHORITY"?{...b,...changes}:b)}));
assert.throws(()=>verifyProductionOwnerBinding(owner,{bindings:[backend.bindings[0]]}));
assert.throws(()=>verifyProductionOwnerBinding({...owner,bindings:owner.bindings.filter(b=>b.name!=="COVE_RIGHTS_OWNER_SECRET")},backend));
assert.throws(()=>verifyProductionOwnerBinding(owner,{...backend,bindings:backend.bindings.filter(b=>b.name!=="COVE_RIGHTS_OWNER_SECRET")}));
assert.throws(()=>verifyProductionOwnerBinding(owner,{...backend,bindings:backend.bindings.map(b=>b.name==="COVE_RIGHTS_OWNER_SECRET"?{...b,type:"plain_text",text:"exposed"}:b)}));
console.log("PASS: rejects missing/exposed private credentials, QA resources, wrong class/owner/primary and prematurely enabled production bindings");
