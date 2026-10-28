/* eslint-disable prettier/prettier -- Exact SQL-site reconciliation is evidence, never release approval. */
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {readFileSync,mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {spawnSync} from "node:child_process";
import {pathToFileURL} from "node:url";
import ts from "typescript";

export const REVIEW_PATH="docs/architecture/canonical-writer-review.json";
const digest=text=>createHash("sha256").update(text).digest("hex");

/**
 * Attach the containing named function and EXACT source SQL fingerprint to
 * every conservative regex candidate. A matching line count is insufficient:
 * changing an existing UPDATE's columns must invalidate its previous review.
 * Unrecognized/nonliteral sites remain blocked and require manual review.
 */
export function identifyWriterSites(findings,readSource=path=>readFileSync(path,"utf8")) {
  const files=new Map(),occurrences=new Map();
  return findings.map(finding=>{
    let parsed=files.get(finding.file);
    if(!parsed) {
      const text=readSource(finding.file);
      const source=ts.createSourceFile(finding.file,text,ts.ScriptTarget.Latest,true);
      assert.equal(source.parseDiagnostics.length,0,"Unparseable writer source: "+finding.file);
      const literals=[];
      function visit(node) {
        if(ts.isStringLiteral(node)||ts.isNoSubstitutionTemplateLiteral(node)||ts.isTemplateExpression(node))
          literals.push(node);
        ts.forEachChild(node,visit);
      }
      visit(source);parsed={source,text,literals,sourceSha256:digest(text)};files.set(finding.file,parsed);
    }
    const {source,text,literals}=parsed;
    const start=source.getPositionOfLineAndCharacter(finding.line-1,0);
    const newline=text.indexOf("\n",start),end=newline<0?text.length:newline;
    const literal=literals.filter(node=>node.getStart(source)<=end&&node.end>start&&
      new RegExp("\\b"+finding.table+"\\b","i").test(node.getText(source)))
      .sort((a,b)=>(a.end-a.pos)-(b.end-b.pos))[0];
    // Repeated SQL at different locations must have independent review IDs.
    let functionName="<module>";
    for(let node=literal?.parent;node;node=node.parent) {
      if(ts.isFunctionDeclaration(node)&&node.name) {functionName=node.name.text;break;}
      if((ts.isArrowFunction(node)||ts.isFunctionExpression(node))&&
         ts.isVariableDeclaration(node.parent)&&ts.isIdentifier(node.parent.name)) {
        functionName=node.parent.name.text;break;
      }
      if(ts.isMethodDeclaration(node)&&node.name) {functionName=node.name.getText(source);break;}
    }
    const sqlSha256=digest(literal?literal.getText(source):text.slice(start,end));
    // Bind the surrounding source too. Moving a fixture onto a real D1 or
    // changing a caller/guard must invalidate review even if its SQL stays
    // unchanged. This deliberately requires re-review after writer edits.
    const identity=[finding.file,parsed.sourceSha256,functionName,finding.table,finding.operation,sqlSha256];
    const key=JSON.stringify(identity),occurrence=(occurrences.get(key)||0)+1;
    occurrences.set(key,occurrence);
    return {...finding,functionName,sqlSha256,literal:!!literal,
      siteId:digest(JSON.stringify([...identity,occurrence]))};
  });
}

export function reconcileWriterSites(sites,review) {
  assert.equal(review.schema,"cove.canonical-writer-review.v1");
  assert.equal(review.releaseApproval,false);
  assert.ok(Array.isArray(review.sites));
  const byId=new Map(review.sites.map(site=>[site.siteId,site]));
  assert.equal(byId.size,review.sites.length,"Duplicate reviewed SQL site");
  const current=new Set(sites.map(site=>site.siteId));
  const stale=review.sites.filter(site=>!current.has(site.siteId));
  const unknown=sites.filter(site=>!byId.has(site.siteId));
  const validStatuses=new Set(["owner-command-required","non-authorizing-write","isolated-test-fixture"]);
  for(const site of review.sites) {
    assert.ok(validStatuses.has(site.disposition),"Unknown review disposition");
    assert.equal(typeof site.reason,"string");assert.ok(site.reason.length>20);
    assert.equal(site.productionOwnerGuarded,false,
      "This pre-migration review cannot assert deployed production ownership");
    if(site.disposition==="owner-command-required")assert.ok(site.commandFamily);
  }
  return {unknown,stale,rows:sites.map(site=>({...site,review:byId.get(site.siteId)||null}))};
}

export function currentWriterSites() {
  const directory=mkdtempSync(join(tmpdir(),"cove-writer-review-"));
  try {
    const output=join(directory,"inventory.json");
    const result=spawnSync(process.execPath,["scripts/check-canonical-writer-closure.mjs","--audit"],{
      encoding:"utf8",env:{...process.env,COVE_WRITER_AUDIT_OUTPUT:output},timeout:30_000
    });
    assert.equal(result.status,0,result.stderr);
    return identifyWriterSites(JSON.parse(readFileSync(output,"utf8")).findings);
  } finally {rmSync(directory,{recursive:true,force:true});}
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) {
  const result=reconcileWriterSites(currentWriterSites(),JSON.parse(readFileSync(REVIEW_PATH,"utf8")));
  assert.equal(result.unknown.length,0,"New or edited SQL requires fresh site review: "+JSON.stringify(result.unknown));
  assert.equal(result.stale.length,0,"Removed SQL review entries require reconciliation: "+JSON.stringify(result.stale));
  const counts={};for(const row of result.rows)counts[row.review.disposition]=(counts[row.review.disposition]||0)+1;
  console.log("PASS: every current mutation candidate has an exact SQL/function review: "+JSON.stringify(counts));
  console.log("BLOCKED: classification is not deployed writer ownership; the independent release gate remains closed.");
}
