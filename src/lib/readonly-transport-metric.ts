/** Numeric-only, request-local staging D1 timing; never an identity or authorization signal. */
export function boundedReadonlyPhaseMs(from: number, to: number): number | undefined {
  const elapsed = to - from;
  return Number.isFinite(from) &&
    Number.isFinite(to) &&
    Number.isFinite(elapsed) &&
    elapsed >= 0 &&
    elapsed <= 12_000
    ? Math.round(elapsed * 10) / 10
    : undefined;
}

export function verifiedReadonlyPhaseMs(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 12_000
    ? value
    : undefined;
}
