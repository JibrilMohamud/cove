/* eslint-disable prettier/prettier -- Fail-closed staging credential reference inventory. */
import assert from "node:assert/strict";
import {readFileSync,readdirSync} from "node:fs";
import {join} from "node:path";
import {pathToFileURL} from "node:url";
const name="COVE_CF_STAGE_WORKERS_DEPLOY_TOKEN";
export function findStandingStageReferences(source){
  const hits=[];
  // Dot access, literal bracket access, and unresolved computed access.
  // A dynamically chosen secret is not a provably cleared dependency.
  const add=(match,kind)=>hits.push({line:source.slice(0,match.index).split("\n").length,kind});
  const dot=new RegExp("\\bsecrets\\s*\\.\\s*"+name+"\\b","gi");
  for(const match of source.matchAll(dot))add(match,"legacy");
  // Classify a bracket expression exactly once. Trim after matching, not
  // through a backtracking whitespace quantifier before a negative lookahead.
  for(const match of source.matchAll(/\bsecrets\s*\[([^\]]*)\]/gi)){
    const expression=match[1].trim();
    const literal=expression.match(/^(['"])([a-z0-9_]+)\1$/i);
    if(!literal)add(match,"computed");
    else if(literal[2].toUpperCase()===name)add(match,"legacy");
  }
  return hits.sort((a,b)=>a.line-b.line||a.kind.localeCompare(b.kind));
}
export function inventory(root=process.cwd()){
  const dir=join(root,".github","workflows");
  const files=readdirSync(dir).filter(x=>/\.ya?ml$/.test(x)).sort();
  assert.ok(files.length>0,"Missing workflows; no revocation evidence");
  const remaining=files.map(workflow=>({workflow,hits:findStandingStageReferences(readFileSync(join(dir,workflow),"utf8"))})).filter(x=>x.hits.length);
  const references=remaining.reduce((n,x)=>n+x.hits.filter(h=>h.kind==="legacy").length,0);
  const unresolved=remaining.reduce((n,x)=>n+x.hits.filter(h=>h.kind==="computed").length,0);
  return {schema:"cove.standing-stage-workflow-inventory.v1",workflowsInspected:files.length,legacyReferences:references,unresolvedComputedReferences:unresolved,remaining,sourceCleared:references===0&&unresolved===0,hostedAcceptanceCertified:false,physicalRevocationCertified:false};
}
export function requireCleared(report){
  assert.equal(report.schema,"cove.standing-stage-workflow-inventory.v1");
  assert.equal(report.sourceCleared,true,"Standing staging authorization still referenced or unresolved; no revocation");
  assert.equal(report.legacyReferences,0);
  assert.equal(report.unresolvedComputedReferences,0);
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  const report=inventory();
  console.log(JSON.stringify(report,null,2));
  if(process.argv.includes("--require-zero"))requireCleared(report);
}
