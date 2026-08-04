// Hand-rolled promisified IndexedDB wrapper — design: docs/design/plan-library.md §2.
// DB "dsource" v2, three object stores: "plans" (keyPath "id"), "history"
// (keyPath "at"), and "projects" (keyPath "id", first-class project records —
// docs/design/workflow.md §2). No dependencies; ~70 lines beats pulling in
// idb-keyval for three stores (see the design's storage rationale).
//
// The v1→v2 upgrade is ADDITIVE + forward-only: `onupgradeneeded` creates only
// the missing stores, so existing `plans`/`history` records are untouched (an
// older build hitting a v2 DB gets a VersionError — accepted for a local app,
// workflow.md §7.5).
//
// Testability: when `indexedDB` is absent (Node unit tests), the four exported
// functions fall back to in-memory Maps that mirror the object stores —
// including getAll's ascending-key ordering — so `plans.ts`/`history.ts`
// logic runs unmodified in Node. This was chosen over dependency injection
// as the least invasive option: callers stay plain function calls.

type StoreName = 'plans' | 'history' | 'projects' | 'plateLog'

const DB_NAME = 'dsource'
// v3 adds "plateLog" (keyPath "at"): the plate-provenance calibration log. Same
// additive, forward-only upgrade rule as v2 — existing records are untouched.
const DB_VERSION = 3
const KEY_PATHS: Record<StoreName, string> = {
  plans: 'id', history: 'at', projects: 'id', plateLog: 'at',
}

/** In-memory fallback stores, active only where IndexedDB does not exist. */
const memory: Record<StoreName, Map<IDBValidKey, unknown>> | null =
  typeof indexedDB === 'undefined'
    ? { plans: new Map(), history: new Map(), projects: new Map(), plateLog: new Map() }
    : null

let dbPromise: Promise<IDBDatabase> | null = null

function openDB(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION)
      req.onupgradeneeded = () => {
        for (const [store, keyPath] of Object.entries(KEY_PATHS)) {
          if (!req.result.objectStoreNames.contains(store)) {
            req.result.createObjectStore(store, { keyPath })
          }
        }
      }
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error ?? new Error('IndexedDB open failed'))
    })
  }
  return dbPromise
}

/** Run one request in its own transaction on `store`, promisified. */
async function tx<T>(
  store: StoreName,
  mode: IDBTransactionMode,
  run: (s: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await openDB()
  return new Promise<T>((resolve, reject) => {
    const req = run(db.transaction(store, mode).objectStore(store))
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error(`IndexedDB ${mode} on "${store}" failed`))
  })
}

export function dbGet<T>(store: StoreName, key: IDBValidKey): Promise<T | undefined> {
  if (memory) return Promise.resolve(memory[store].get(key) as T | undefined)
  return tx<T | undefined>(store, 'readonly', (s) => s.get(key))
}

export function dbPut<T>(store: StoreName, value: T): Promise<void> {
  if (memory) {
    memory[store].set((value as Record<string, IDBValidKey>)[KEY_PATHS[store]], value)
    return Promise.resolve()
  }
  return tx(store, 'readwrite', (s) => s.put(value)).then(() => undefined)
}

export function dbDel(store: StoreName, key: IDBValidKey): Promise<void> {
  if (memory) {
    memory[store].delete(key)
    return Promise.resolve()
  }
  return tx(store, 'readwrite', (s) => s.delete(key)).then(() => undefined)
}

export function dbGetAll<T>(store: StoreName): Promise<T[]> {
  if (memory) {
    // Match IndexedDB getAll(): records come back in ascending key order.
    const sorted = [...memory[store].entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return Promise.resolve(sorted.map(([, v]) => v as T))
  }
  return tx<T[]>(store, 'readonly', (s) => s.getAll())
}
