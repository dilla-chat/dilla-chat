/**
 * messageCache.ts — Local plaintext message cache in IndexedDB
 *
 * Caches decrypted message content locally so that messages don't need
 * to be re-decrypted from the server. This solves the forward-ratchet
 * problem where Sender Key chain advances make old ciphertext undecryptable.
 */

const DB_NAME = 'dilla-messages';
const DB_VERSION = 1;
const STORE_NAME = 'messages';

interface CachedMessage {
  id: string;
  channelId: string;
  plaintext: string;
  cachedAt: number;
}

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' });
        store.createIndex('channelId', 'channelId', { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function cacheMessage(
  id: string,
  channelId: string,
  plaintext: string,
): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const entry: CachedMessage = { id, channelId, plaintext, cachedAt: Date.now() };
    store.put(entry);
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
  });
}

export async function getCachedMessage(id: string): Promise<string | null> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const req = store.get(id);
    req.onsuccess = () => {
      const result = req.result as CachedMessage | undefined;
      resolve(result?.plaintext ?? null);
    };
    req.onerror = () => reject(req.error);
    tx.oncomplete = () => db.close();
  });
}

export async function getCachedMessages(ids: string[]): Promise<Map<string, string>> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const results = new Map<string, string>();
    let remaining = ids.length;
    if (remaining === 0) {
      db.close();
      resolve(results);
      return;
    }
    for (const id of ids) {
      const req = store.get(id);
      req.onsuccess = () => {
        const result = req.result as CachedMessage | undefined;
        if (result) results.set(id, result.plaintext);
        remaining--;
        if (remaining === 0) resolve(results);
      };
      req.onerror = () => {
        remaining--;
        if (remaining === 0) resolve(results);
      };
    }
    tx.oncomplete = () => db.close();
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
  });
}

export async function deleteCachedMessage(id: string): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    store.delete(id);
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
  });
}

export async function clearChannelCache(channelId: string): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const index = store.index('channelId');
    const req = index.openCursor(IDBKeyRange.only(channelId));
    req.onsuccess = () => {
      const cursor = req.result;
      if (cursor) {
        cursor.delete();
        cursor.continue();
      }
    };
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    /* v8 ignore next 4 */
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
  });
}

export async function clearAllMessageCache(): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    store.clear();
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    /* v8 ignore next 4 */
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
  });
}
