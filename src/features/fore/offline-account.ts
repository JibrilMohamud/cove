import { getRecords, removeDownload, deleteRecord, putRecord } from "./offline";

const ACCOUNT_KEY = "cove:offline-account:v1";
/** Remembered identity is set only after a successful account response, never inferred from media. */
export function offlineAccountId() {
  if (typeof localStorage === "undefined") return "";
  try {
    return localStorage.getItem(ACCOUNT_KEY) || "";
  } catch {
    return "";
  }
}
export async function setOfflineAccount(userId: string | null) {
  const previous = offlineAccountId();
  if (typeof localStorage !== "undefined") {
    if (userId) localStorage.setItem(ACCOUNT_KEY, userId);
    else localStorage.removeItem(ACCOUNT_KEY);
  }
  if (previous !== (userId || "") && typeof window !== "undefined")
    window.dispatchEvent(new Event("cove-offline-account-change"));
  // Public Gutenberg downloads survive account changes. Private audio never does.
  if (previous !== (userId || "") || !userId) {
    for (const row of await getRecords("downloads"))
      if (
        (row.kind === "licensed-epub" || row.edition?.commercial || row.edition?.id?.startsWith("ca_")) &&
        (!offlineAccountId() || row.ownerId !== offlineAccountId())
      )
        await removeDownload(row.id);
    for (const row of await getRecords("assets"))
      if (
        (row.ownerId && row.ownerId !== offlineAccountId()) ||
        (/^audio:ca_|^offline-audio-key:/.test(row.id) && !row.ownerId)
      )
        await deleteRecord("assets", row.id);
  }
}
export function canUseOfflineFallback(error: unknown) {
  const status = error && typeof error === "object" && "status" in error ? Number(error.status) : 0;
  if (error instanceof DOMException && error.name === "AbortError") return false;
  return status === 0 || [502, 503, 504].includes(status);
}

/** Fence asynchronous download writes against logout or account changes. */
export async function putOwnedRecord(
  store: string,
  record: { id: string; ownerId: string; [key: string]: unknown },
) {
  if (!record.ownerId || offlineAccountId() !== record.ownerId)
    throw new Error("Your account changed. Sign in and save the recording again.");
  await putRecord(store, record);
  if (offlineAccountId() !== record.ownerId) {
    await deleteRecord(store, record.id);
    throw new Error("Your account changed. Sign in and save the recording again.");
  }
}
