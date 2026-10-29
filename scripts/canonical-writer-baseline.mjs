/* eslint-disable prettier/prettier -- Exact reviewed pre-migration inventory snapshot, no automatic allowances. */
import {createHash} from "node:crypto";
import {inflateSync} from "node:zlib";

/**
 * Counts of each (file, canonical table, SQL operation), including 23 new isolated-QA owner executor sites. The 426 legacy owner-required sites remain open. No production approval.
 * Historical snapshot:
 * after reviewed refund extraction on c706eae6. This is NOT an approval for any legacy writer; all 483 are
 * unverified and the independent production cutover still hard-fails.
 * Previous source: immutable CI artifact #12792369666, workflow #40634634723.
 * Review: 10 commerce sites extracted into 11 atomic refund sites; one
 * explicit royalty ledger SQL site added. All remain unresolved; release
 * denial is unchanged. Exact SQL-site review accompanies this snapshot.
 *
 * The compressed payload is a compact deterministic serialization of 285
 * rows [relativeSourcePath, tableName, operation, count]. To audit it, run
 * 'node scripts/check-canonical-writer-closure.mjs --audit' and inspect its
 * uploaded full 483-row line-addressed JSON. Decreases are allowed; additions
 * require a reviewed baseline update with explicit owner-first evidence.
 * Do NOT regenerate on every PR; that would erase the regression guarantee.
 */
const reviewedBaselineCompressed = "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";
export function canonicalWriterBaseline() {
  const json=inflateSync(Buffer.from(reviewedBaselineCompressed,"base64")).toString("utf8");
  const sha=createHash("sha256").update(json).digest("hex");
  if(sha!=="1babccd22b4741ff67a354eaf63d4e18ff4a584a3048c1abc05e8b06f74d6b53")
    throw Error("Canonical writer baseline digest mismatch");
  const rows=JSON.parse(json);
  if(!Array.isArray(rows) || rows.length!==285)throw Error("Unreviewed writer baseline shape");
  const counts=new Map();
  for(const row of rows) {
    if(!Array.isArray(row)||row.length!==4||!Number.isSafeInteger(row[3])||row[3]<1)
      throw Error("Invalid canonical writer baseline count");
    const key=JSON.stringify(row.slice(0,3));
    if(counts.has(key))throw Error("Duplicate canonical writer baseline entry");
    counts.set(key,row[3]);
  }
  if([...counts.values()].reduce((a,b)=>a+b,0)!==483)throw Error("Writer baseline total mismatch");
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
