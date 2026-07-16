// Minimal promise-based IndexedDB wrapper. The web client keeps its notebook and
// all sync bookkeeping locally (mirroring the native SQLite database), so this
// is the single persistence primitive the storage + sync layers build on.

export type StoreName =
  | "meta" // key/value: identity, relay config, sync state
  | "notes"
  | "categories"
  | "noteRevisions" // note revision DAG nodes, keyed by revisionId
  | "categoryRevisions" // category revision DAG nodes, keyed by revisionId
  | "entityHeads" // "type:id" -> head revisionId, for conflict detection
  | "devices"
  | "deviceAuth" // deviceId -> { authorizedAt, revokedAt }
  | "outbox" // pending encrypted packages awaiting upload
  | "receipts" // applied package ids, for idempotent delivery
  | "tombstones" // entityId -> purge record, blocks resurrection
  | "conflicts" // entityId -> unresolved conflict record
  | "archives"; // pre-pairing notebook copies, kept out of the pairing rewrite

let DB_NAME = "papyrus-sync";
const DB_VERSION = 2;

// Test-only: point the layer at a different database (used to simulate multiple
// independent devices in one process). Resets the cached connection.
export function setActiveDatabase(name: string): void {
  if (dbPromise) {
    void dbPromise.then((db) => db.close());
    dbPromise = null;
  }
  DB_NAME = name;
}

const STORE_KEYS: Record<StoreName, string> = {
  meta: "key",
  notes: "id",
  categories: "id",
  noteRevisions: "revisionId",
  categoryRevisions: "revisionId",
  entityHeads: "entityId",
  devices: "id",
  deviceAuth: "deviceId",
  outbox: "id",
  receipts: "packageId",
  tombstones: "entityId",
  conflicts: "entityId",
  archives: "id",
};

let dbPromise: Promise<IDBDatabase> | null = null;

function openDatabase(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      for (const [name, keyPath] of Object.entries(STORE_KEYS)) {
        if (!db.objectStoreNames.contains(name)) {
          db.createObjectStore(name, { keyPath });
        }
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return dbPromise;
}

function promisify<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function idbGet<T>(store: StoreName, key: IDBValidKey): Promise<T | undefined> {
  const db = await openDatabase();
  const tx = db.transaction(store, "readonly");
  return promisify<T>(tx.objectStore(store).get(key) as IDBRequest<T>);
}

export async function idbGetAll<T>(store: StoreName): Promise<T[]> {
  const db = await openDatabase();
  const tx = db.transaction(store, "readonly");
  return promisify<T[]>(tx.objectStore(store).getAll() as IDBRequest<T[]>);
}

export async function idbPut<T>(store: StoreName, value: T): Promise<void> {
  const db = await openDatabase();
  const tx = db.transaction(store, "readwrite");
  tx.objectStore(store).put(value);
  await transactionDone(tx);
}

export async function idbDelete(store: StoreName, key: IDBValidKey): Promise<void> {
  const db = await openDatabase();
  const tx = db.transaction(store, "readwrite");
  tx.objectStore(store).delete(key);
  await transactionDone(tx);
}

export async function idbClear(store: StoreName): Promise<void> {
  const db = await openDatabase();
  const tx = db.transaction(store, "readwrite");
  tx.objectStore(store).clear();
  await transactionDone(tx);
}

// Run a set of writes across one or more stores atomically. The callback issues
// requests synchronously against the provided transaction; the promise resolves
// when the transaction commits.
export async function idbWrite(
  stores: StoreName[],
  work: (tx: IDBTransaction) => void,
): Promise<void> {
  const db = await openDatabase();
  const tx = db.transaction(stores, "readwrite");
  work(tx);
  await transactionDone(tx);
}

function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

// Test/reset helper — drops the whole database.
export async function idbDestroy(): Promise<void> {
  if (dbPromise) {
    (await dbPromise).close();
    dbPromise = null;
  }
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DB_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () => resolve();
  });
}
