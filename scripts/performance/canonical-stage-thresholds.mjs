// Single reviewed contract for both the protected live probe and independent
// numeric-only evidence verifier. Never infer a pass from an artifact's
// self-reported status, or relax the hard 800ms bound for any sample.
export const CANONICAL_STAGE_THRESHOLDS = Object.freeze({
  maxTtfbMs: 800,
  p95TtfbMs: 650,
});

export function canonicalStageP95Limit(concurrency) {
  if (![1, 4, 8, 16].includes(concurrency))
    throw new Error("Unknown protected stage concurrency");
  return concurrency <= 8
    ? CANONICAL_STAGE_THRESHOLDS.p95TtfbMs
    : CANONICAL_STAGE_THRESHOLDS.maxTtfbMs;
}
