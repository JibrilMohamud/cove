/* eslint-disable prettier/prettier -- Exact reviewed pre-migration inventory snapshot, no automatic allowances. */
import {createHash} from "node:crypto";
import {inflateSync} from "node:zlib";

/**
 * Counts of each (file, canonical table, SQL operation) discovered on main
 * after 4d41ab0. This is NOT an approval for any legacy writer; all 458 are
 * unverified and the independent production cutover still hard-fails.
 * Source: immutable CI artifact #12792369666, workflow #40634634723.
 *
 * The compressed payload is a compact deterministic serialization of 256
 * rows [relativeSourcePath, tableName, operation, count]. To audit it, run
 * 'node scripts/check-canonical-writer-closure.mjs --audit' and inspect its
 * uploaded full 458-row line-addressed JSON. Decreases are allowed; additions
 * require a reviewed baseline update with explicit owner-first evidence.
 * Do NOT regenerate on every PR; that would erase the regression guarantee.
 */
const reviewedBaselineCompressed = "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";
export function canonicalWriterBaseline() {
  const json=inflateSync(Buffer.from(reviewedBaselineCompressed,"base64")).toString("utf8");
  const sha=createHash("sha256").update(json).digest("hex");
  if(sha!=="d6e5b729f20dec224a980a16b6684809ea242f2f96e84b454e8a5da18b74a799")
    throw Error("Canonical writer baseline digest mismatch");
  const rows=JSON.parse(json);
  if(!Array.isArray(rows) || rows.length!==256)throw Error("Unreviewed writer baseline shape");
  const counts=new Map();
  for(const row of rows) {
    if(!Array.isArray(row)||row.length!==4||!Number.isSafeInteger(row[3])||row[3]<1)
      throw Error("Invalid canonical writer baseline count");
    const key=JSON.stringify(row.slice(0,3));
    if(counts.has(key))throw Error("Duplicate canonical writer baseline entry");
    counts.set(key,row[3]);
  }
  if([...counts.values()].reduce((a,b)=>a+b,0)!==458)throw Error("Writer baseline total mismatch");
  return counts;
}
export function canonicalWriterDrift(findings,baseline=canonicalWriterBaseline()) {
  const now=new Map();
  for(const item of findings) {
    const key=JSON.stringify([item.file,item.table,item.operation]);
    now.set(key,(now.get(key)||0)+1);
  }
  const newlyUnfenced=[];
  for(const [key,count] of now) {
    const allowed=baseline.get(key)||0;
    if(count>allowed) {
      const [file,table,operation]=JSON.parse(key);
      newlyUnfenced.push({file,table,operation,new:count-allowed,current:count,baseline:allowed});
    }
  }
  newlyUnfenced.sort((a,b)=>a.file.localeCompare(b.file)||a.table.localeCompare(b.table)||a.operation.localeCompare(b.operation));
  return newlyUnfenced;
}
