import { coveServiceWorkerReady } from "./service-worker";

/** A successful book save also prepares a complete public offline reader shell. */
export async function ensureOfflineReaderReady() {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator))
    throw Error(
      "This browser cannot prepare offline reading. You can still download the EPUB file.",
    );
  const registration = await coveServiceWorkerReady();
  for (const key of (await caches.keys()).filter((k) => k.startsWith("cove-shell-")))
    if (await (await caches.open(key)).match("/offline.html")) return registration;
  throw Error("The offline reader is not ready. Stay online and try saving again.");
}
