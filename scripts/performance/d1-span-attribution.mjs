/**
 * Offline, request-safe performance attribution for Cloudflare D1 operation spans.
 * Input MUST contain paired wall/SQL timings from the same span. Aggregated
 * percentiles cannot be subtracted to infer a wait-time percentile.
 *
 * This diagnostic does not establish causality for any specific platform queue,
 * and does not replace customer-facing TTFB, rights, or sustained-load gates.
 */
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export function percentile(values, fraction) {
  if (!values.length) return null;
  if (!Number.isFinite(fraction) || fraction <= 0 || fraction > 1)
    throw new RangeError("Percentile must lie in (0, 1]");
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(sorted.length * fraction) - 1];
}

function summary(values) {
  return {
    meanMs: values.reduce((sum, value) => sum + value, 0) / values.length,
    p50Ms: percentile(values, 0.5),
    p95Ms: percentile(values, 0.95),
    p99Ms: percentile(values, 0.99),
    maxMs: Math.max(...values),
  };
}

export function attributePairedD1Spans(spans, { minimumSamples = 30 } = {}) {
  if (!Array.isArray(spans) || spans.length === 0)
    return { evidence: "insufficient", reason: "no-paired-spans", sampleCount: 0 };
  const pairs = [];
  let rejected = 0;
  for (const span of spans) {
    const wallMs = span?.spanMs;
    const sqlMs = span?.sqlMs;
    if (
      !Number.isFinite(wallMs) ||
      !Number.isFinite(sqlMs) ||
      wallMs < 0 ||
      sqlMs < 0 ||
      sqlMs > wallMs
    ) {
      rejected++;
      continue;
    }
    pairs.push({ wallMs, sqlMs, outsideSqlMs: wallMs - sqlMs });
  }
  if (!pairs.length)
    return { evidence: "insufficient", reason: "no-valid-pairs", sampleCount: 0, rejected };
  const wall = summary(pairs.map((p) => p.wallMs));
  const sql = summary(pairs.map((p) => p.sqlMs));
  const outsideSql = summary(pairs.map((p) => p.outsideSqlMs));
  const outsideSqlShare = outsideSql.meanMs / wall.meanMs;
  return {
    evidence: rejected === 0 && pairs.length >= minimumSamples ? "descriptive" : "limited",
    sampleCount: pairs.length,
    rejected,
    // These are PER-SPAN paired differences, NOT a difference of percentiles.
    wall,
    sql,
    outsideSql,
    outsideSqlShare: Number.isFinite(outsideSqlShare) ? outsideSqlShare : null,
    interpretation:
      "Outside-SQL time includes transport, service scheduling, queueing and other non-SQL overhead; this cannot identify one of them as the cause.",
    releaseCertified: false,
  };
}

/** Two ineffective measured iterations in the same architecture, or three
 * ineffective iterations overall, require a documented architectural review.
 * An inconclusive measurement does not count as an improvement. */
export function architectureReviewCheckpoint(iterations) {
  if (!Array.isArray(iterations)) throw new TypeError("Iterations must be an array");
  let sinceReview = [];
  for (const iteration of iterations) {
    if (iteration?.type === "architecture-review") {
      // A genuine review compares alternatives, cites evidence and records the decision.
      if (
        Array.isArray(iteration.alternatives) &&
        iteration.alternatives.length >= 3 &&
        typeof iteration.decision === "string" &&
        iteration.decision.trim() &&
        typeof iteration.evidence === "string" &&
        iteration.evidence.trim()
      )
        sinceReview = [];
      continue;
    }
    if (iteration?.type === "optimization") sinceReview.push(iteration);
  }
  const trailing = [];
  for (let i = sinceReview.length - 1; i >= 0; i--) {
    if (sinceReview[i].outcome === "meaningful-improvement") break;
    trailing.push(sinceReview[i]);
  }
  const sameSubsystem =
    trailing.length >= 2 &&
    trailing[0].subsystem &&
    trailing[0].subsystem === trailing[1].subsystem;
  return {
    architectureReviewRequired: sameSubsystem || trailing.length >= 3,
    ineffectiveSinceReview: trailing.length,
    reason: sameSubsystem
      ? "two-ineffective-iterations-same-subsystem"
      : trailing.length >= 3
        ? "three-ineffective-iterations"
        : null,
    // No automated p95 improvement claim: reviewers must provide comparable
    // baseline/candidate evidence and account for p99, max, failures and drops.
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const file = process.argv[2];
  if (!file) {
    console.error("Usage: node scripts/performance/d1-span-attribution.mjs paired-spans.json");
    process.exitCode = 2;
  } else {
    try {
      const spans = JSON.parse(readFileSync(file, "utf8"));
      console.log(JSON.stringify(attributePairedD1Spans(spans), null, 2));
    } catch (error) {
      console.error(
        "Invalid D1 span evidence:",
        error instanceof SyntaxError ? "invalid-json" : "unreadable-or-invalid-file",
      );
      process.exitCode = 1;
    }
  }
}
