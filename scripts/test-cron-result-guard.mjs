import assert from "node:assert/strict";
import {build} from "esbuild";
import {mkdtempSync,rmSync,readFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join,resolve} from "node:path";
import {pathToFileURL} from "node:url";
const folder=mkdtempSync(join(tmpdir(),"cove-cron-receipts-"));
try {
  const outfile=join(folder,"cron.mjs");
  await build({stdin:{contents:'export {assertCronResult} from "./src/lib/cron-result-guard";',
    resolveDir:resolve("."),loader:"ts"},outfile,bundle:true,platform:"node",format:"esm",logLevel:"silent"});
  const {assertCronResult}=await import(pathToFileURL(outfile).href);
  assert.equal(assertCronResult(undefined),undefined);
  assert.equal(assertCronResult(null),null);
  assert.deepEqual(assertCronResult({ok:true,processed:2}),{ok:true,processed:2});
  assert.throws(()=>assertCronResult({ok:false,error:"owner_refused"}),/cove_scheduled_operation_reported_failure/);
  assert.throws(()=>assertCronResult({ok:false}),/cove_scheduled_operation_reported_failure/);
  const worker=readFileSync("src/persistence-backend.worker.ts","utf8");
  assert.match(worker,/assertCronResult\(await operation\(\)\)/);
  assert.match(worker,/if\(failedOperations\)throw Error\("cove_scheduled_queue_operations_failed"\)/);
  assert.match(worker,/assertCronResult\(result\);\s*console\.info\("Account erasure tick completed"\)/);
  assert.match(worker,/Account erasure tick failed; queued requests will be retried\."\);\s*throw error/);
  console.log("PASS: negative scheduled owner receipts fail closed in queue and erasure jobs without false cron success");
} finally {rmSync(folder,{recursive:true,force:true});}
