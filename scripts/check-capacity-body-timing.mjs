import assert from "node:assert/strict";
import { measureCompleteStageResponse } from "./performance/complete-response-timing.mjs";
import { projectedRequestFailure } from "./performance/capacity-release-gate.mjs";

let clock = 1000;
let deliver;
const pending = new Promise((resolve) => {
  deliver = resolve;
});
const completion = measureCompleteStageResponse({ text: () => pending }, 900, () => clock);
await Promise.resolve();
clock = 1740;
deliver("complete-book-body");
const completed = await completion;
assert.equal(completed.firstHeadersMs, 100);
assert.equal(completed.ms, 840);
assert.equal(completed.body, "complete-book-body");
assert.equal(
  projectedRequestFailure({ ok: true, status: 200, ms: completed.ms }),
  "request-max-800ms",
  "A sub-800ms TTFB cannot mask a greater-than-800ms full-body response",
);

const fast = await measureCompleteStageResponse({ text: async () => "ok" }, 0, () => 20);
assert.equal(projectedRequestFailure({ ok: true, status: 200, ms: fast.ms }), null);
await assert.rejects(
  measureCompleteStageResponse(
    {
      text: async () => {
        throw Error("truncated_stream");
      },
    },
    0,
    () => 8,
  ),
  /truncated_stream/,
  "Truncated body must not count as valid HTTP 200",
);
await assert.rejects(
  measureCompleteStageResponse(
    {
      text: async () => "ok",
    },
    100,
    () => 0,
  ),
  /invalid_stage_delivery_clock/,
);
console.log(
  "PASS: strict capacity gate times fully decoded body; headers-only success, truncated body, and invalid clocks fail closed",
);
