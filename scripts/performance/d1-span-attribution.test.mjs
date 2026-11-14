import test from "node:test";
import assert from "node:assert/strict";
import {
  percentile,
  attributePairedD1Spans,
  architectureReviewCheckpoint,
} from "./d1-span-attribution.mjs";

test("paired wall-minus-SQL attribution retains long service waits", () => {
  const spans = Array.from({ length: 100 }, (_, i) => ({
    spanMs: i < 95 ? 100 : 2000,
    sqlMs: i < 95 ? 5 : 10,
  }));
  const result = attributePairedD1Spans(spans);
  assert.equal(result.evidence, "descriptive");
  assert.equal(result.sampleCount, 100);
  assert.equal(result.outsideSql.p99Ms, 1990);
  assert.equal(result.wall.p95Ms, 100);
  assert.equal(result.sql.p99Ms, 10);
  assert.equal(result.releaseCertified, false);
  assert.ok(result.outsideSqlShare > 0.9);
});

test("rejects malformed and nonpaired spans without silently inventing data", () => {
  const res = attributePairedD1Spans([{ spanMs: 2, sqlMs: 3 }, { spanMs: 15, sqlMs: 4 }]);
  assert.equal(res.evidence, "limited");
  assert.equal(res.sampleCount, 1);
  assert.equal(res.rejected, 1);
  assert.equal(res.outsideSql.p95Ms, 11);
  assert.equal(attributePairedD1Spans([]).evidence, "insufficient");
  assert.equal(percentile([1, 2, 3, 4], 0.95), 4);
});

test("two ineffective iterations on the same subsystem trigger a redesign review", () => {
  const iterations = [
    { type: "optimization", subsystem: "primary-d1", outcome: "no-meaningful-improvement" },
    { type: "optimization", subsystem: "primary-d1", outcome: "inconclusive" },
  ];
  assert.deepEqual(architectureReviewCheckpoint(iterations), {
    architectureReviewRequired: true,
    ineffectiveSinceReview: 2,
    reason: "two-ineffective-iterations-same-subsystem",
  });
});

test("three ineffective iterations across subsystems require review; evidence of real review resets", () => {
  const attempts = ["primary-d1", "r2", "worker-runtime"].map((subsystem) => ({
    type: "optimization", subsystem, outcome: "no-meaningful-improvement",
  }));
  assert.equal(architectureReviewCheckpoint(attempts).reason, "three-ineffective-iterations");
  assert.equal(architectureReviewCheckpoint([...attempts, { type: "architecture-review" }]).architectureReviewRequired, true);
  const reviewed = [...attempts, {
    type: "architecture-review",
    alternatives: ["optimize", "restructure", "replace"],
    decision: "Test fewer primary service round trips under identical load before rollout",
    evidence: "docs/performance/2026-11-14-causal-architecture-review.md",
  }];
  assert.equal(architectureReviewCheckpoint(reviewed).architectureReviewRequired, false);
  assert.equal(architectureReviewCheckpoint([...attempts.slice(0, 2), {type:"optimization",subsystem:"r2",outcome:"meaningful-improvement"},attempts[2]]).architectureReviewRequired,false);
});
