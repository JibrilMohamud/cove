/* eslint-disable prettier/prettier -- Execution proof for customer gateway disabled and DB-less configuration. */
import assert from "node:assert/strict";
import {readFileSync,mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {pathToFileURL} from "node:url";
import {build} from "esbuild";

const config=JSON.parse(readFileSync("wrangler.storefront-strangler.customer.jsonc","utf8"));
assert.equal(config.name,"cove-fast-customer-gateway");
assert.equal(config.vars.COVE_STRANGLER_MODE,"customer-gateway");
assert.equal(config.vars.COVE_STRANGLER_RELEASE_CERTIFIED,"0");
assert.equal(config.vars.COVE_STRANGLER_DATABASE_ID,undefined);
assert.equal(config.d1_databases,undefined);
assert.equal(config.workers_dev,true);
assert.equal(config.preview_urls,false);
assert.ok(!config.routes&&!config.route&&!config.triggers&&!config.queues);
const dir=mkdtempSync(join(tmpdir(),"cove-customer-no-d1-"));
try{
  const outfile=join(dir,"worker.mjs");
  await build({entryPoints:["src/storefront-strangler/worker.ts"],
    outfile,bundle:true,platform:"node",format:"esm",target:"node22",logLevel:"silent"});
  const worker=(await import(pathToFileURL(outfile).href)).default;
  // Deliberately supply no DB, no CORE, no private content service or any
  // legal-authority binding. An uncaught access would reject the test.
  const env={...config.vars};
  for(const path of ["/","/library","/checkout","/api/fore/library",
    "/api/fore/commerce/checkout","/api/fore/publications"]){
    const result=await worker.fetch(new Request("https://cove.test"+path),env);
    assert.equal(result.status,503,path+" must fail before any missing DB access");
    assert.equal(result.headers.get("cache-control"),"no-store");
  }
  for(const mode of ["production-acceptance","customer-gateway"]){
    const candidate={...env,COVE_STRANGLER_MODE:mode,
      COVE_STRANGLER_RELEASE_CERTIFIED:"1"};
    const response=await worker.fetch(new Request("https://cove.test/"),candidate);
    assert.equal(response.status,503,"Untrusted future flag alone cannot enable gateway");
  }
  console.log("PASS: disabled customer gateway serves zero routes, needs zero D1 capabilities and cannot reactivate with a single flag");
}finally{rmSync(dir,{recursive:true,force:true});}
