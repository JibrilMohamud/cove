/* eslint-disable prettier/prettier -- Physical owner-only publishing writer boundary, no statement reclassification. */
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import ts from "typescript";
const read=path=>readFileSync(path,"utf8");
const source=read("src/features/fore/publishing.server.ts");
const owner=read("src/storefront-strangler/legal-authority.worker.ts");
const preorder=read("src/storefront-strangler/publication-preorder-command.ts");
const review=JSON.parse(read("docs/architecture/canonical-writer-review.json"));
const parse=(name,text)=>ts.createSourceFile(name,text,ts.ScriptTarget.Latest,true);
const pub=parse("publishing.server.ts",source),w=parse("legal-authority.worker.ts",owner);
for(const ast of [pub,w])assert.equal(ast.parseDiagnostics.length,0,"Sources must parse");
const findFn=(ast,name)=>{
  const found=[];function visit(node){if(ts.isFunctionDeclaration(node)&&node.name?.text===name)found.push(node);ts.forEachChild(node,visit);}
  visit(ast);assert.equal(found.length,1,"Exactly one physical definition of "+name);return found[0];
};
const functions=["activatePublicationCommercialTerms","activatePublicationVersionOwned",
  "openPublicationPreorderOwned","syncCatalogAccessibility"];
for(const name of functions){
  const physical=findFn(w,name);
  assert.ok(!physical.modifiers?.some(m=>m.kind===ts.SyntaxKind.ExportKeyword),
    "Private owner primary mutation may not be exported: "+name);
  const body=physical.body?.getText(w)||"";
  assert.match(body,/\.prepare\(/,"Private owner must execute actual canonical D1 SQL");
  if(name==="syncCatalogAccessibility"){
    assert.equal(source.includes("function syncCatalogAccessibility("),false,
      "There must be no shared accessibility-synchronization D1 writer");
  }else{
    const stub=findFn(pub,name),stubBody=stub.body?.getText(pub)||"";
    assert.match(stubBody,/throw new ApiError\(503/,"Unenrolled legacy callers must fail closed");
    assert.doesNotMatch(stubBody,/\.prepare\(|\.batch\(/,"Legacy stub must never write");
  }
  assert.equal(review.sites.filter(x=>x.file==="src/features/fore/publishing.server.ts"&&x.functionName===name).length,0,
    "No retired SQL site may remain outside owner: "+name);
}
const terms=findFn(w,"activatePublicationCommercialTerms").body.getText(w);
for(const table of ["rights_grants","rights_contracts","offers","finance_royalty_contracts"])
  assert.match(terms,new RegExp(table));
assert.match(owner,/openPreorder:openPublicationPreorderOwned/,
  "The preorder command must receive a private writer in the owner only");
assert.match(preorder,/context\.openPreorder\(primary,input\.publicationVersionId\)/);
assert.doesNotMatch(preorder,/import\s*\{openPublicationPreorderOwned/);
assert.equal(review.sites.filter(x=>x.disposition==="owner-command-required").length,380);
assert.equal(review.releaseApproval,false,"Never self-certify production owner release");
console.log("PASS: 18 publication activation, rights terms, preorder and accessibility SQL sites retired into unexported private owner; legacy writes fail closed");
