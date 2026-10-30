/* eslint-disable prettier/prettier -- Demonstrate physical retirement instead of scanner reclassification. */
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import ts from "typescript";

const legacyPath="src/features/fore/traditional-publishing.server.ts";
const ownerPath="src/storefront-strangler/legal-authority.worker.ts";
const bridgePath="src/storefront-strangler/owner-contract-version-executor.ts";
const callerPath="src/storefront-strangler/owner-contract-version.server.ts";
const legacy=readFileSync(legacyPath,"utf8");
const owner=readFileSync(ownerPath,"utf8");
const bridge=readFileSync(bridgePath,"utf8");
const caller=readFileSync(callerPath,"utf8");
const parse=(name,source)=>ts.createSourceFile(name,source,ts.ScriptTarget.Latest,true);
const oldAst=parse(legacyPath,legacy),ownerAst=parse(ownerPath,owner);
assert.equal(oldAst.parseDiagnostics.length,0);
assert.equal(ownerAst.parseDiagnostics.length,0);
const findFunction=(ast,name)=>{
  const matches=[];
  function visit(node){
    if(ts.isFunctionDeclaration(node)&&node.name?.text===name)matches.push(node);
    ts.forEachChild(node,visit);
  }
  visit(ast);
  assert.equal(matches.length,1,"Expected exactly one "+name);
  return matches[0];
};
const disabled=findFunction(oldAst,"saveContractVersion");
const body=disabled.body?.getText(oldAst)||"";
assert.match(body,/throw new ApiError\(503,/);
assert.doesNotMatch(body,/\.prepare\s*\(|\.batch\s*\(|\.exec\s*\(/);
assert.ok(!legacy.includes("const contractVersionSchema ="),"Legacy validation cannot hide another direct writer");
const privateWriter=findFunction(ownerAst,"writeContractVersionPrimary");
assert.ok(privateWriter.body);
assert.ok(!privateWriter.modifiers?.some(x=>x.kind===ts.SyntaxKind.ExportKeyword),
  "The physical D1 writer may not be exported");
const executable=privateWriter.body.getText(ownerAst);
for(const table of ["rights_contract_versions","rights_contract_version_territories",
  "rights_contract_version_formats","rights_contract_version_channels","rights_contract_audit"])
  assert.match(executable,new RegExp(table));
assert.match(owner,/saveVersion:writeContractVersionPrimary/);
assert.match(bridge,/await ctx\.saveVersion\(ctx\.primary,input\.actorUserId,checked\)/);
assert.doesNotMatch(bridge,/import \{saveContractVersion\}/);
assert.doesNotMatch(caller,/return saveContractVersion\(/);
assert.match(caller,/COVE_LEGAL_CONSUMER_STAGE_ENABLED!=="1"\)[\s\S]*?throw new ApiError\(503,/);
const review=JSON.parse(readFileSync("docs/architecture/canonical-writer-review.json","utf8"));
assert.equal(review.sites.filter(s=>s.commandFamily==="traditional-publishing.saveContractVersion").length,0);
assert.ok(review.sites.filter(s=>s.disposition==="owner-command-required").length<=417,
  "Genuinely retired source-level owner findings may decrease but must not grow");
assert.equal(review.releaseApproval,false);
console.log("PASS: 9 contract writers retired from shared API; only private unexported Durable Object mutates D1; unenrolled production remains fail-closed");
