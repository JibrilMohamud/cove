/* eslint-disable prettier/prettier -- Immutable original exception identities prevent classification laundering. */
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";

export const EXCEPTION_BASELINE_PATH="docs/architecture/canonical-writer-exception-baseline.json";
const identity=x=>JSON.stringify([x.file,x.functionName,x.table,x.operation,x.sqlSha256]);
const buckets={
  "non-authorizing-write":"nonAuthorizing",
  "private-owner-qa-executor":"privateQaExecutor",
  "isolated-test-fixture":"testFixture"
};
const inventory=(sites)=>{
  const count=new Map();
  for(const row of sites) {
    const key=identity(row);
    count.set(key,(count.get(key)||0)+1);
  }
  return count;
};
/** This check only permits previously reviewed exceptions to REMAIN or
 * DISAPPEAR. A production authorizing SQL literal cannot be relabeled as a
 * harmless telemetry writer or a private executor to reduce the open count.
 * Exact SQL source reconciliation independently rejects missing active
 * statements and modified statements without review.
 */
export function assertFrozenExceptionLineage(sites,
  baseline=JSON.parse(readFileSync(EXCEPTION_BASELINE_PATH,"utf8"))) {
  assert.equal(baseline.schema,"cove.canonical-writer-classification-baseline.v1");
  assert.equal(baseline.baselineCommit,"e6fc9d39e13c609f0ecad771e064fc8b71e0b15a");
  assert.equal(baseline.nonAuthorizing.length,33);
  assert.equal(baseline.privateQaExecutor.length,23);
  assert.equal(baseline.testFixture.length,1);
  for(const [classification,field] of Object.entries(buckets)) {
    const remaining=inventory(baseline[field]);
    const now=sites.filter(x=>x.disposition===classification);
    for(const row of now) {
      const key=identity(row),allowed=remaining.get(key)||0;
      assert.ok(allowed>0,"New or laundered "+classification+" classification: "+key);
      remaining.set(key,allowed-1);
    }
  }
  return true;
}
