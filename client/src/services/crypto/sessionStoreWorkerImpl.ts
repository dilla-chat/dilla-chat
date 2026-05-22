// H-12: worker-scope implementation of the encrypted IndexedDB
// session store.
//
// This file is imported BY `worker.ts` (which runs in the Worker
// scope). The main thread should never import it directly — it has
// to go through `workerClient.ts` instead so the derivedKey + IDB
// handle stay isolated from a main-thread XSS.
//
// Schema mirrors `sessionStore.ts` exactly:
//   DB     = "dilla-sessions" (v1)
//   store  = "group-sessions" keyed by channelId
//   value  = { channelId, ciphertext (base64 of iv || AES-GCM), updatedAt }
//
// The KEK is HKDF-derived from a string `derivedKey` the main thread
// sends ONCE via the `session.init` op. The worker caches it in a
// non-extractable CryptoKey; the raw string is overwritten in place
// after use. Subsequent ops can run without main-thread participation.

const DB_NAME = 'dilla-sessions';
const DB_VERSION = 1;
const STORE_NAME = 'group-sessions';

let cachedKey: CryptoKey | null = null;

async function deriveSessionKey(derivedKey: string): Promise<CryptoKey> {
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    encoder.encode(derivedKey),
    'HKDF',
    false,
    ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: encoder.encode('dilla-session-store-v1'),
      info: encoder.encode('session-encryption'),
    },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/** Called once with the user's derivedKey. Idempotent — re-init with
 *  the same key is a no-op; with a different key the cache is
 *  replaced (account switch / re-login scenario).
 *
 *  H-12c.1: also seeds the pairwise-session store's KEK so the same
 *  init op covers both stores. The pairwise store is in a separate
 *  IDB object store but shares the KEK via HKDF on the same
 *  derivedKey input.
 */
export async function initSessionKey(derivedKey: string): Promise<void> {
  cachedKey = await deriveSessionKey(derivedKey);
  // Lazy import avoids the circular-dep complaint when both modules
  // are imported by worker.ts. The pairwise store module also
  // imports a marker symbol from this one for the same reason.
  const { setPairwiseSessionKey } = await import('./pairwiseSessionStoreWorkerImpl');
  setPairwiseSessionKey(cachedKey);
}

export function resetSessionKey(): void {
  cachedKey = null;
  // Best-effort: also clear the pairwise store's cached key. Lazy
  // import for the same circular-dep reason as above.
  import('./pairwiseSessionStoreWorkerImpl').then((m) => m.resetPairwiseSessionKey()).catch(() => {});
}

async function encryptSession(json: string, key: CryptoKey): Promise<string> {
  const encoder = new TextEncoder();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    encoder.encode(json),
  );
  const combined = new Uint8Array(12 + encrypted.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(encrypted), 12);
  return btoa(String.fromCharCode(...combined));
}

async function decryptSession(ciphertext: string, key: CryptoKey): Promise<string> {
  const decoder = new TextDecoder();
  const data = Uint8Array.from(atob(ciphertext), (c) => c.charCodeAt(0));
  if (data.length < 12) throw new Error('Session ciphertext too short');
  const iv = data.slice(0, 12);
  const encrypted = data.slice(12);
  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv },
    key,
    encrypted,
  );
  return decoder.decode(decrypted);
}

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'channelId' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(new Error(request.error?.message ?? 'Failed to open session DB'));
  });
}

interface StoredSession {
  channelId: string;
  ciphertext: string;
  updatedAt: number;
}

export async function saveSession(
  channelId: string,
  sessionJson: object,
): Promise<void> {
  if (!cachedKey) {
    // No KEK yet — saving is a no-op rather than an error so the
    // first-message-before-init race doesn't blow up. Main thread
    // sends session.init very early so this should not fire in
    // practice.
    return;
  }
  const ciphertext = await encryptSession(JSON.stringify(sessionJson), cachedKey);
  const db = await openDB();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const entry: StoredSession = { channelId, ciphertext, updatedAt: Date.now() };
    store.put(entry);
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => {
      db.close();
      reject(new Error(tx.error?.message ?? 'Failed to save session'));
    };
  });
}

export async function loadSession(
  channelId: string,
): Promise<Record<string, unknown> | null> {
  if (!cachedKey) return null;
  const key = cachedKey;
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const req = store.get(channelId);
    req.onsuccess = async () => {
      const result = req.result as StoredSession | undefined;
      if (!result?.ciphertext) {
        resolve(null);
        return;
      }
      try {
        const json = await decryptSession(result.ciphertext, key);
        resolve(JSON.parse(json));
      } catch {
        resolve(null);
      }
    };
    req.onerror = () =>
      reject(new Error(req.error?.message ?? 'Failed to load session'));
    tx.oncomplete = () => db.close();
  });
}

export async function loadAllSessions(): Promise<
  Array<[string, Record<string, unknown>]>
> {
  if (!cachedKey) return [];
  const key = cachedKey;
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const req = store.getAll();
    req.onsuccess = async () => {
      const out: Array<[string, Record<string, unknown>]> = [];
      for (const entry of req.result as StoredSession[]) {
        try {
          const json = await decryptSession(entry.ciphertext, key);
          out.push([entry.channelId, JSON.parse(json)]);
        } catch {
          // Skip corrupt/unreadable sessions.
        }
      }
      resolve(out);
    };
    req.onerror = () => {
      db.close();
      reject(new Error(req.error?.message ?? 'Failed to load sessions'));
    };
    tx.oncomplete = () => db.close();
  });
}

export async function deleteSession(channelId: string): Promise<void> {
  const db = await openDB();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    store.delete(channelId);
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => {
      db.close();
      reject(new Error(tx.error?.message ?? 'Failed to delete session'));
    };
  });
}
