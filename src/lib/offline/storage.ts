/**
 * Minimal key/value persistence for the offline folder handle. CLIENT-ONLY.
 *
 * WHY AN ABSTRACTION AND NOT IndexedDB DIRECTLY. The only thing Aurora
 * persists for offline audio is one `FileSystemDirectoryHandle`, which is
 * structured-cloneable but NOT JSON-serializable. Storing it needs IndexedDB,
 * and the repository's quality gate bans browser storage APIs in production
 * source (`quality-gates.test.ts`), so this module is the single audited
 * exception — and an audited exception should be small and mechanically
 * testable. Everything above this file speaks `OfflineKeyValueStore`, which a
 * 10-line Map fake satisfies, so the persistence logic is tested without a
 * browser or a new dev dependency.
 *
 * NO AUDIO EVER PASSES THROUGH HERE. Only a directory handle. The audio bytes
 * stay in the user's own file, read on demand, and are never uploaded,
 * cached, or proxied.
 */

export interface OfflineKeyValueStore {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
}

/** In-memory store. Used by tests, and as the fallback when IDB is absent. */
export function createMemoryStore(): OfflineKeyValueStore {
  const map = new Map<string, unknown>();
  return {
    async get(key) {
      return map.get(key);
    },
    async set(key, value) {
      map.set(key, value);
    },
    async delete(key) {
      map.delete(key);
    },
  };
}

const DATABASE_NAME = "aurora-offline";
const DATABASE_VERSION = 1;
const STORE_NAME = "handles";

function promisifyRequest<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
  });
}

function promisifyTransaction(transaction: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB transaction failed"));
    transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB transaction aborted"));
  });
}

function openDatabase(idb: IDBFactory): Promise<IDBDatabase> {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = idb.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB open failed"));
    request.onblocked = () => reject(new Error("IndexedDB open blocked"));
  });
}

/**
 * The store the application uses in the browser.
 *
 * Falls back to memory when IndexedDB is missing (private windows, a locked
 * down profile). The consequence is narrow and stated rather than hidden: the
 * folder still works for this page load, it just is not remembered next time —
 * which is exactly the "nothing stored" state the page already renders.
 */
export function defaultOfflineStore(): OfflineKeyValueStore {
  if (typeof window === "undefined") {
    return createMemoryStore();
  }
  const idb = (window as unknown as { indexedDB?: IDBFactory }).indexedDB;
  return idb ? createIndexedDbStore(idb) : createMemoryStore();
}

/**
 * IndexedDB-backed store. `onupgradeneeded` is only needed to create the
 * object store; every other operation runs in a single readwrite transaction so
 * a write is atomic and a failed read cannot leave a half-applied value.
 */
export function createIndexedDbStore(idb: IDBFactory): OfflineKeyValueStore {
  return {
    async get(key) {
      const db = await openDatabase(idb);
      try {
        const transaction = db.transaction(STORE_NAME, "readonly");
        const value = await promisifyRequest(transaction.objectStore(STORE_NAME).get(key));
        return value;
      } finally {
        db.close();
      }
    },
    async set(key, value) {
      const db = await openDatabase(idb);
      try {
        const transaction = db.transaction(STORE_NAME, "readwrite");
        transaction.objectStore(STORE_NAME).put(value, key);
        await promisifyTransaction(transaction);
      } finally {
        db.close();
      }
    },
    async delete(key) {
      const db = await openDatabase(idb);
      try {
        const transaction = db.transaction(STORE_NAME, "readwrite");
        transaction.objectStore(STORE_NAME).delete(key);
        await promisifyTransaction(transaction);
      } finally {
        db.close();
      }
    },
  };
}