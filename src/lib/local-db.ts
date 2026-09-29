const DB_NAME = "fore-reading-v1";
const DB_VERSION = 1;

export type StoreName =
  "library" | "highlights" | "bookmarks" | "sessions" | "contents" | "shelves" | "settings";

let dbPromise: Promise<IDBDatabase> | null = null;

function openDatabase(): Promise<IDBDatabase> {
  if (typeof window === "undefined" || !("indexedDB" in window)) {
    return Promise.reject(new Error("IndexedDB is unavailable"));
  }
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;

      if (!db.objectStoreNames.contains("library")) {
        const store = db.createObjectStore("library", { keyPath: "bookId" });
        store.createIndex("status", "status", { unique: false });
        store.createIndex("updatedAt", "updatedAt", { unique: false });
        store.createIndex("lastReadAt", "lastReadAt", { unique: false });
      }

      if (!db.objectStoreNames.contains("highlights")) {
        const store = db.createObjectStore("highlights", { keyPath: "id" });
        store.createIndex("bookId", "bookId", { unique: false });
        store.createIndex("updatedAt", "updatedAt", { unique: false });
      }

      if (!db.objectStoreNames.contains("bookmarks")) {
        const store = db.createObjectStore("bookmarks", { keyPath: "id" });
        store.createIndex("bookId", "bookId", { unique: false });
        store.createIndex("updatedAt", "updatedAt", { unique: false });
      }

      if (!db.objectStoreNames.contains("sessions")) {
        const store = db.createObjectStore("sessions", { keyPath: "id" });
        store.createIndex("bookId", "bookId", { unique: false });
        store.createIndex("startedAt", "startedAt", { unique: false });
      }

      if (!db.objectStoreNames.contains("contents")) {
        db.createObjectStore("contents", { keyPath: "bookId" });
      }

      if (!db.objectStoreNames.contains("shelves")) {
        const store = db.createObjectStore("shelves", { keyPath: "id" });
        store.createIndex("updatedAt", "updatedAt", { unique: false });
      }

      if (!db.objectStoreNames.contains("settings")) {
        db.createObjectStore("settings", { keyPath: "key" });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Could not open IndexedDB"));
    request.onblocked = () => reject(new Error("IndexedDB upgrade was blocked"));
  });

  return dbPromise;
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () =>
      reject(transaction.error ?? new Error("IndexedDB transaction failed"));
    transaction.onabort = () =>
      reject(transaction.error ?? new Error("IndexedDB transaction aborted"));
  });
}

export async function dbGet<T>(storeName: StoreName, key: IDBValidKey): Promise<T | undefined> {
  try {
    const db = await openDatabase();
    const tx = db.transaction(storeName, "readonly");
    const value = await requestResult(tx.objectStore(storeName).get(key));
    await transactionDone(tx);
    return value as T | undefined;
  } catch {
    return undefined;
  }
}

export async function dbGetAll<T>(storeName: StoreName): Promise<T[]> {
  try {
    const db = await openDatabase();
    const tx = db.transaction(storeName, "readonly");
    const values = await requestResult(tx.objectStore(storeName).getAll());
    await transactionDone(tx);
    return values as T[];
  } catch {
    return [];
  }
}

export async function dbPut<T>(storeName: StoreName, value: T): Promise<void> {
  const db = await openDatabase();
  const tx = db.transaction(storeName, "readwrite");
  tx.objectStore(storeName).put(value);
  await transactionDone(tx);
}

export async function dbPutMany<T>(storeName: StoreName, values: T[]): Promise<void> {
  if (!values.length) return;
  const db = await openDatabase();
  const tx = db.transaction(storeName, "readwrite");
  const store = tx.objectStore(storeName);
  for (const value of values) store.put(value);
  await transactionDone(tx);
}

export async function dbDelete(storeName: StoreName, key: IDBValidKey): Promise<void> {
  const db = await openDatabase();
  const tx = db.transaction(storeName, "readwrite");
  tx.objectStore(storeName).delete(key);
  await transactionDone(tx);
}
