/** A successful book save also prepares a complete public offline reader shell. */
export async function ensureOfflineReaderReady() {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator))
    throw Error(
      "This browser cannot prepare offline reading. You can still download the EPUB file.",
    );
  const registration = await navigator.serviceWorker.register("/sw.js");
  let timeout: ReturnType<typeof setTimeout>;
  const wait = async () => {
    await navigator.serviceWorker.ready;
    if (registration.installing)
      await new Promise<void>((resolve, reject) => {
        const worker = registration.installing!;
        const changed = () => {
          if (worker.state === "installed" || worker.state === "activated") {
            worker.removeEventListener("statechange", changed);
            resolve();
          } else if (worker.state === "redundant") {
            worker.removeEventListener("statechange", changed);
            reject(Error("Offline reader installation failed."));
          }
        };
        worker.addEventListener("statechange", changed);
        changed();
      });
    const keys = await caches.keys();
    for (const key of keys.filter((k) => k.startsWith("cove-shell-")))
      if (await (await caches.open(key)).match("/offline.html")) return;
    throw Error(
      "The book is saved, but the offline reader is not ready. Stay online and try saving again.",
    );
  };
  try {
    await Promise.race([
      wait(),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () =>
            reject(
              Error(
                "The offline reader could not finish preparing. Stay online and try saving again.",
              ),
            ),
          30000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timeout!);
  }
}
