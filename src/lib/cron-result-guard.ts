/** A scheduled task that explicitly reports failure must never be acknowledged
 * as successful merely because its Promise resolved. */
export function assertCronResult<T>(result: T): T {
  if (
    result !== null &&
    typeof result === "object" &&
    (("ok" in result && (result as { ok?: unknown }).ok === false) ||
      ("failed" in result &&
        ((result as { failed?: unknown }).failed === true ||
          (typeof (result as { failed?: unknown }).failed === "number" &&
            Number((result as { failed?: unknown }).failed) > 0))))
  ) {
    throw Error("cove_scheduled_operation_reported_failure");
  }
  return result;
}

/** Rejected parallel scheduled jobs must remain observable as a failed cron,
 * even if other jobs completed. Errors are intentionally not surfaced here:
 * upstream exceptions can contain secrets, tokens or private request data. */
export function assertCronSettled(settled: PromiseSettledResult<unknown>[]): void {
  if (settled.some((task) => task.status === "rejected")) {
    throw Error("cove_scheduled_parallel_tasks_failed");
  }
  for (const task of settled) {
    if (task.status === "fulfilled") assertCronResult(task.value);
  }
}
