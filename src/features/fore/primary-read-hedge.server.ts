import type { CoveRequestExecution } from "@/lib/cove-request-env.server";

/** One delayed duplicate of an idempotent primary read, never a replica/cache.
 * Fast reads and runtimes without a real request lifecycle issue one query.
 * A primary rejection remains a rejection; a failed duplicate cannot mask it.
 */
export async function primaryReadWithHedge<T>(
  read: () => Promise<T>,
  options: {
    execution?: CoveRequestExecution;
    allowDuplicate: () => Promise<boolean>;
    delayMs?: number;
  },
): Promise<{ value: T; duplicated: boolean }> {
  let finished = false;
  let duplicated = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const primary = read();
  if (!options.execution) return { value: await primary, duplicated };
  const execution = options.execution;
  const duplicate = new Promise<T>((resolve) => {
    timer = setTimeout(() => {
      const work = (async () => {
        if (finished || !(await options.allowDuplicate()) || finished) return;
        duplicated = true;
        try {
          resolve(await read());
        } catch {
          // Keep awaiting the original primary read. An extra request must
          // never turn a successful original into an availability failure.
        }
      })();
      execution.waitUntil(work.catch(() => {}));
    }, options.delayMs ?? 150);
  });
  // D1 does not expose cancellation. Retain and handle the losing query so
  // the Worker can finish its bounded work after the response is returned.
  execution.waitUntil(
    primary.then(
      () => undefined,
      () => undefined,
    ),
  );
  try {
    return { value: await Promise.race([primary, duplicate]), duplicated };
  } finally {
    finished = true;
    if (timer !== undefined) clearTimeout(timer);
  }
}
