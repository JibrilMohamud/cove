/* eslint-disable prettier/prettier -- Fail-closed paid QA config migration tests. */
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {test} from "node:test";
import {bindPaidQaTemplateToIsolatedPrimary,ISOLATED_QA_PAID_NAME} from "./paid-qa-template-binding.mjs";
import {QA_PAID_D1,PRODUCTION_D1} from "./paid-qa-cloudflare-credentials.mjs";
const exampleFiles=[
  "wrangler.legal-paid-authority.example.jsonc",
  "wrangler.legal-paid-writer.example.jsonc",
  "wrangler.legal-paid-settlement-stage-qa.example.jsonc",
];
const read=path=>JSON.parse(readFileSync(path,"utf8"));
const marker=config=>["COVE_RIGHTS_OWNER_PRIMARY_ID","COVE_LEGAL_WRITER_PRIMARY_ID"]
  .find(key=>Object.hasOwn(config.vars||{},key));

for(const file of exampleFiles)test(file+" rebinding is isolated and nonauthorizing",()=>{
  const original=read(file);
  const untouched=structuredClone(original);
  const qa=bindPaidQaTemplateToIsolatedPrimary(original);
  assert.deepEqual(original,untouched,"Never mutate shared historical templates");
  assert.equal(qa.workers_dev,false);
  assert.equal(qa.preview_urls,false);
  assert.deepEqual(qa.routes,[]);
  assert.equal(qa.d1_databases.length,1);
  assert.deepEqual(qa.d1_databases,[{
    binding:"PRIMARY_DB",database_name:ISOLATED_QA_PAID_NAME,database_id:QA_PAID_D1
  }]);
  assert.equal(qa.vars[marker(qa)],QA_PAID_D1);
  assert.equal(qa.vars.COVE_RIGHTS_OWNER_ENABLED??"0","0");
  assert.notEqual(qa.d1_databases[0].database_id,PRODUCTION_D1);
  assert.ok(!JSON.stringify(qa).includes(PRODUCTION_D1));
});

test("never rebind unknown or production D1, mismatched owner marker or additional binds",()=>{
  const original=read(exampleFiles[0]);
  const unsafe=[
    {d1_databases:[{...original.d1_databases[0],database_id:PRODUCTION_D1}]},
    {d1_databases:[{...original.d1_databases[0],database_id:QA_PAID_D1}]},
    {d1_databases:[{...original.d1_databases[0],database_name:"cove-production"}]},
    {d1_databases:[original.d1_databases[0],{binding:"OTHER_DB",database_id:PRODUCTION_D1}]},
    {vars:{...original.vars,COVE_RIGHTS_OWNER_PRIMARY_ID:PRODUCTION_D1}},
    {vars:{...original.vars,COVE_RIGHTS_OWNER_PRIMARY_ID:QA_PAID_D1}},
    {vars:{COVE_RIGHTS_OWNER_ENABLED:"0"}},
    {vars:{...original.vars,COVE_LEGAL_WRITER_PRIMARY_ID:original.d1_databases[0].database_id}},
    {workers_dev:true},
    {preview_urls:true},
    {routes:["example.com/*"]},
    {triggers:{crons:["* * * * *"]}},
  ];
  for(const change of unsafe)
    assert.throws(()=>bindPaidQaTemplateToIsolatedPrimary({...original,...change}),
      "Unexpected unsafe paid QA template was accepted: "+JSON.stringify(change));
});
