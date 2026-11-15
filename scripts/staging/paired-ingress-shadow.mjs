/**
 * Private synthetic staging only. The 100-RPS cursor requests and low-rate
 * driver-only controls are launched in the SAME phase from the SAME runner.
 * Do not save raw observations, monotonic timestamps, tokens or request IDs.
 * A nearby control is an observational comparison, not causal proof.
 */
const finite = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0;
const round = (value) => (finite(value) ? Math.round(value * 100) / 100 : null);
function quantile(values, fraction) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return round(sorted[Math.ceil(sorted.length * fraction) - 1]);
}

export function pairedIngressShadowEvidence(targetRows, controlRows, expectedControls) {
  if (
    !Array.isArray(targetRows) ||
    !Array.isArray(controlRows) ||
    !Number.isSafeInteger(expectedControls) ||
    expectedControls < 1
  )
    throw new Error("Invalid synthetic shadow control inputs");
  const valid = controlRows.filter((row) => row.valid === true).length;
  const dropped = controlRows.filter((row) => row.dropped === true).length;
  const timings = controlRows.map((row) => row.firstByteMs).filter(finite);
  const max = quantile(timings, 1);
  const p95 = quantile(timings, 0.95);
  const p99 = quantile(timings, 0.99);
  const worst = targetRows
    .filter((row) => finite(row.firstByteMs) && finite(row.phaseOffsetMs))
    .reduce((best, row) => (!best || row.firstByteMs > best.firstByteMs ? row : best), null);
  const nearby = worst
    ? controlRows.filter(
        (row) =>
          finite(row.firstByteMs) &&
          finite(row.phaseOffsetMs) &&
          Math.abs(row.phaseOffsetMs - worst.phaseOffsetMs) <= 1000,
      )
    : [];
  const nearest = worst
    ? controlRows
        .filter((row) => finite(row.firstByteMs) && finite(row.phaseOffsetMs))
        .reduce(
          (best, row) =>
            !best ||
            Math.abs(row.phaseOffsetMs - worst.phaseOffsetMs) <
              Math.abs(best.phaseOffsetMs - worst.phaseOffsetMs)
              ? row
              : best,
          null,
        )
    : null;
  return {
    expected: expectedControls,
    offered: controlRows.length,
    valid,
    failed: controlRows.length - valid,
    dropped,
    p95Ms: p95,
    p99Ms: p99,
    maxMs: max,
    atOrAbove800Ms: timings.filter((ms) => ms >= 800).length,
    nearSlowestCursorWindowMs: 1000,
    nearSlowestCursorControlCount: nearby.length,
    nearSlowestCursorControlMaxMs: quantile(
      nearby.map((row) => row.firstByteMs),
      1,
    ),
    nearestControlTtfbMs: round(nearest?.firstByteMs),
    nearestControlScheduledSeparationMs:
      nearest && worst ? round(Math.abs(nearest.phaseOffsetMs - worst.phaseOffsetMs)) : null,
    passed:
      controlRows.length === expectedControls &&
      valid === expectedControls &&
      dropped === 0 &&
      timings.length === expectedControls &&
      p95 !== null &&
      p95 < 600 &&
      p99 !== null &&
      p99 < 750 &&
      max !== null &&
      max < 800,
  };
}
