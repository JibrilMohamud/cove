/** Prepare browser capabilities only after a reader requests them. */
export async function coveServiceWorkerReady(timeoutMs = 30_000) {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator))
    throw Error("This browser does not support Cove's offline and notification features.");
  let timeout: ReturnType<typeof setTimeout>;
  let cleanup = () => {};
  let finished = false;
  try {
    return await Promise.race([
      (async () => {
        const registration = await navigator.serviceWorker.register("/sw.js");
        if (finished) throw Error("Cove's browser setup timed out. Reconnect and try again.");
        const worker = registration.installing;
        if (worker)
          await new Promise<void>((resolve, reject) => {
            const changed = () => {
              if (worker.state === "installed" || worker.state === "activated") {
                cleanup();
                resolve();
              } else if (worker.state === "redundant") {
                cleanup();
                reject(Error("Cove's browser setup failed. Reconnect and try again."));
              }
            };
            cleanup = () => worker.removeEventListener("statechange", changed);
            worker.addEventListener("statechange", changed);
            changed();
          });
        await navigator.serviceWorker.ready;
        return registration;
      })(),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(Error("Cove's browser setup timed out. Reconnect and try again.")),
          Math.max(1, Math.min(30_000, timeoutMs)),
        );
      }),
    ]);
  } finally {
    finished = true;
    clearTimeout(timeout!);
    cleanup();
  }
}
