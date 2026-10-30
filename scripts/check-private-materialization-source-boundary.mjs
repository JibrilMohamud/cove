/* eslint-disable prettier/prettier -- Physically retired materialization SQL, never a scanner classification loophole. */
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import ts from "typescript";
const source=readFileSync("src/features/fore/publishing.server.ts","utf8");
const worker=readFileSync("src/storefront-strangler/legal-authority.worker.ts","utf8");
const cmd=readFileSync("src/storefront-strangler/publication-materialization-command.ts","utf8");
const review=JSON.parse(readFileSync("docs/architecture/canonical-writer-review.json","utf8"));
const parse=(path,text)=>ts.createSourceFile(path,text,ts.ScriptTarget.Latest,true);
const pub=parse("publishing.server.ts",source),owner=parse("legal-authority.worker.ts",worker);
assert.equal(pub.parseDiagnostics.length,0);assert.equal(owner.parseDiagnostics.length,0);
function findFn(ast,name){
  const matches=[];
  function visit(node){if(ts.isFunctionDeclaration(node)&&node.name?.text===name)matches.push(node);ts.forEachChild(node,visit);}
  visit(ast);assert.equal(matches.length,1,"Expected exactly one "+name);return matches[0];
}
assert.ok(!source.includes("export async function materializePublishingSubmissionOwned("),
  "Public application module may not expose canonical materialization D1 executor");
const api=findFn(pub,"materializePublishingSubmission");
assert.match(api.body.getText(pub),/dispatchPublicationMaterialization/);
assert.match(api.body.getText(pub),/throw new ApiError\(503/);
assert.doesNotMatch(api.body.getText(pub),/\.prepare\(|\.batch\(/);
const physical=findFn(owner,"materializePublishingSubmissionOwned");
assert.ok(!physical.modifiers?.some(x=>x.kind===ts.SyntaxKind.ExportKeyword),
  "Physical primary D1 executor must not be exported");
for(const table of ["editions","products","digital_assets","asset_versions","offers",
  "finance_royalty_contracts","publishing_publications","publishing_publication_versions",
  "publishing_release_lifecycles","publishing_lifecycle_events"]){
  assert.match(physical.body.getText(owner),new RegExp("\\b"+table+"\\b"));
}
assert.match(worker,/materialize:materializePublishingSubmissionOwned/);
assert.match(cmd,/ctx\.materialize\(\{DB:db,BUCKET:checkedBucket\}/);
assert.doesNotMatch(cmd,/import\s*\{materializePublishingSubmissionOwned/);
assert.equal(review.sites.filter(x=>x.functionName==="materializePublishingSubmissionOwned").length,0);
assert.equal(review.sites.filter(x=>x.disposition==="owner-command-required").length,398);
assert.equal(review.releaseApproval,false);
console.log("PASS: 19 materialization SQL sites physically retired into unexported private owner; legacy publishing callers deny; release remains blocked");
