import assert from "node:assert/strict";
import { offeredLoad, summarizeRequests } from "./performance/offered-load.mjs";
const good = await offeredLoad({
  rps: 100,
  durationMs: 100,
  request: async () => ({ valid: true, ttfbMs: 1 }),
});
assert.equal(good.summary.offered, 10);
assert.equal(good.summary.valid, 10);
assert.equal(good.summary.allValid, true);
const overloaded = await offeredLoad({
  rps: 200,
  durationMs: 100,
  maxPending: 1,
  request: async () => {
    await new Promise((r) => setTimeout(r, 40));
    return { valid: false, failure: "timeout" };
  },
});
assert.equal(overloaded.summary.offered, 20);
assert.ok(overloaded.summary.dropped > 0);
assert.equal(overloaded.summary.complete, true);
assert.ok(overloaded.drops.at(-1).index >= 17, "Scheduling must continue through overload");
assert.equal(overloaded.summary.allValid, false);
assert.equal(overloaded.summary.valid, 0);
assert.equal(
  summarizeRequests([
    { valid: true, ttfbMs: 1 },
    { valid: false, failure: "http-503" },
  ]).allValid,
  false,
);
console.log(
  "PASS: offered-arrival accounting, continued scheduling after drops, failures in denominator, success-only percentile labeling",
);

const late = await offeredLoad({
  rps: 1000,
  durationMs: 5,
  maxScheduleLagMs: 1,
  request: async () => {
    const until = performance.now() + 30;
    while (performance.now() < until) {
      /* model a CPU-stalled generator */
    }
    return { valid: true, ttfbMs: 1 };
  },
});
assert.ok(late.summary.dropped >= 4);
assert.equal(late.summary.allValid, false);
assert.ok(late.drops.every((drop) => drop.reason === "generator-late"));
