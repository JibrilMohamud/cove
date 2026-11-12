/**
 * Diagnostic-only: phase release acceptance always uses header TTFB and
 * exact scheduled/valid/dropped counts. Body completion matters because the
 * bounded load generator does not release a slot until response.text() ends.
 * Never filter failed responses or reclassify delayed bodies as successes.
 */
export function responseCompletionSummary(rows) {
  const completion = rows
    .map((row) => row.completeMs)
    .filter((value) => Number.isFinite(value) && value >= 0)
    .sort((a, b) => a - b);
  const drain = rows
    .map((row) => row.bodyDrainMs)
    .filter((value) => Number.isFinite(value) && value >= 0)
    .sort((a, b) => a - b);
  const percentile = (values, fraction) =>
    values[Math.max(0, Math.ceil(values.length * fraction) - 1)] ?? null;
  const total = (field) =>
    rows.reduce(
      (sum, row) => sum + (Number.isFinite(row[field]) && row[field] >= 0 ? row[field] : 0),
      0,
    );
  return {
    received: rows.length,
    completed: completion.length,
    drained: drain.length,
    incomplete: rows.length - completion.length,
    completionP95Ms: percentile(completion, 0.95),
    completionP99Ms: percentile(completion, 0.99),
    completionMaxMs: completion.at(-1) ?? null,
    bodyDrainP95Ms: percentile(drain, 0.95),
    bodyDrainP99Ms: percentile(drain, 0.99),
    bodyDrainMaxMs: drain.at(-1) ?? null,
    wireBytes: total("wireBytes"),
    decodedBytes: total("decodedBytes"),
    slowBodyOver100Ms: drain.filter((value) => value > 100).length,
    slowBodyOver500Ms: drain.filter((value) => value > 500).length,
  };
}
