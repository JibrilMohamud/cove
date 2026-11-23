import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const folder = mkdtempSync(join(tmpdir(), "cove-cron-receipts-"));
try {
  const outfile = join(folder, "cron.mjs");
  await build({
    stdin: {
      contents: 'export {assertCronResult,assertCronSettled} from "./src/lib/cron-result-guard";',
      resolveDir: resolve("."),
      loader: "ts",
    },
    outfile,
    bundle: true,
    platform: "node",
    format: "esm",
    logLevel: "silent",
  });
  const { assertCronResult, assertCronSettled } = await import(pathToFileURL(outfile).href);
  assert.equal(assertCronResult(undefined), undefined);
  assert.equal(assertCronResult(null), null);
  assert.deepEqual(assertCronResult({ ok: true, processed: 2 }), {
    ok: true,
    processed: 2,
  });
  assert.throws(
    () => assertCronResult({ ok: false, error: "owner_refused" }),
    /cove_scheduled_operation_reported_failure/,
  );
  assert.throws(() => assertCronResult({ ok: false }), /cove_scheduled_operation_reported_failure/);
  assert.doesNotThrow(() => assertCronSettled([{ status: "fulfilled", value: undefined }]));
  assert.throws(
    () => assertCronSettled([{ status: "rejected", reason: "private-context-must-not-escape" }]),
    (error) =>
      error?.message === "cove_scheduled_parallel_tasks_failed" &&
      !error.message.includes("private-context"),
  );
  assert.throws(
    () =>
      assertCronSettled([
        { status: "fulfilled", value: 1 },
        { status: "rejected", reason: new Error("private-owner-secret") },
      ]),
    /cove_scheduled_parallel_tasks_failed/,
  );
  const worker = readFileSync("src/persistence-backend.worker.ts", "utf8");
  assert.match(worker, /assertCronResult\(await operation\(\)\)/);
  assert.match(
    worker,
    /if\s*\(failedOperations\)\s*throw Error\("cove_scheduled_queue_operations_failed"\)/,
  );
  assert.match(
    worker,
    /assertCronResult\(result\);\s*console\.info\("Account erasure tick completed"\)/,
  );
  assert.match(
    worker,
    /Account erasure tick failed; queued requests will be retried\."\);\s*throw error/,
  );
  assert.match(worker, /Published soundtrack rights audit failed"\);\s*throw error/);
  assert.match(worker, /assertCronSettled\(results\)/);
  assert.equal(
    (worker.match(/assertCronSettled\\(audioResults\\)/g) || []).length,
    2,
    "Both five-minute audio pathways must surface rejected task receipts",
  );
  console.log(
    "PASS: negative owner receipts, rights audit errors and parallel scheduled rejections all fail closed",
  );
} finally {
  rmSync(folder, { recursive: true, force: true });
}
