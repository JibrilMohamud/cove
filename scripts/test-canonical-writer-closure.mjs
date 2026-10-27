/* eslint-disable prettier/prettier -- Guardrail tests: release must fail closed, inventory must be reproducible. */
import assert from "node:assert/strict";
import {mkdtempSync,readFileSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {spawnSync} from "node:child_process";
const folder=mkdtempSync(join(tmpdir(),"cove-canonical-writer-"));
try{
  const file=join(folder,"audit.json");
  const env={...process.env,COVE_WRITER_AUDIT_OUTPUT:file};
  const run=args=>spawnSync(process.execPath,[
    "scripts/check-canonical-writer-closure.mjs",...args
  ],{encoding:"utf8",env,timeout:30000});
  const inventory=run(["--audit"]);
  assert.equal(inventory.status,0,inventory.stderr);
  const result=JSON.parse(readFileSync(file,"utf8"));
  assert.equal(result.schema,"cove.canonical-writer-inventory.v1");
  assert.equal(result.staticScanOnly,true);
  // The runtime D1 denial fence and the audit must protect the SAME tables.
  // Omitting one can permit direct SQL through a route despite a green audit.
  const scanner=readFileSync("scripts/check-canonical-writer-closure.mjs","utf8");
  const runtimeLock=readFileSync("src/storefront-strangler/legal-primary-write-lock.ts","utf8");
  function registry(source,begin,end){
    const start=source.indexOf(begin);
    assert.ok(start>=0,"missing canonical table registry: "+begin);
    const finish=source.indexOf(end,start);
    assert.ok(finish>start,"incomplete canonical table registry: "+begin);
    const names=[...source.slice(start,finish).matchAll(/"([a-z_]+)"/g)].map(x=>x[1]);
    assert.equal(names.length,new Set(names).size,"duplicate canonical protected table");
    return names.sort();
  }
  assert.deepEqual(
    registry(runtimeLock,"const LEGAL_TABLES = [","] as const;"),
    registry(scanner,"const protectedTables=[","];"),
    "Audit and runtime D1 mutation denial must cover identical protected tables"
  );
  assert.ok(result.scannedFiles>50);
  assert.ok(result.unresolvedDirectWrites>80,
    "Unexpectedly empty writer audit: do not certify production from a broken scanner");
  for(const path of [
    "src/features/fore/rights.server.ts",
    "src/features/fore/publishing.server.ts",
    "src/features/fore/commerce.server.ts",
    "src/features/fore/delivery.server.ts",
    "src/features/fore/commercial-audio.server.ts"
  ])assert.ok(result.byFile[path]>0,"Missing high-risk canonical writer inventory: "+path);
  for(const domain of ["publication_rights","financial","customer_permission",
    "protected_media"])assert.ok(result.byDomain[domain]>0,
    "Unreported canonical writer category: "+domain);
  const duplicate=run(["--audit"]);
  assert.equal(duplicate.status,0);
  const result2=JSON.parse(readFileSync(file,"utf8"));
  assert.deepEqual(result, result2,"The canonical-writer report cannot vary by clock or runner");
  const blocked=run(["--release-gate"]);
  assert.notEqual(blocked.status,0,
    "A source-only audit or self-declared flag must NEVER enable production owner-only authorization");
  assert.match(blocked.stderr,/BLOCKED: production owner-only anonymous read is unsafe/);
  console.log("PASS: real rights/publishing/commerce/delivery/audio writer inventory; deterministic results; production owner-only release denied until externally certified closure");
}finally{rmSync(folder,{recursive:true,force:true});}
