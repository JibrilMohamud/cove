const DB_NAME = "fore-offline-v2";
const stores = ["downloads", "assets", "outbox"];
let connection: Promise<IDBDatabase> | null = null;
function db() {
  if (!connection)
    connection = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () =>
        stores.forEach((name) => request.result.createObjectStore(name, { keyPath: "id" }));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  return connection;
}
export async function putRecord(store: string, value: any) {
  const d = await db();
  return new Promise<void>((resolve, reject) => {
    const tx = d.transaction(store, "readwrite");
    tx.objectStore(store).put(value);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}
export async function getRecord<T = any>(store: string, id: string): Promise<T | undefined> {
  const d = await db();
  return new Promise((resolve, reject) => {
    const r = d.transaction(store).objectStore(store).get(id);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
export async function getRecords<T = any>(store: string): Promise<T[]> {
  const d = await db();
  return new Promise((resolve, reject) => {
    const r = d.transaction(store).objectStore(store).getAll();
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
export async function deleteRecord(store: string, id: string) {
  const d = await db();
  return new Promise<void>((resolve, reject) => {
    const tx = d.transaction(store, "readwrite");
    tx.objectStore(store).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
export async function removeDownload(id: string) {
  const record = await getRecord("downloads", id);
  const others=(await getRecords("downloads")).filter(r=>r.id!==id);
  for(const key of record?.assetIds||[])if(!others.some(r=>r.assetIds?.includes(key)))await deleteRecord("assets",key);
  await deleteRecord("downloads", id);
}
export const sha256 = async (bytes: ArrayBuffer) =>
  Array.from(crypto.subtle ? new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)) : (await import("@noble/hashes/sha2.js")).sha256(new Uint8Array(bytes)))
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
