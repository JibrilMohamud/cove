import assert from "node:assert/strict";
import {test} from "node:test";
import {readFileSync,mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {pathToFileURL} from "node:url";
import {build} from "esbuild";
import {serveQaOwnerPrimaryRead} from "../src/storefront-strangler/qa-owner-primary-read-transport.mjs";

const folder=mkdtempSync(join(tmpdir(),"cove-unbound-owner-read-"));
let module;
try {
  const outfile=join(folder,"qa-read-entrypoint.mjs");
  await build({entryPoints:["src/storefront-strangler/qa-owner-primary-read-entrypoint.ts"],
    outfile,bundle:true,platform:"node",format:"esm",target:"node22",logLevel:"silent"});
  module=await import(pathToFileURL(outfile).href);
} finally {rmSync(folder,{force:true,recursive:true});}
const {scopeQaOwnerUnboundPrimaryRead}=module;
const SECRET="a".repeat(64);
const QA_PRIMARY="969f1ea0-5f57-4f3a-aa25-9c74e58f5af3";
const PROD_PRIMARY="4bd657ac-8789-403e-a28c-93aba8d0a989";
function fakeD1() {
  return {
    prepare(sql) {
      return {
        bind(...params) {
          return {
            async first() {return {ok:1,sql,params};},
            async all() {return {success:true,results:[{ok:1,sql,params}]};},
          };
        }
      };
    },
    async batch(items) {return Promise.all(items.map(x=>x.all()));},
  };
}
function qaEnv(overrides={}) {
  const owner={
    async fetch(request) {
      return serveQaOwnerPrimaryRead(request,fakeD1(),SECRET,true);
    }
  };
  return {
    COVE_QA_OWNER_UNBOUND_READ_ENABLED:"1",
    COVE_SSR_STAGING:"1",
    FORE_ENVIRONMENT:"staging",
    COVE_RIGHTS_OWNER_ENABLED:"1",
    COVE_RIGHTS_OWNER_PRIMARY_ID:QA_PRIMARY,
    COVE_RIGHTS_OWNER_TEST_EXPIRES_AT:String(Date.now()+60_000),
    COVE_RIGHTS_OWNER_SECRET:SECRET,
    LEGAL_AUTHORITY:{getByName(name){
      assert.equal(name,"cove-staged-legal-global-v1");return owner;
    }},
    ...overrides,
  };
}
test("without any D1 binding a signed, QA-only backend performs catalog SELECT via legal owner",async()=>{
  const original=qaEnv();
  assert.equal(Object.hasOwn(original,"DB"),false);
  const x=scopeQaOwnerUnboundPrimaryRead(original);
  assert.notEqual(x,original);
  assert.equal((await x.DB.prepare("SELECT id FROM products WHERE id=?").bind("prd_7").first()).ok,1);
  assert.equal((await x.DB.prepare("SELECT id FROM products").all()).results.length,1);
  assert.equal((await x.DB.batch([
    x.DB.prepare("SELECT 1"),x.DB.prepare("SELECT 2")
  ])).length,2);
  assert.throws(()=>x.DB.prepare("UPDATE qa_probe_rows SET id='x'"),/qa_owner_read_denied/);
  assert.throws(()=>x.DB.withSession("first-primary"),/qa_owner_read_denied/);
  assert.equal(Object.hasOwn(x,"PRIMARY_DB"),false);
});
test("absence of a QA flag is a strict no-op, including the real legacy native DB",()=>{
  const real={DB:fakeD1(),COVE_QA_OWNER_UNBOUND_READ_ENABLED:"0"};
  assert.equal(scopeQaOwnerUnboundPrimaryRead(real),real);
  const unset={DB:real.DB};
  assert.equal(scopeQaOwnerUnboundPrimaryRead(unset),unset);
});
test("QA reader fails shut on any direct D1, prod account, missing legal lease or co-enabled mutation fence",()=>{
  const cases=[
    {DB:fakeD1()},
    {FORE_ENVIRONMENT:"production"},
    {COVE_SSR_STAGING:"0"},
    {COVE_RIGHTS_OWNER_ENABLED:"0"},
    {COVE_RIGHTS_OWNER_PRIMARY_ID:PROD_PRIMARY},
    {COVE_RIGHTS_OWNER_PRIMARY_ID:"4e17ba6f-444f-4245-801a-a7d4969045b0"},
    {COVE_RIGHTS_OWNER_PRIMARY_ID:"arbitrary-qa-primary"},
    {COVE_RIGHTS_OWNER_TEST_EXPIRES_AT:String(Date.now()-1)},
    {COVE_RIGHTS_OWNER_TEST_EXPIRES_AT:String(Date.now()+30*60*1000)},
    {COVE_RIGHTS_OWNER_SECRET:"malformed"},
    {LEGAL_AUTHORITY:null},
    {COVE_PUBLICATION_COMMANDS_ENABLED:"1"},
    {COVE_OWNER_EXCLUSIVE_WRITER_FENCE:"1"},
    {COVE_COMMERCE_OWNER_D1_FENCE:"1"},
    {COVE_QA_OWNER_UNBOUND_READ_ENABLED:"yes"},
  ];
  for(const bad of cases)
    assert.throws(()=>scopeQaOwnerUnboundPrimaryRead(qaEnv(bad)),
      /qa_unbound_primary_read_not_certified/,"accepted "+JSON.stringify(Object.keys(bad)));
});
test("the backend still scopes both cron and HTTP, while production D1 and owner lock stay intact",()=>{
  const backend=readFileSync("src/persistence-backend.worker.ts","utf8");
  const config=readFileSync("wrangler.backend.production.toml","utf8");
  const owner=readFileSync("src/storefront-strangler/legal-authority.worker.ts","utf8");
  assert.equal(backend.split("scopeQaOwnerUnboundPrimaryRead(env)").length-1,2);
  assert.equal(backend.split("scopeExclusiveCanonicalD1(scopePublicationOwnerEnv(env))").length-1,2);
  assert.match(config,/binding = "DB"/);
  assert.match(config,/database_id = "4bd657ac-8789-403e-a28c-93aba8d0a989"/);
  assert.match(owner,/if\s*\(!qaOwnerLeaseLive\(env\)\)/);
  assert.match(owner,/QA_OWNER_PRIMARY_READ_ROUTE/);
  assert.match(owner,/env.COVE_RIGHTS_OWNER_PRIMARY_ID===BIOSYNC_QA_PRIMARY/);
  assert.match(owner,/serveQaOwnerPrimaryRead\(request,env.PRIMARY_DB,/);
});
console.log("PASS: no-native-D1 QA backend read seam denies production and preserves existing customer and cron bindings");
