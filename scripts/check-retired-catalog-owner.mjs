/* eslint-disable prettier/prettier -- Source-bound private-catalog audit and negative release controls. */
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {createHash} from "node:crypto";
import ts from "typescript";
const read=p=>readFileSync(p,"utf8");
const catalog=read("src/features/fore/catalog-model.server.ts"),api=read("src/features/fore/api.server.ts");
const owner=read("src/storefront-strangler/legal-authority.worker.ts"),gateway=read("src/storefront-strangler/canonical-owner-command-gateway.ts");
const routing=read("src/storefront-strangler/publication-owner-routing.server.ts");
const audit=JSON.parse(read("docs/architecture/canonical-writer-review.json"));
const lineage=JSON.parse(read("docs/architecture/retired-catalog-owner-lineage.json"));
assert.equal(audit.releaseApproval,false);
assert.ok(audit.sites.filter(x=>x.disposition==="owner-command-required").length<=260,
  "A later audited retirement may reduce, but never increase, this previously certified source count");
assert.equal(audit.sites.filter(x=>x.file==="src/features/fore/catalog-model.server.ts").length,0);
assert.ok(audit.sites.filter(x=>x.file==="src/features/fore/api.server.ts"&&x.disposition==="owner-command-required").length<=33,"Retired catalog writers must not reappear");
assert.equal(lineage.retired.length,21);
assert.equal(lineage.productionReleaseEligible,false);
for(const row of lineage.retired)
  assert.ok(!audit.sites.some(x=>x.siteId===row.siteId),"Previously shared catalog SQL remains in active inventory");
for(const symbol of ["commercialCatalogStatements","personalImportStatements"])
  assert.ok(!catalog.includes(symbol),"Public catalog model still contains direct writer: "+symbol);
assert.ok(!api.includes("commercialCatalogStatements")&&!api.includes("personalImportStatements"));
assert.equal(api.split("dispatchCatalogFreeNormalization(db,").length-1,7);
assert.equal(api.split("dispatchCatalogPersonalImport(db,").length-1,1);
assert.match(owner,/if \(!qaOwnerLeaseLive\(env\)\)/);
assert.match(owner,/source\.epub_status!=="completed"/);
assert.match(owner,/source\.commercial_use_status!=="approved"/);
assert.match(owner,/source\.copyright!==0/);
assert.match(owner,/SELECT id FROM gutenberg_rights_evidence/);
assert.match(owner,/q\.objectKey!==\`uploads\//);
assert.match(owner,/SELECT user_id FROM personal_imports WHERE id=\?/);
assert.match(gateway,/"catalog\.normalize-gutenberg":\{path:"\/catalog\/normalize-gutenberg"/);
assert.match(gateway,/"catalog\.personal-import":\{path:"\/catalog\/personal-import"/);
assert.match(routing,/if\(!context\)throw new ApiError\(503,"Catalog normalization requires private authority\."\)/);
assert.match(routing,/if\(!context\)throw new ApiError\(503,"Personal imports require private catalog authority\."\)/);
const node=ts.createSourceFile("owner.ts",owner,ts.ScriptTarget.Latest,true);
assert.equal(node.parseDiagnostics.length,0);
const begin=owner.indexOf("function commercialCatalogStatements(");
const end=owner.indexOf("export class CoveLegalAuthority",begin);
assert.ok(begin>0&&end>begin);
const moved=new Set();
function visit(n){
  if(n.getStart(node)>=begin&&n.end<=end&&
    (ts.isStringLiteral(n)||ts.isNoSubstitutionTemplateLiteral(n)||ts.isTemplateExpression(n)))
      moved.add(createHash("sha256").update(n.getText(node)).digest("hex"));
  ts.forEachChild(n,visit);
}
visit(node);
for(const row of lineage.retired)
  assert.ok(moved.has(row.sqlSha256),"Former SQL literal not preserved inside canonical owner: "+row.functionName+" "+row.table);
console.log("PASS: 21 source-exact catalog SQL writers only in QA legal-owner; no more than 260 remain; production denied.");
