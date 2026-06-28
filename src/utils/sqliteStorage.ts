import initSqlJs, { type Database, type SqlJsStatic } from "sql.js";
import wasmUrl from "sql.js/dist/sql-wasm.wasm?url";

const SQLITE_PERSISTENCE_DB_NAME = "stimulator-sqlite";
const SQLITE_PERSISTENCE_STORE_NAME = "sqlite-files";
const SQLITE_PERSISTENCE_KEY = "appSqliteDbBinary";
const LEGACY_SQLITE_DB_STORAGE_KEY = "appSqliteDbBase64";

let sqlJsPromise: Promise<SqlJsStatic> | null = null;
let dbPromise: Promise<Database> | null = null;
let persistChain: Promise<void> = Promise.resolve();
let persistenceDbPromise: Promise<IDBDatabase> | null = null;

type SqliteMetrics = {
  reads: number;
  writes: number;
  removes: number;
  listReads: number;
  migrationsAttempted: number;
  migrationsApplied: number;
  lastOperationAt: string | null;
};

const sqliteMetrics: SqliteMetrics = {
  reads: 0,
  writes: 0,
  removes: 0,
  listReads: 0,
  migrationsAttempted: 0,
  migrationsApplied: 0,
  lastOperationAt: null,
};

const markOperation = (key: keyof Omit<SqliteMetrics, "lastOperationAt">) => {
  sqliteMetrics[key] += 1;
  sqliteMetrics.lastOperationAt = new Date().toISOString();
};

const openPersistenceDatabase = async (): Promise<IDBDatabase> => {
  if (!persistenceDbPromise) {
    persistenceDbPromise = new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(SQLITE_PERSISTENCE_DB_NAME, 1);

      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(SQLITE_PERSISTENCE_STORE_NAME)) {
          db.createObjectStore(SQLITE_PERSISTENCE_STORE_NAME);
        }
      };

      request.onsuccess = () => {
        resolve(request.result);
      };

      request.onerror = () => {
        reject(request.error ?? new Error("Failed to open IndexedDB for SQLite persistence"));
      };
    });
  }

  return persistenceDbPromise;
};

const readPersistedBytes = async (): Promise<Uint8Array | null> => {
  const db = await openPersistenceDatabase();

  return new Promise<Uint8Array | null>((resolve, reject) => {
    const transaction = db.transaction(SQLITE_PERSISTENCE_STORE_NAME, "readonly");
    const store = transaction.objectStore(SQLITE_PERSISTENCE_STORE_NAME);
    const request = store.get(SQLITE_PERSISTENCE_KEY);

    request.onsuccess = () => {
      const result = request.result;
      if (!(result instanceof ArrayBuffer)) {
        resolve(null);
        return;
      }

      resolve(new Uint8Array(result));
    };

    request.onerror = () => {
      reject(request.error ?? new Error("Failed to read persisted SQLite database"));
    };
  });
};

const writePersistedBytes = async (bytes: Uint8Array): Promise<void> => {
  const db = await openPersistenceDatabase();

  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(SQLITE_PERSISTENCE_STORE_NAME, "readwrite");
    const store = transaction.objectStore(SQLITE_PERSISTENCE_STORE_NAME);
    const request = store.put(bytes.buffer.slice(0), SQLITE_PERSISTENCE_KEY);

    request.onerror = () => {
      reject(request.error ?? new Error("Failed to persist SQLite database"));
    };

    transaction.oncomplete = () => {
      resolve();
    };

    transaction.onerror = () => {
      reject(transaction.error ?? new Error("Failed to complete SQLite persistence transaction"));
    };
  });
};

const getSqlJs = async (): Promise<SqlJsStatic> => {
  if (!sqlJsPromise) {
    sqlJsPromise = initSqlJs({
      locateFile: () => wasmUrl,
    });
  }

  return sqlJsPromise;
};

const initializeSchema = (db: Database) => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS kv_store (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
};

const getDatabase = async (): Promise<Database> => {
  if (!dbPromise) {
    dbPromise = (async () => {
      const SQL = await getSqlJs();
      const persistedBytes = await readPersistedBytes();
      const db = persistedBytes ? new SQL.Database(persistedBytes) : new SQL.Database();
      initializeSchema(db);

      const legacyEncoded = localStorage.getItem(LEGACY_SQLITE_DB_STORAGE_KEY);
      if (legacyEncoded) {
        localStorage.removeItem(LEGACY_SQLITE_DB_STORAGE_KEY);
      }

      return db;
    })();
  }

  return dbPromise;
};

const persistDatabase = async () => {
  const db = await getDatabase();
  const bytes = db.export();
  await writePersistedBytes(bytes);
};

const queuePersist = async () => {
  persistChain = persistChain.then(() => persistDatabase());
  await persistChain;
};

export const getSqliteItem = async (key: string): Promise<string | null> => {
  markOperation("reads");
  const db = await getDatabase();
  const result = db.exec("SELECT value FROM kv_store WHERE key = ?", [key]);

  if (!result[0] || result[0].values.length === 0) {
    return null;
  }

  const firstValue = result[0].values[0]?.[0];
  return typeof firstValue === "string" ? firstValue : null;
};

export const setSqliteItem = async (key: string, value: string): Promise<void> => {
  markOperation("writes");
  const db = await getDatabase();
  db.run(
    `
      INSERT INTO kv_store (key, value, updated_at)
      VALUES (?, ?, datetime('now'))
      ON CONFLICT(key)
      DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at;
    `,
    [key, value]
  );
  await queuePersist();
};

export const removeSqliteItem = async (key: string): Promise<void> => {
  markOperation("removes");
  const db = await getDatabase();
  db.run("DELETE FROM kv_store WHERE key = ?", [key]);
  await queuePersist();
};

export const getAllSqliteEntries = async (): Promise<Record<string, string>> => {
  markOperation("listReads");
  const db = await getDatabase();
  const result = db.exec("SELECT key, value FROM kv_store");
  const output: Record<string, string> = {};

  if (!result[0]) {
    return output;
  }

  result[0].values.forEach((row: unknown[]) => {
    const key = row[0];
    const value = row[1];

    if (typeof key === "string" && typeof value === "string") {
      output[key] = value;
    }
  });

  return output;
};

export const clearSqliteStore = async (): Promise<void> => {
  const db = await getDatabase();
  db.run("DELETE FROM kv_store");
  await queuePersist();
};

export const migrateLocalStorageKeysToSqlite = async (keys: string[]): Promise<void> => {
  for (const key of keys) {
    markOperation("migrationsAttempted");
    const sqliteValue = await getSqliteItem(key);
    if (sqliteValue !== null) {
      continue;
    }

    const localValue = localStorage.getItem(key);
    if (localValue === null) {
      continue;
    }

    await setSqliteItem(key, localValue);
    markOperation("migrationsApplied");
  }
};

export const migrateAllLocalStorageToSqlite = async (): Promise<void> => {
  const keys: string[] = [];

  for (let index = 0; index < localStorage.length; index += 1) {
    const key = localStorage.key(index);
    if (key) {
      keys.push(key);
    }
  }

  await migrateLocalStorageKeysToSqlite(keys);
};

export const getSqliteMetrics = (): SqliteMetrics => ({ ...sqliteMetrics });
