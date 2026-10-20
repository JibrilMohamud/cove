import assert from "node:assert/strict";
import {
  runBackfill,
  validateOperatorConfig,
  REPAIR_CONFIRM,
} from "./operate-regional-epub-backfill.mjs";

const secret = "s".repeat(48);
const cfg = {
  execute: true,
  confirm: REPAIR_CONFIRM,
  origin: "https://protected-test.workers.dev",
  token: secret,
  limit: 2,
  maxBatches: 3,
  delayMs: 15_000,
  after: "",
};
let calls = 0;
assert.deepEqual(
  await runBackfill(
    { execute: false },
    {
      send: () => {
        calls++;
        throw Error("NO NETWORK");
      },
    },
  ),
  { skipped: "dry_run_no_network", maximumRepairs: 0 },
);
assert.equal(calls, 0);
assert.throws(() => validateOperatorConfig({ ...cfg, confirm: "" }), /approval/);
assert.throws(() => validateOperatorConfig({ ...cfg, limit: 17 }), /Unsafe/);
assert.throws(() => validateOperatorConfig({ ...cfg, delayMs: 100 }), /Unsafe/);
assert.throws(() => validateOperatorConfig({ ...cfg, origin: "http://example.org" }), /HTTPS/);
assert.throws(() => validateOperatorConfig({ ...cfg, after: "x';DROP" }), /Unsafe/);
let rounds = 0;
const receipts = [];
const slept = [];
const result = await runBackfill(cfg, {
  async send(url, args) {
    assert.equal(url, cfg.origin + "/__cove/ingestion/repair-regional-epubs");
    assert.equal(args.headers.Authorization, "Bearer " + secret);
    assert.equal(args.redirect, "manual");
    assert.equal(args.method, "POST");
    const body = JSON.parse(args.body);
    assert.equal(body.limit, 2);
    if (rounds === 0) assert.equal(body.after, "");
    if (rounds === 1) assert.equal(body.after, "pgau_1");
    if (rounds === 2) assert.equal(body.after, "pgau_3");
    rounds++;
    const nextAfter = ["pgau_1", "pgau_3", "pgau_4"][rounds - 1];
    return new Response(
      JSON.stringify({
        scanned: rounds === 3 ? 1 : 2,
        repaired: rounds === 3 ? 1 : 2,
        missingOrMismatched: 0,
        conflicts: 0,
        nextAfter,
        maybeMore: rounds < 3,
      }),
      { status: 200 },
    );
  },
  async sleep(ms) {
    slept.push(ms);
  },
  async receipt(v) {
    receipts.push(v);
  },
});
assert.deepEqual(result, {
  batches: 3,
  scanned: 5,
  repaired: 5,
  missingOrMismatched: 0,
  conflicts: 0,
  nextAfter: "pgau_4",
});
assert.deepEqual(slept, [15_000, 15_000]);
assert.equal(receipts.length, 6);
assert.equal(receipts.filter((x) => x.phase === "started").length, 3);
assert.equal(receipts.filter((x) => x.phase === "complete").length, 3);
assert.ok(!JSON.stringify(receipts).includes(secret), "Never persist bearer secrets in receipts");

const interrupted = [];
let count = 0;
await assert.rejects(
  runBackfill(
    { ...cfg, maxBatches: 3 },
    {
      async send() {
        count++;
        return new Response("D1 overloaded", { status: 503 });
      },
      async receipt(v) {
        interrupted.push(v);
      },
      async sleep() {
        throw Error("Should not retry");
      },
    },
  ),
  /non-200/,
);
assert.equal(count, 1, "No retry during overload, permissions failures or downtime");
assert.deepEqual(
  interrupted.map((x) => x.phase),
  ["started", "error"],
);
assert.equal(interrupted[1].status, 503);
await assert.rejects(
  runBackfill(
    { ...cfg, maxBatches: 1 },
    {
      async send() {
        return new Response(
          JSON.stringify({
            scanned: 2,
            repaired: 2,
            missingOrMismatched: 0,
            conflicts: 0,
            nextAfter: "",
            maybeMore: true,
          }),
          { status: 200 },
        );
      },
      async receipt() {},
    },
  ),
  /inconsistent/,
  "A nonadvancing cursor cannot silently replay a backfill",
);
console.log(
  "Bounded, journaled operator repair, idempotent cursor and overload abort gates passed.",
);
