// Stage-only timing analysis. Never record request URLs, tokens, client IPs,
// book identifiers, query strings, raw errors or per-request diagnostic traces.
// All three durations come from THE SAME already-measured request.
const finiteDuration = (value) => Number.isFinite(value) && value >= 0;
const ms = (value) => (finiteDuration(value) ? Math.round(value * 100) / 100 : null);
const maximum = (values) => (values.length ? Math.max(...values) : null);

export function strictTtfbTailAttribution(rows, ceilingMs = 800) {
  if (!Array.isArray(rows) || !Number.isFinite(ceilingMs) || ceilingMs <= 0)
    throw new Error("Invalid synthetic TTFB attribution input");
  const measured = rows.filter((row) => finiteDuration(row.firstByteMs));
  const slow = measured.filter((row) => row.firstByteMs >= ceilingMs);
  const fastestMax = measured.reduce(
    (previous, row) => (!previous || row.firstByteMs > previous.firstByteMs ? row : previous),
    null,
  );
  const workerMeasured = slow.filter((row) => finiteDuration(row.workerMs));
  const candidateMeasured = slow.filter((row) => finiteDuration(row.downstreamFirstByteMs));
  const driverExceeded = workerMeasured.filter((row) => row.workerMs >= ceilingMs).length;
  const driverBelow = workerMeasured.length - driverExceeded;
  const paired = fastestMax && finiteDuration(fastestMax.workerMs) ? fastestMax : null;

  return {
    thresholdMs: ceilingMs,
    observedAtOrAboveCount: slow.length,
    validAtOrAboveCount: slow.filter((row) => row.valid === true).length,
    invalidAtOrAboveCount: slow.filter((row) => row.valid !== true).length,
    driverAtOrAboveCount: driverExceeded,
    driverBelowCount: driverBelow,
    driverUnmeasuredCount: slow.length - workerMeasured.length,
    candidateTimingObservedCount: candidateMeasured.length,
    maxDriverWorkerMs: ms(maximum(measured.map((r) => r.workerMs).filter(finiteDuration))),
    maxCandidateFirstByteMs: ms(
      maximum(measured.map((r) => r.downstreamFirstByteMs).filter(finiteDuration)),
    ),
    maxStageR2Ms: ms(maximum(measured.map((r) => r.stageR2Ms).filter(finiteDuration))),
    maxStageCursorMs: ms(maximum(measured.map((r) => r.stageCursorMs).filter(finiteDuration))),
    maxStagePrimaryMs: ms(maximum(measured.map((r) => r.stagePrimaryMs).filter(finiteDuration))),
    maxStageAssemblyMs: ms(maximum(measured.map((r) => r.stageAssemblyMs).filter(finiteDuration))),
    slowestRequestPaired: fastestMax
      ? {
          externalFirstByteMs: ms(fastestMax.firstByteMs),
          driverWorkerMs: ms(fastestMax.workerMs),
          candidateFirstByteMs: ms(fastestMax.downstreamFirstByteMs),
          stageR2Ms: ms(fastestMax.stageR2Ms),
          stageCursorMs: ms(fastestMax.stageCursorMs),
          stagePrimaryMs: ms(fastestMax.stagePrimaryMs),
          stageAssemblyMs: ms(fastestMax.stageAssemblyMs),
          // A paired difference, NOT a subtraction of distinct percentile
          // distributions. Includes transport + scheduling; not cause proof.
          externalMinusDriverMs: paired
            ? ms(Math.max(0, paired.firstByteMs - paired.workerMs))
            : null,
          validResponse: fastestMax.valid === true,
        }
      : null,
  };
}
