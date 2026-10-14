import { getRecord } from "./offline";
import { offlineAccountId, putOwnedRecord } from "./offline-account";

export type CachedReaderPosition = {
  id: string;
  ownerId: string;
  bookId: string;
  cfi: string;
  progress: number;
  version: number;
  updatedAt: string;
};
const key = (ownerId: string, bookId: string) => `reader-position:${ownerId}:${bookId}`;
export async function cachedReaderPosition(ownerId: string, bookId: string) {
  if (!ownerId || offlineAccountId() !== ownerId) return null;
  const value = await getRecord<CachedReaderPosition>("assets", key(ownerId, bookId));
  return value?.ownerId === ownerId && value.bookId === bookId ? value : null;
}
export async function saveCachedReaderPosition(
  ownerId: string,
  bookId: string,
  value: Pick<CachedReaderPosition, "cfi" | "progress" | "version">,
) {
  if (!ownerId || offlineAccountId() !== ownerId) return;
  await putOwnedRecord("assets", {
    id: key(ownerId, bookId),
    ownerId,
    bookId,
    cfi: value.cfi,
    progress: Math.max(0, Math.min(1, value.progress)),
    version: Math.max(0, value.version),
    updatedAt: new Date().toISOString(),
  });
}
