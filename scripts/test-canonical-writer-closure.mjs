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
  // The canonical registry is an inventory on main, not evidence that the
  // still-draft owner-first runtime denial fence has been deployed.
  const names=JSON.parse(readFileSync("src/storefront-strangler/canonical-legal-tables.json","utf8"));
  assert.ok(Array.isArray(names),"Canonical table registry must be a JSON array");
  assert.ok(names.every(name=>/^[a-z][a-z0-9_]*$/.test(name)),"Invalid protected table name");
  const scanner=readFileSync("scripts/check-canonical-writer-closure.mjs","utf8");
  const lock=readFileSync("src/storefront-strangler/legal-primary-write-lock.ts","utf8");
  assert.ok(scanner.includes('from "../src/storefront-strangler/canonical-legal-tables.json"'));
  assert.ok(lock.includes('from "./canonical-legal-tables.json"'));
  assert.match(scanner,/const protectedTables=canonicalProtectedTables/);
  assert.match(lock,/const LEGAL_TABLES = canonicalProtectedTables/);
  assert.ok(names.length>=120, "Every protected rights, finance and media table must be inventoried");
  assert.equal(names.length,new Set(names).size,"Duplicate canonical protected-table registry name");
  assert.ok(result.scannedFiles>50);
  assert.ok(!result.findings.some(row=>row.file.startsWith("scripts/test-")),
    "Unit-test SQL must never masquerade as production canonical writer evidence");
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
  const freeze=run(["--no-new-writers"]);
  assert.equal(freeze.status,0,freeze.stderr);
  assert.match(freeze.stdout,/Existing 460 source candidates STILL BLOCK/);
  const {canonicalWriterDrift,canonicalWriterBaseline}=await import("./canonical-writer-baseline.mjs");
  const baseline=canonicalWriterBaseline();
  assert.equal([...baseline.values()].reduce((a,b)=>a+b,0),460);
  assert.deepEqual(canonicalWriterDrift(result.findings,baseline),[],
    "Frozen exact file/table/operation inventory must match trusted main");
  const first=result.findings[0];
  assert.ok(first);
  const added=[...result.findings,{...first,line:first.line+1}];
  const increase=canonicalWriterDrift(added,baseline);
  assert.equal(increase.length,1,"New SQL in a known table/file may never be hidden");
  assert.equal(increase[0].new,1);
  const disguised=[...result.findings.slice(1),{
    ...first,file:"src/features/fore/new-hidden-writer.server.ts"
  }];
  assert.equal(disguised.length,result.findings.length,
    "The adversary can hide a new writer behind a deletion and unchanged total");
  assert.equal(canonicalWriterDrift(disguised,baseline).length,1,
    "Net-zero writer swaps must still fail by source/table/operation");
  assert.deepEqual(canonicalWriterDrift(result.findings.slice(1),baseline),[],
    "Removing an unported direct SQL mutation must be allowed");
  const blocked=run(["--release-gate"]);
  const forged=spawnSync(process.execPath,["scripts/check-canonical-writer-closure.mjs","--release-gate"],{
    encoding:"utf8",
    timeout:30000,
    env:{...env,COVE_LEGAL_OWNER_WRITER_CLOSURE_AUDITED:"1",
      COVE_FAST_STOREFRONT_RELEASE_CERTIFIED:"1",
      COVE_RIGHTS_OWNER_ENABLED:"1"},
  });
  assert.notEqual(forged.status,0,
    "Self-reported owner closure or storefront readiness may never override the missing release certificate");
  assert.notEqual(blocked.status,0,
    "A source-only audit or self-declared flag must NEVER enable production owner-only authorization");
  assert.match(blocked.stderr,/BLOCKED: production owner-only anonymous read is unsafe/);
  console.log("PASS: exact writer drift detection, net-zero evasion denial, and real rights/publishing/commerce/delivery/audio writer inventory; deterministic results; production owner-only release denied until externally certified closure");
}finally{rmSync(folder,{recursive:true,force:true});}
