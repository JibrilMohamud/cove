/* eslint-disable prettier/prettier -- Verify source retirement, immutable lineage and private runtime import boundaries. */
import assert from "node:assert/strict";
import {readFileSync,readdirSync} from "node:fs";
import {createHash} from "node:crypto";
import {build} from "esbuild";
import ts from "typescript";
const read=p=>readFileSync(p,"utf8"),sha=x=>createHash("sha256").update(x).digest("hex");
const lineage=JSON.parse(read("docs/architecture/retired-finance-royalty-owner-lineage.json"));
const review=JSON.parse(read("docs/architecture/canonical-writer-review.json"));
assert.equal(lineage.retiredCount,21);assert.equal(lineage.productionOwnerCertified,false);
assert.equal(review.releaseApproval,false);
assert.equal(review.sites.filter(x=>x.disposition==="owner-command-required").length,92);
assert.equal(new Set(lineage.retired.map(x=>x.siteId)).size,21);
for(const row of lineage.retired)assert.ok(!review.sites.some(x=>x.siteId===row.siteId));
for(const row of lineage.sources){
 const source=read(row.file);assert.equal(sha(source),row.currentSha256);
 assert.doesNotMatch(source,/\b(?:INSERT(?: OR IGNORE)? INTO|UPDATE|DELETE FROM)\s+[a-z_]/i);
 assert.match(source,/invokeFinanceOwner/);
 assert.ok(!review.sites.some(x=>x.file===row.file&&x.disposition==="owner-command-required"));
}
const owner=read("src/storefront-strangler/legal-authority.worker.ts");
assert.match(owner,/const createPrivateRoyalty=/);assert.match(owner,/const createPrivateFinance=/);
assert.match(owner,/if\(route==="\/finance\/private-action"\)/);
assert.match(owner,/if\(!principal\|\|!permissions.includes\(required\)\)/);
assert.match(owner,/prior.request_digest!==requestDigest/);
assert.match(owner,/bindPrivateFinanceExecutors\(env.PRIMARY_DB/);
assert.ok(owner.indexOf('if (!qaOwnerLeaseLive(env))')<owner.indexOf('bindPrivateFinanceExecutors(env.PRIMARY_DB'));
function walk(dir){return readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(dir+"/"+e.name):/\.[cm]?[jt]sx?$/.test(e.name)?[dir+"/"+e.name]:[]);}
let installers=0;
for(const file of walk("src")){
 const source=ts.createSourceFile(file,read(file),ts.ScriptTarget.Latest,true);
 for(const node of source.statements){
  if((ts.isImportDeclaration(node)||ts.isExportDeclaration(node))&&node.moduleSpecifier&&
    /finance-owner-routing\.server/.test(node.moduleSpecifier.text)){
   if(ts.isExportDeclaration(node))assert.ok(node.isTypeOnly,"Finance owner routing cannot be reexported");
   else if(node.importClause&&!node.importClause.isTypeOnly){
    const bindings=node.importClause.namedBindings;
    assert.ok(bindings&&ts.isNamedImports(bindings),"No namespace access to private financial installer");
    for(const binding of bindings.elements)if((binding.propertyName||binding.name).text==="bindPrivateFinanceExecutors"){
     assert.equal(file,"src/storefront-strangler/legal-authority.worker.ts");installers++;
    }
   }
  }
 }
}
assert.equal(installers,1);
const bundled=await build({entryPoints:["src/features/fore/finance.server.ts","src/features/fore/royalty-engine.server.ts"],bundle:true,
 platform:"node",format:"esm",outdir:"test-bundle",write:false,metafile:true,logLevel:"silent"});
assert.ok(!Object.keys(bundled.metafile.inputs).some(x=>x.endsWith("legal-authority.worker.ts")),"Private financial code leaked into public runtime");
for(const output of bundled.outputFiles){
 assert.doesNotMatch(output.text,/INSERT(?: OR IGNORE)? INTO (?:finance_|commerce_ledger_entries)|UPDATE finance_/i);
 assert.doesNotMatch(output.text,/function bindPrivateFinanceExecutors/);
}
console.log("PASS: 21 finance/royalty SQL sites retired; original identities retained; 92 remain; one private installer and no financial SQL in public bundles");
