/* eslint-disable prettier/prettier -- Exact reviewed pre-migration inventory snapshot, no automatic allowances. */
import {createHash} from "node:crypto";
import {readFileSync} from "node:fs";
import {inflateSync} from "node:zlib";

/**
 * Counts of each (file, canonical table, SQL operation) discovered on main
 * after reviewed refund extraction on c706eae6. This is NOT an approval for any legacy writer; all 460 are
 * unverified and the independent production cutover still hard-fails.
 * Previous source: immutable CI artifact #12792369666, workflow #40634634723.
 * Review: 10 commerce sites extracted into 11 atomic refund sites; one
 * explicit royalty ledger SQL site added. All remain unresolved; release
 * denial is unchanged. Exact SQL-site review accompanies this snapshot.
 *
 * The compressed payload is a compact deterministic serialization of 266
 * rows [relativeSourcePath, tableName, operation, count]. To audit it, run
 * 'node scripts/check-canonical-writer-closure.mjs --audit' and inspect its
 * uploaded full 460-row line-addressed JSON. Decreases are allowed; additions
 * require a reviewed baseline update with explicit owner-first evidence.
 * Do NOT regenerate on every PR; that would erase the regression guarantee.
 */
const reviewedBaselineCompressed = "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";
export function canonicalWriterBaseline() {
  const json=inflateSync(Buffer.from(reviewedBaselineCompressed,"base64")).toString("utf8");
  const sha=createHash("sha256").update(json).digest("hex");
  if(sha!=="6e3b23ddb877f8f9431e00eb703d60df6ba09bbf33edca4c33e5b57f9f4b88c6")
    throw Error("Canonical writer baseline digest mismatch");
  const rows=JSON.parse(json);
  if(!Array.isArray(rows) || rows.length!==266)throw Error("Unreviewed writer baseline shape");
  const counts=new Map();
  for(const row of rows) {
    if(!Array.isArray(row)||row.length!==4||!Number.isSafeInteger(row[3])||row[3]<1)
      throw Error("Invalid canonical writer baseline count");
    const key=JSON.stringify(row.slice(0,3));
    if(counts.has(key))throw Error("Duplicate canonical writer baseline entry");
    counts.set(key,row[3]);
  }
  if([...counts.values()].reduce((a,b)=>a+b,0)!==460)throw Error("Historical writer baseline mismatch");
  // Reviewed NEW canonical mutation in the independently leased QA owner.
  // This is a bounded, source-hash-pinned addendum, not a regenerated
  // blanket baseline. Any change to its SQL, owner checks, caller or
  // fallback reopens the security review BEFORE accepting a new writer.
  const file="src/storefront-strangler/refund-provider-owner-executor.ts";
  const exactSourceSha256="1d9455b258b986c04c783faece90e6006fd24d843a819a3fc73434dca74d660f";
  const actual=createHash("sha256").update(readFileSync(file,"utf8")).digest("hex");
  if(actual!==exactSourceSha256)
    throw Error("Reviewed QA owner provider writer changed; independent security review required");
  const key=JSON.stringify([file,"commerce_refunds","UPDATE"]);
  if(counts.has(key))throw Error("Duplicate QA owner provider writer review");
  counts.set(key,1);
  if([...counts.values()].reduce((a,b)=>a+b,0)!==461)
    throw Error("Writer review must include exactly 460 historical plus one QA owner site");
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
