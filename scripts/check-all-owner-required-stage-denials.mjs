/* eslint-disable prettier/prettier -- This is a source-bound security witness for every unowned canonical SQL literal. */
/**
 * Every currently reviewed owner-required canonical mutation must be denied
 * when routed through the staging canonical D1 fence. This is NOT production
 * writer certification: callers, external D1 mutations, runtime-generated
 * queries, and deployed configuration require independent verification.
 */
import assert from "node:assert/strict";
import {build} from "esbuild";
import {mkdtempSync,rmSync,readFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {pathToFileURL} from "node:url";
import ts from "typescript";
import {currentWriterSites,REVIEW_PATH,reconcileWriterSites} from "./reconcile-canonical-writers.mjs";

const review=JSON.parse(readFileSync(REVIEW_PATH,"utf8"));
assert.equal(review.releaseApproval,false);
const current=currentWriterSites();
const check=reconcileWriterSites(current,review);
assert.deepEqual(check.unknown,[],"All current authorizing SQL requires source-bound review");
assert.deepEqual(check.stale,[],"Removed or changed SQL must be reconciled");
const byId=new Map(review.sites.map(x=>[x.siteId,x]));
const required=current.filter(x=>byId.get(x.siteId)?.disposition==="owner-command-required");
// No minimum: legitimate typed owner-command migration must be able to
// shrink this set to zero once the source-bound review is reconciled.

const folder=mkdtempSync(join(tmpdir(),"cove-all-legal-sql-fence-"));
try{
  const compiled=join(folder,"stage-lock.mjs");
  await build({entryPoints:["src/storefront-strangler/legal-primary-write-lock.ts"],
    outfile:compiled,format:"esm",platform:"node",bundle:true,target:"node22",logLevel:"silent"});
  const {classifyProtectedLegalSql,guardProtectedLegalSql}=await import(pathToFileURL(compiled).href);
  const parsed=new Map();
  let blocked=0;
  const failure=[];
  const files=new Map();
  for(const row of required){
    if(!parsed.has(row.file)){
      const body=readFileSync(row.file,"utf8");
      const source=ts.createSourceFile(row.file,body,ts.ScriptTarget.Latest,true);
      assert.equal(source.parseDiagnostics.length,0,"Source parse failed: "+row.file);
      const literals=[];
      function walk(node){
        if(ts.isStringLiteral(node)||ts.isNoSubstitutionTemplateLiteral(node)||ts.isTemplateExpression(node))
          literals.push(node);
        ts.forEachChild(node,walk);
      }
      walk(source);
      parsed.set(row.file,{body,source,literals});
    }
    const {body,source,literals}=parsed.get(row.file);
    const start=source.getPositionOfLineAndCharacter(row.line-1,0);
    const newline=body.indexOf("\n",start),end=newline<0?body.length:newline;
    const candidates=literals.filter(n=>n.getStart(source)<=end&&n.end>start&&
      new RegExp("\\b"+row.table+"\\b","i").test(n.getText(source)))
      .sort((a,b)=>(a.end-a.pos)-(b.end-b.pos));
    if(!candidates.length){
      failure.push(row.file+":"+row.line+" missing exact SQL AST literal");
      continue;
    }
    const candidate=candidates[0];
    const sql=ts.isTemplateExpression(candidate)?candidate.getText(source):candidate.text;
    // Raw template interpolation is never assumed authorized. Even when a
    // dynamic fragment exists, the literal's protected SQL table and verb
    // must still be recognized and denied, or the source is a blind spot.
    try{
      const protectedTables=classifyProtectedLegalSql(sql);
      if(!protectedTables.includes(row.table))
        failure.push(row.file+":"+row.line+" "+row.table+" not recognized: "+sql.slice(0,170));
      else assert.throws(()=>guardProtectedLegalSql(sql),
        /canonical_legal_write_requires_owner_fence/,
        "Owner-required SQL must fail closed at staging D1 boundary");
    }catch(e){
      failure.push(row.file+":"+row.line+" guard/parser failure: "+String(e).slice(0,200));
    }
    blocked++;
    files.set(row.file,(files.get(row.file)||0)+1);
  }
  assert.deepEqual(failure,[],"Authorizing source SQL escaped staged owner-fence verification");
  assert.equal(blocked,required.length);
  console.log("PASS: "+blocked+" source-bound owner-required SQL sites across "+files.size+
    " source files are recognized and rejected by the stage SQL fence; independent production ownership remains blocked");
}finally{rmSync(folder,{force:true,recursive:true});}
