import { performance } from "node:perf_hooks";
export function percentile(values, fraction) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.ceil(sorted.length * fraction) - 1] : null;
}
export function summarizeRequests(rows, offered = rows.length, dropped = 0) {
  const successful = rows.filter((row) => row.valid);
  const times = successful.map((row) => row.ttfbMs);
  return {
    offered,
    attempted: rows.length,
    valid: successful.length,
    invalid: rows.length - successful.length,
    dropped,
    complete: rows.length + dropped === offered,
    allValid: successful.length === offered && dropped === 0,
    successfulTtfb: {
      p50: percentile(times, 0.5),
      p75: percentile(times, 0.75),
      p95: percentile(times, 0.95),
      p99: percentile(times, 0.99),
      max: times.length ? Math.max(...times) : null,
    },
    // Timeouts and HTTP/content failures remain in the denominator and in raw rows.
    failureKinds: Object.fromEntries(
      [...new Set(rows.filter((r) => !r.valid).map((r) => r.failure))].map((kind) => [
        kind,
        rows.filter((r) => r.failure === kind).length,
      ]),
    ),
  };
}
/** Fixed offered arrivals. Capacity drops never terminate the remaining schedule. */
export async function offeredLoad({
  rps,
  durationMs,
  maxPending = 256,
  maxScheduleLagMs = 100,
  request,
}) {
  if (
    !Number.isFinite(rps) ||
    rps <= 0 ||
    !Number.isFinite(durationMs) ||
    durationMs <= 0 ||
    !Number.isInteger(maxPending) ||
    maxPending < 1 ||
    !Number.isFinite(maxScheduleLagMs) ||
    maxScheduleLagMs < 0
  )
    throw new Error("Invalid offered-load configuration");
  const offered = Math.floor((rps * durationMs) / 1000),
    started = performance.now();
  const rows = [],
    pending = new Set(),
    drops = [];
  for (let i = 0; i < offered; i++) {
    const scheduledMs = (i * 1000) / rps;
    const wait = started + scheduledMs - performance.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    const dispatchLagMs = Math.max(0, performance.now() - started - scheduledMs);
    if (dispatchLagMs > maxScheduleLagMs) {
      drops.push({ index: i, scheduledMs, dispatchLagMs, reason: "generator-late" });
      continue;
    }
    if (pending.size >= maxPending) {
      drops.push({ index: i, scheduledMs, dispatchLagMs, reason: "pending-capacity" });
      continue;
    }
    const work = Promise.resolve()
      .then(() => request(i))
      .then(
        (row) => rows.push({ index: i, scheduledMs, dispatchLagMs, ...row }),
        () =>
          rows.push({
            index: i,
            scheduledMs,
            dispatchLagMs,
            valid: false,
            failure: "client-exception",
          }),
      )
      .finally(() => pending.delete(work));
    pending.add(work);
  }
  await Promise.all(pending);
  rows.sort((a, b) => a.index - b.index);
  return {
    summary: summarizeRequests(rows, offered, drops.length),
    rows,
    drops,
    elapsedMs: performance.now() - started,
  };
}
