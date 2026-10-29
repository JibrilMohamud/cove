/* eslint-disable prettier/prettier -- Strict, intentionally conservative canonical-writer release inventory. */
/**
 * Scans the actual checked-out source files, not a hand-written "done" list.
 * Run --audit to inventory still-unowned D1 writers (exit 0).
 * Run --release-gate to REFUSE owner-only production storefront mode until
 * there are no direct legal/commerce/publication writes outside a reviewed,
 * fenced writer executor, and all dynamic SQL has been resolved.
 *
 * Static search is a lower bound: JS-generated SQL, external deployments and
 * operator access cannot be certified by scanning alone. Zero findings here
 * is necessary, never sufficient, for production canonical ownership.
 */
import {readdirSync,readFileSync,statSync,writeFileSync,mkdirSync} from "node:fs";
import {join,relative,resolve} from "node:path";
import {fileURLToPath} from "node:url";
import assert from "node:assert/strict";
import {canonicalWriterDrift} from "./canonical-writer-baseline.mjs";
import canonicalProtectedTables from "../config/canonical-legal-tables.json" with {type:"json"};
const root=resolve(fileURLToPath(new URL("..",import.meta.url)));
const sources=["src","scripts","worker","workers"];
const protectedTables=canonicalProtectedTables;
const legal=new Set(protectedTables);
assert.equal(legal.size,protectedTables.length,"Duplicate canonical legal table in audit registry");
const mutating=/\b(INSERT\s+(?:OR\s+\w+\s+)?INTO|REPLACE\s+INTO|UPDATE(?:\s+OR\s+\w+)?|DELETE\s+FROM|DROP\s+TABLE|ALTER\s+TABLE)\s+(?:(?:["'\x60\[]?[a-z_][a-z0-9_]*["'\x60\]]?\s*\.\s*))?["'\x60\[]?([a-z_][a-z0-9_]*)/gi;
const ignore=(name,path)=>
  name==="node_modules" || name===".git"||name==="dist"||
  name==="build"||name==="coverage"||name===".wrangler"||
  path.startsWith("scripts/staging/")||path.startsWith("scripts/check-")||
  path.startsWith("scripts/test-")||
  path.includes("__tests__")||path.endsWith(".test.ts")||
  path.endsWith(".spec.ts")||path.endsWith(".d.ts")||
  path.startsWith("src/storefront-strangler/legal-quarantine-qa.writer.ts")||
  path.startsWith("src/storefront-strangler/legal-authority.worker.ts");
const include=(name)=>/\.(?:[cm]?[jt]s|tsx)$/.test(name);
function walk(dir,out=[]){
  let items;
  try{items=readdirSync(join(root,dir),{withFileTypes:true});}catch{return out;}
  for(const item of items){
    const name=dir+"/"+item.name;
    if(ignore(item.name,name))continue;
    if(item.isDirectory())walk(name,out);
    else if(item.isFile()&&include(item.name))out.push(name);
  }
  return out;
}
function classOf(table){
  if(/^commerce_|^finance_|^preorders$/.test(table))return "financial";
  if(/^publishing_|^publication_|^rights_|^territory_|^storefront_markets$|^offers$|^products$|^editions$|^retail_product_/.test(table))return "publication_rights";
  if(/^entitlement|^licenses$|^subscriptions$|^subscription_catalog$|^devices$|^risk_holds$/.test(table))return "customer_permission";
  if(/audio|delivery|assets|offline|download/.test(table))return "protected_media";
  return "source_catalog";
}
function scan(path,text){
  const findings=[];
  for(const match of text.matchAll(mutating)){
    const table=match[2].toLowerCase();
    if(!legal.has(table))continue;
    const line=text.slice(0,match.index).split("\n").length;
    findings.push({file:path,line,table,operation:match[1].toUpperCase().replace(/\s+/g," "),domain:classOf(table)});
  }
  return findings;
}
const sourceFiles=sources.flatMap(dir=>walk(dir)).sort();
const findings=sourceFiles.flatMap(path=>scan(path,readFileSync(join(root,path),"utf8")))
  .sort((a,b)=>a.file.localeCompare(b.file)||a.line-b.line||a.table.localeCompare(b.table));
const summary={schema:"cove.canonical-writer-inventory.v1",
  generatedFrom:"checked-out-source",
  staticScanOnly:true,
  scannedFiles:sourceFiles.length,
  unresolvedDirectWrites:findings.length,
  byDomain:{},byFile:{},
  findings};
for(const row of findings){
  summary.byDomain[row.domain]=(summary.byDomain[row.domain]||0)+1;
  summary.byFile[row.file]=(summary.byFile[row.file]||0)+1;
}
const output=process.env.COVE_WRITER_AUDIT_OUTPUT;
if(output){
  const path=resolve(output);
  mkdirSync(join(path,".."),{recursive:true});
  writeFileSync(path,JSON.stringify(summary,null,2)+"\n",{mode:0o600});
}
console.log("Canonical writer scan: "+sourceFiles.length+" source files, "+
  findings.length+" unverified SQL mutations across "+
  Object.keys(summary.byFile).length+" files.");
console.log("Unverified by domain: "+JSON.stringify(summary.byDomain));
console.log("Top direct writer files: "+JSON.stringify(
  Object.entries(summary.byFile).sort((a,b)=>b[1]-a[1]).slice(0,18)));
if(process.argv.includes("--no-new-writers")) {
  // Keeping the existing 460 known direct writes visible is NOT production
  // owner-first certification. Prevent additional unreviewed sources from
  // silently joining the inventory during the migration.
  const drift=canonicalWriterDrift(findings);
  if(drift.length) {
    console.error("BLOCKED: new unverified canonical SQL writers since reviewed 460-site baseline.");
    console.error("Unreviewed new mutations: "+JSON.stringify(drift));
    process.exitCode=1;
  } else {
    console.log("PASS: no new direct canonical writer candidates since reviewed baseline. "+
      "Existing "+findings.length+" source candidates STILL BLOCK owner-only release.");
  }
}
const release=process.argv.includes("--release-gate");
if(release){
  // No flag, signed string, owner snapshot, branch name, successful staging
  // test or self-asserted certificate can override unresolved direct writes.
  if(findings.length){
    console.error("BLOCKED: production owner-only anonymous read is unsafe. "+
      findings.length+" direct canonical mutations remain unverified; this is a lower-bound inventory.");
    process.exitCode=1;
  }else{
    // Even a zero-match static scan cannot certify external cron/direct DB
    // access, operator mutations, SQL generated at runtime or deployed owner
    // routing. Explicitly require an independent release procedure.
    console.error("BLOCKED: source-only scan cannot certify deployed writer ownership, "+
      "positive proof or provider transport. Production acceptance requires external certification.");
    process.exitCode=1;
  }
}
