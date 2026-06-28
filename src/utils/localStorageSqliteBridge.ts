import {
  clearSqliteStore,
  getAllSqliteEntries,
  migrateAllLocalStorageToSqlite,
  removeSqliteItem,
  setSqliteItem,
} from "./sqliteStorage";

let bridgeInstalled = false;
const LEGACY_SQLITE_DB_STORAGE_KEY = "appSqliteDbBase64";

export const installLocalStorageSqliteBridge = () => {
  if (bridgeInstalled || typeof window === "undefined") {
    return;
  }

  bridgeInstalled = true;

  const storagePrototype = Storage.prototype;
  const originalSetItem = storagePrototype.setItem;
  const originalRemoveItem = storagePrototype.removeItem;
  const originalClear = storagePrototype.clear;

  storagePrototype.setItem = function patchedSetItem(key: string, value: string) {
    originalSetItem.call(this, key, value);

    if (this === window.localStorage && key !== LEGACY_SQLITE_DB_STORAGE_KEY) {
      void setSqliteItem(key, value);
    }
  };

  storagePrototype.removeItem = function patchedRemoveItem(key: string) {
    originalRemoveItem.call(this, key);

    if (this === window.localStorage) {
      void removeSqliteItem(key);
    }
  };

  storagePrototype.clear = function patchedClear() {
    originalClear.call(this);

    if (this === window.localStorage) {
      void clearSqliteStore();
    }
  };

  const hydrateAndMigrate = async () => {
    const sqliteEntries = await getAllSqliteEntries();

    Object.entries(sqliteEntries).forEach(([key, value]) => {
      if (key === LEGACY_SQLITE_DB_STORAGE_KEY) {
        return;
      }
      if (window.localStorage.getItem(key) === null) {
        originalSetItem.call(window.localStorage, key, value);
      }
    });

    await migrateAllLocalStorageToSqlite();
  };

  void hydrateAndMigrate();
};
