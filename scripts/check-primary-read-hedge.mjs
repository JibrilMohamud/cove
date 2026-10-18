import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { build } from "esbuild";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "cove-primary-hedge-"));
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
try {
  await build({
    entryPoints: ["src/features/fore/primary-read-hedge.server.ts"],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile: path.join(root, "hedge.mjs"),
    logLevel: "silent",
  });
  const { primaryReadWithHedge } = await import(path.join(root, "hedge.mjs"));
  const options = (allowDuplicate = async () => true) => {
    const retained = [];
    return {
      retained,
      execution: { waitUntil: (p) => retained.push(p) },
      delayMs: 0,
      allowDuplicate,
    };
  };
  let calls = 0;
  const fast = options(async () => {
    throw Error("fast read must not spend hedge budget");
  });
  assert.deepEqual(await primaryReadWithHedge(async () => ++calls, fast), {
    value: 1,
    duplicated: false,
  });
  await tick();
  assert.equal(calls, 1);

  const original = deferred();
  calls = 0;
  const slow = options();
  assert.deepEqual(
    await primaryReadWithHedge(
      () => (++calls === 1 ? original.promise : Promise.resolve("live-primary-copy")),
      slow,
    ),
    { value: "live-primary-copy", duplicated: true },
  );
  assert.equal(calls, 2, "one and only one duplicate");
  original.reject(Error("late failure"));
  await Promise.all(slow.retained);

  const denied = options();
  calls = 0;
  await assert.rejects(
    primaryReadWithHedge(async () => {
      calls++;
      throw Error("primary denied");
    }, denied),
    /primary denied/,
  );
  await tick();
  assert.equal(calls, 1, "primary rejection cannot be overridden by a later request");
  await Promise.all(denied.retained);

  const kept = deferred();
  const failedCopy = options();
  calls = 0;
  const pending = primaryReadWithHedge(
    () => (++calls === 1 ? kept.promise : Promise.reject(Error("copy failed"))),
    failedCopy,
  );
  await tick();
  assert.equal(calls, 2);
  kept.resolve("original");
  assert.deepEqual(await pending, { value: "original", duplicated: true });
  await Promise.all(failedCopy.retained);

  const budget = deferred();
  const blocked = deferred();
  calls = 0;
  const limited = options(async () => {
    budget.resolve();
    return false;
  });
  const limitedRead = primaryReadWithHedge(() => {
    calls++;
    return blocked.promise;
  }, limited);
  await budget.promise;
  blocked.resolve("original-without-budget");
  assert.deepEqual(await limitedRead, { value: "original-without-budget", duplicated: false });
  assert.equal(calls, 1);
  await Promise.all(limited.retained);

  calls = 0;
  assert.deepEqual(
    await primaryReadWithHedge(async () => ++calls, {
      allowDuplicate: async () => true,
      delayMs: 0,
    }),
    { value: 1, duplicated: false },
  );
  assert.equal(calls, 1, "no lifecycle means no retained extra work");
  console.log(
    "PASS: bounded primary read hedge, fast path, primary rejection, duplicate failure, late rejection, budget denial and missing lifecycle.",
  );
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
