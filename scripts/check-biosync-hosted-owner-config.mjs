/* eslint-disable prettier/prettier -- Configuration proof does not activate an owner or authorize rights. */
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
const read=p=>readFileSync(p,"utf8");
const id="4e17ba6f-444f-4245-801a-a7d4969045b0";
const prod="4bd657ac-8789-403e-a28c-93aba8d0a989";
const owner=JSON.parse(read("wrangler.biosync-owner.qa.example.jsonc"));
const gateway=JSON.parse(read("wrangler.biosync-gateway.qa.example.jsonc"));
const source=read("src/storefront-strangler/legal-authority.worker.ts");
const ingress=read("infra/biosync-owner-qa-gateway.worker.ts");
for(const x of [owner,gateway]) {
  assert.equal(x.workers_dev,false);
  assert.equal(x.preview_urls,false);
  assert.deepEqual(x.routes,[]);
  assert.equal(Object.hasOwn(x,"triggers"),false);
  assert.doesNotMatch(JSON.stringify(x),new RegExp(prod));
}
assert.equal(owner.name,"cove-biosync-owner-qa-disabled");
assert.equal(owner.main,".output/strangler/legal-authority.mjs");
assert.deepEqual(owner.d1_databases,[{binding:"PRIMARY_DB",
  database_name:"cove_owner_biosync_qa_20261123",database_id:id}]);
assert.deepEqual(owner.r2_buckets,[{binding:"BUCKET",bucket_name:"cove-owner-biosync-qa"}]);
assert.deepEqual(owner.durable_objects?.bindings,[{
  name:"LEGAL_AUTHORITY",class_name:"CoveLegalAuthority"
}]);
assert.deepEqual(owner.migrations,[{
  tag:"biosync-owner-qa-v1",new_sqlite_classes:["CoveLegalAuthority"]
}]);
assert.deepEqual(owner.vars,{
  COVE_RIGHTS_OWNER_ENABLED:"0",COVE_RIGHTS_OWNER_PRIMARY_ID:id,
  COVE_RIGHTS_OWNER_TEST_EXPIRES_AT:"0"
});
assert.equal(gateway.name,"cove-biosync-gateway-qa-disabled");
assert.equal(gateway.main,".output/strangler/biosync-owner-qa-gateway.mjs");
assert.deepEqual(gateway.services,[{binding:"LEGAL_AUTHORITY",service:owner.name}]);
assert.equal(gateway.d1_databases,undefined,"Gateway never receives native D1");
assert.equal(gateway.r2_buckets,undefined,"Gateway never receives media binding");
assert.deepEqual(gateway.vars,{
  COVE_BIOSYNC_QA_GATEWAY_ENABLED:"0",COVE_BIOSYNC_QA_PRIMARY_ID:id,
  COVE_BIOSYNC_QA_GATEWAY_EXPIRES_AT:"0"
});
assert.ok(source.includes('"'+id+'"'),"Owner QA lease must admit exact new primary");
assert.ok(ingress.includes('new Set(["'+id+'"])'),
  "Gateway must admit only the BioSync QA primary, never paid QA");
assert.ok(!ingress.includes('"969f1ea0-5f57-4f3a-aa25-9c74e58f5af3"'));
assert.ok(!source.includes('"'+prod+'"'),
  "The production DB cannot enroll in synthetic owner lease");
for(const obj of [owner,gateway]){
  const all=JSON.stringify(obj);
  assert.doesNotMatch(all,/CLOUDFLARE_API_TOKEN|COVE_RIGHTS_OWNER_SECRET|COVE_BIOSYNC_QA_CLIENT_SECRET/,
    "No bearer secret may be embedded in config");
}
console.log("PASS: dedicated QA owner has isolated D1 and R2; gateway has neither. "+
  "Both workers are dark, unleased, unrouted, and require separate protected activation.");
console.log("NOT CERTIFIED: no real owner command, protected replay, scheduled operation, or production cutover.");
