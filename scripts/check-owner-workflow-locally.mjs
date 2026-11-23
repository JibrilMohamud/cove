/* eslint-disable prettier/prettier -- Run every node command from the actual owner workflow, including single-line run steps. */
import assert from "node:assert/strict";
import {readFileSync,mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {spawnSync} from "node:child_process";
const workflow=readFileSync(".github/workflows/canonical-writer-closure-audit.yml","utf8"),commands=[];
for(const line of workflow.split("\n")){
 let command=line.trim();if(command.startsWith("run: node "))command=command.slice(5);
 if(!command.startsWith("node "))continue;
 assert.match(command,/^node scripts\/[a-zA-Z0-9_./-]+\.mjs(?: [a-zA-Z0-9_=./-]+)*$/, "Unsupported node workflow syntax must not be silently omitted");
 if(!commands.includes(command))commands.push(command);
}
assert.ok(commands.includes("node scripts/test-canonical-writer-closure.mjs"));
assert.ok(commands.includes("node scripts/reconcile-canonical-writers.mjs"));
assert.ok(commands.includes("node scripts/check-canonical-writer-closure.mjs --audit"));
const folder=mkdtempSync(join(tmpdir(),"cove-owner-workflow-"));
try{
 console.log("Running "+commands.length+" node workflow steps; CI dependency installation and artifact upload are excluded.");
 for(const [i,command] of commands.entries()){
  console.log("STEP "+(i+1)+"/"+commands.length+": "+command);
  const result=spawnSync(process.execPath,command.split(" ").slice(1),{stdio:"inherit",timeout:600000,
   env:{...process.env,COVE_WRITER_AUDIT_OUTPUT:join(folder,"writers.json"),COVE_WORKFLOW_AUDIT_OUTPUT:join(folder,"workflows.json")}});
  if(result.status!==0){console.error("FAILED: "+command);process.exitCode=result.status||1;break;}
 }
 if(!process.exitCode)console.log("PASS: all "+commands.length+" node owner-workflow steps, including inline run steps");
}finally{rmSync(folder,{recursive:true,force:true});}
