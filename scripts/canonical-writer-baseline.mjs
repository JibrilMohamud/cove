/* eslint-disable prettier/prettier -- Exact reviewed pre-migration inventory snapshot, no automatic allowances. */
import {createHash} from "node:crypto";
import {inflateSync} from "node:zlib";

/**
 * Counts of each (file, canonical table, SQL operation), including 22 new isolated-QA owner executor sites. The 426 legacy owner-required sites remain open. No production approval.
 * Historical snapshot:
 * after reviewed refund extraction on c706eae6. This is NOT an approval for any legacy writer; all 482 are
 * unverified and the independent production cutover still hard-fails.
 * Previous source: immutable CI artifact #12792369666, workflow #40634634723.
 * Review: 10 commerce sites extracted into 11 atomic refund sites; one
 * explicit royalty ledger SQL site added. All remain unresolved; release
 * denial is unchanged. Exact SQL-site review accompanies this snapshot.
 *
 * The compressed payload is a compact deterministic serialization of 284
 * rows [relativeSourcePath, tableName, operation, count]. To audit it, run
 * 'node scripts/check-canonical-writer-closure.mjs --audit' and inspect its
 * uploaded full 482-row line-addressed JSON. Decreases are allowed; additions
 * require a reviewed baseline update with explicit owner-first evidence.
 * Do NOT regenerate on every PR; that would erase the regression guarantee.
 */
const reviewedBaselineCompressed = "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";
export function canonicalWriterBaseline() {
  const json=inflateSync(Buffer.from(reviewedBaselineCompressed,"base64")).toString("utf8");
  const sha=createHash("sha256").update(json).digest("hex");
  if(sha!=="413a9ac9e4c4b4c645c016ed00537f5fd6659ed024fa5547e98588550a2035e5")
    throw Error("Canonical writer baseline digest mismatch");
  const rows=JSON.parse(json);
  if(!Array.isArray(rows) || rows.length!==284)throw Error("Unreviewed writer baseline shape");
  const counts=new Map();
  for(const row of rows) {
    if(!Array.isArray(row)||row.length!==4||!Number.isSafeInteger(row[3])||row[3]<1)
      throw Error("Invalid canonical writer baseline count");
    const key=JSON.stringify(row.slice(0,3));
    if(counts.has(key))throw Error("Duplicate canonical writer baseline entry");
    counts.set(key,row[3]);
  }
  if([...counts.values()].reduce((a,b)=>a+b,0)!==482)throw Error("Writer baseline total mismatch");
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
