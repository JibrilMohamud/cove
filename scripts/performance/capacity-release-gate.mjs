/**
 * Absolute request gates. No percentile or warm-up allowance can override
 * an invalid response, a dropped arrival, or an >=800ms projected request.
 * Keep this pure so the release scheduler and regression tests agree.
 */
export function projectedRequestFailure(row) {
  if (!row || row.ok !== true) return "invalid-response";
  if (!Number.isFinite(row.ms)) return "invalid-duration";
  if (row.ms >= 800) return "request-max-800ms";
  return null;
}

export function strictProjectionPhasePass(phase) {
  return (
    phase.model === "projection" &&
    phase.offered === 12000 &&
    phase.total === 12000 &&
    phase.valid === 12000 &&
    phase.dropped === 0 &&
    phase.cancelledUnsent === 0 &&
    phase.earlyStopped !== true &&
    phase.p95 < 600 &&
    phase.p99 < 750 &&
    phase.max < 800 &&
    phase.transportControls.valid === phase.transportControls.total &&
    phase.transportControls.max < 800 &&
    phase.background.every((row) => row.ok === true)
  );
}
